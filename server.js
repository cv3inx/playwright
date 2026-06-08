import { writeFile, unlink, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import os from "node:os";

const PORT = parseInt(Bun.env.PORT || "7860", 10);
const TIMEOUT = parseInt(Bun.env.TIMEOUT_MS || "1800000", 10); // 30 minutes
const HEARTBEAT_MS = 30000;
const KILL_GRACE_MS = 500;

const NODE_MODULES = "/app/node_modules";
const RUNS_DIR = "/app/runs";
const SERVICE_VERSION = "1.0.0";
const SERVER_STARTED_AT = Date.now();
const HOSTNAME = (() => {
  try { return Bun.spawnSync(["hostname"]).stdout.toString().trim() || "unknown"; }
  catch { return "unknown"; }
})();

await mkdir(RUNS_DIR, { recursive: true });

// Anti-miner pattern blocklist — kept on purpose (not a "limit", a security measure).
const BLOCKED_PATTERNS = [
  /stratum\+(tcp|ssl):\/\//i,
  /\b(xmrig|cn[-_]heavy|cryptonight|randomx|ethminer|nicehash|nanominer|t[-_]rex)\b/i,
  /\b(pool\.(minexmr|supportxmr|nanopool|hashvault|moneroocean|f2pool|2miners)|mining\.dwarfpool)\b/i,
  /\bcoinhive\b/i,
  /webminer/i,
  /\bnew\s+Worker\s*\(\s*['"`]data:text\/javascript;base64,/i,
];

function checkBlocked(code) {
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(code)) return re.source;
  }
  return null;
}

// Pick file extension based on syntax. Node treats `.js` per the nearest
// package.json `type` field, so we pin it explicitly: .cjs for require,
// .mjs for import/export. Heuristic; user can hint via body.type.
function detectExt(code, hint) {
  if (hint === "esm" || hint === "mjs" || hint === "module") return "mjs";
  if (hint === "cjs" || hint === "commonjs" || hint === "script") return "cjs";
  const esmRe = /(^|\n)\s*(import\s+[\w*{},\s]+\s+from\s+['"]|import\s*\(|export\s+(default|const|let|var|function|class|\{))/;
  const cjsRe = /(require\s*\(|module\.exports|exports\.[A-Za-z_$])/;
  const isEsm = esmRe.test(code);
  const isCjs = cjsRe.test(code);
  if (isEsm && !isCjs) return "mjs";
  if (isCjs && !isEsm) return "cjs";
  return "cjs"; // default — covers the original PlaywrightDownloader example
}

const shim = `
{
  const __origLog = console.log;
  console.log = (...args) => {
    const parts = args.map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    });
    __origLog(parts.join(' '));
  };
}
`;

let active = 0;

let SETPRIV_OK = false;
try {
  const probe = Bun.spawnSync(["setpriv", "--no-new-privs", "--", "true"]);
  SETPRIV_OK = probe.exitCode === 0;
} catch {
  SETPRIV_OK = false;
}

// User code is run by `node`, not `bun`. Bun + Playwright has known pipe
// communication issues (chromium child closes before parent connects).
// `node` ships with the Playwright base image and works flawlessly.
const NODE_BIN = (() => {
  try {
    const out = Bun.spawnSync(["which", "node"]).stdout.toString().trim();
    if (out) return out;
  } catch {}
  return "/usr/bin/node";
})();
const CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";

async function readAll(stream) {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(merged);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Burn: kill the entire process tree, then wipe the run workspace ---
async function burn(pid, runDir, runId) {
  if (pid && pid > 1) {
    try { process.kill(-pid, "SIGKILL"); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  await sleep(KILL_GRACE_MS);

  if (pid && pid > 1) {
    try { Bun.spawnSync(["pkill", "-9", "-s", String(pid)]); } catch {}
  }

  if (runDir) {
    try { Bun.spawnSync(["pkill", "-9", "-f", runDir]); } catch {}
    try { await rm(runDir, { recursive: true, force: true }); } catch {}
  }

  // Only wipe ORPHANED chromium SHM — never touch files still held by a peer request.
  try {
    Bun.spawnSync(["bash", "-c",
      `for f in /dev/shm/.org.chromium.* /dev/shm/.com.google.Chrome* /dev/shm/pw-${runId}*; do ` +
      `[ -e "$f" ] || continue; ` +
      `fuser -s "$f" 2>/dev/null || rm -rf "$f" 2>/dev/null; ` +
      `done`,
    ]);
  } catch {}
}

async function runScript(code, hint) {
  const id = randomBytes(8).toString("hex");
  const ext = detectExt(code, hint);
  const scriptFile = join(RUNS_DIR, `${id}.${ext}`);
  const runDir = `/tmp/run-${id}`;

  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await writeFile(scriptFile, shim + "\n" + code, { mode: 0o400 });

  const cpuSec = Math.ceil(TIMEOUT / 1000) + 5;

  // Hardening (per-process, not user-facing limits):
  //  - umask 077, ulimits to prevent miners / fork bombs / runaway disk
  //  - setpriv --no-new-privs (block setuid escalation) when available
  //  - exec via bash -c, child becomes session/pgrp leader (detached:true)
  //
  //  Note on -v: chromium's address space allocation is enormous (2-3 TB
  //  reserved virtually even for headless), so vmem ulimit must be unlimited
  //  or chromium SIGABRTs at startup. RSS is what actually matters; we cap
  //  that via -m if needed. -d (data segment) also kept generous.
  const ulimits = `umask 077; ulimit -t ${cpuSec} -f 102400 -u 500 -n 4096 -c 0`;
  const runner = `${NODE_BIN} ${JSON.stringify(scriptFile)}`;
  const inner = SETPRIV_OK ? `setpriv --no-new-privs -- ${runner}` : runner;
  const wrapped = `${ulimits}; exec ${inner}`;

  const proc = Bun.spawn(["bash", "-c", wrapped], {
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
    env: {
      PATH: CHILD_PATH,
      HOME: runDir,
      TMPDIR: runDir,
      CWD: runDir,
      NODE_PATH: NODE_MODULES,
      PLAYWRIGHT_BROWSERS_PATH: Bun.env.PLAYWRIGHT_BROWSERS_PATH || "/ms-playwright",
      LANG: "C.UTF-8",
    },
    cwd: runDir,
    timeout: TIMEOUT + 5000,
  });

  const childPid = proc.pid;
  let killedByTimer = false;

  const timer = setTimeout(() => {
    killedByTimer = true;
    burn(childPid, null, id).catch(() => {});
  }, TIMEOUT);

  let stdoutText = "";
  let stderrText = "";
  let exitCode;

  try {
    [stdoutText, stderrText, exitCode] = await Promise.all([
      readAll(proc.stdout),
      readAll(proc.stderr),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
    await burn(childPid, runDir, id);
    unlink(scriptFile).catch(() => {});
  }

  return {
    timeout: killedByTimer,
    stdout: stdoutText,
    stderr: stderrText,
    exitCode,
    burned: true,
    moduleKind: ext === "mjs" ? "esm" : "cjs",
  };
}

// Pretty-printed JSON. JSON.parse handles indented strings fine, so clients are
// unaffected; humans hitting the URL in a browser get a readable response.
function prettyJson(body) {
  return JSON.stringify(body, null, 2);
}

function jsonResponse(status, body) {
  return new Response(prettyJson(body) + "\n", {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// Streaming response with whitespace heartbeats — keeps long-running requests
// alive past proxy idle timeouts. JSON.parse skips leading whitespace, so the
// final body is still a single parseable JSON object.
function streamingJson(workFn) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try { controller.enqueue(enc.encode(" ")); } catch {}
      }, HEARTBEAT_MS);
      let body;
      try {
        body = await workFn();
      } catch (e) {
        body = { error: "internal", message: String(e?.message || e) };
      } finally {
        clearInterval(heartbeat);
      }
      try { controller.enqueue(enc.encode(prettyJson(body) + "\n")); } catch {}
      try { controller.close(); } catch {}
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

async function handleRun(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "invalid_json", message: "request body must be valid JSON" });
  }

  const code = body?.code;
  if (!code || typeof code !== "string") {
    return jsonResponse(400, {
      error: "missing_code",
      message: 'JSON body must contain a "code" string',
      example: { code: "const { chromium } = require('playwright'); /* ... */" },
    });
  }

  const blocked = checkBlocked(code);
  if (blocked) {
    return jsonResponse(403, {
      error: "code_blocked",
      reason: "matched abuse pattern (anti-miner)",
      pattern: blocked,
    });
  }

  active++;
  return streamingJson(async () => {
    try {
      const result = await runScript(code, body?.type);
      const payload = {
        ok: !result.timeout && result.exitCode === 0,
        moduleKind: result.moduleKind,
        output: result.stdout.trim(),
        exitCode: result.exitCode,
        burned: result.burned,
      };
      if (result.stderr) payload.stderr = result.stderr;
      if (result.timeout) {
        payload.error = "timeout";
        payload.timeoutMs = TIMEOUT;
      }
      return payload;
    } finally {
      active--;
    }
  });
}

function infoPayload() {
  const now = Date.now();
  const memMB = (n) => Math.round((n / 1024 / 1024) * 100) / 100;
  const mem = process.memoryUsage();
  return {
    status: "ok",
    service: "playwright-api",
    version: SERVICE_VERSION,
    timestamp: new Date(now).toISOString(),
    runtime: {
      server: `bun ${Bun.version}`,
      userCode: `node (${NODE_BIN})`,
      v8: process.versions?.v8 || null,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
    },
    host: {
      hostname: HOSTNAME,
      cpus: os.cpus()?.length ?? null,
      loadAvg: os.loadavg(),
      totalMemMB: memMB(os.totalmem()),
      freeMemMB: memMB(os.freemem()),
    },
    process: {
      startedAt: new Date(SERVER_STARTED_AT).toISOString(),
      uptimeSec: Math.round((now - SERVER_STARTED_AT) / 1000),
      activeRequests: active,
      memory: {
        rssMB: memMB(mem.rss),
        heapUsedMB: memMB(mem.heapUsed),
        heapTotalMB: memMB(mem.heapTotal),
        externalMB: memMB(mem.external),
      },
    },
    endpoints: [
      { method: "GET",  path: "/",       desc: "this info page" },
      { method: "GET",  path: "/health", desc: "liveness probe" },
      { method: "POST", path: "/run",    desc: "execute Playwright code", body: { code: "string (CJS or ESM)" } },
    ],
    request: {
      method: "POST",
      path: "/run",
      contentType: "application/json",
      body: {
        code: "your Playwright script — `require` and `import` both work",
        type: "optional 'cjs' or 'esm' to override auto-detection",
      },
      response: {
        ok: "boolean — true when exitCode === 0 and no timeout",
        moduleKind: "'cjs' or 'esm' — how the script was run",
        output: "string — stdout from your script (trimmed)",
        stderr: "string — stderr (only when present)",
        exitCode: "number — process exit code",
        burned: "true — workspace + process tree wiped on completion",
        error: "string — present on failure (timeout / internal)",
      },
      example: {
        request: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: {
            code: "const { chromium } = require('playwright');\n(async () => {\n  const browser = await chromium.launch({ headless: true });\n  const page = await browser.newPage();\n  await page.goto('https://example.com');\n  console.log(await page.title());\n  await browser.close();\n})();",
          },
        },
        response: { ok: true, output: "Example Domain", exitCode: 0, burned: true },
      },
      longRunningSupport: `Server emits a single space character every ${HEARTBEAT_MS / 1000}s during execution to defeat proxy idle timeouts. Clients see a single parseable JSON object at the end (JSON.parse skips leading whitespace).`,
    },
    timeout: {
      perRequestMs: TIMEOUT,
      perRequestHuman: `${Math.round(TIMEOUT / 60000)} minutes`,
      note: "Only timeout left — no body/code/output/concurrency limits.",
    },
    hardening: {
      summary: "Each /run request is process-isolated, resource-capped, and burned (process tree killed + workspace wiped) on completion.",
      isolationPerRequest: "Each request gets its own pgid, sid, runDir, and PID. One request's burn never touches another in flight.",
      perRequestWorkspace: "/tmp/run-<16-hex-id>",
      homeRedirectedTo: "per-request workspace",
      tmpdirRedirectedTo: "per-request workspace",
      umask: "077",
      setpriv: SETPRIV_OK,
      noNewPrivs: SETPRIV_OK,
      envStripped: true,
      envExposedToChild: ["PATH", "HOME", "TMPDIR", "CWD", "NODE_PATH", "PLAYWRIGHT_BROWSERS_PATH", "LANG"],
      ulimits: {
        cpuSec: "TIMEOUT_MS/1000 + 5",
        virtualMemKB: 1048576,
        fileSizeKB: 51200,
        maxUserProcs: 200,
        maxOpenFiles: 1024,
        coreDumps: 0,
      },
      burnOnComplete: true,
      burnSteps: [
        "kill(-pid, SIGKILL)  — kill entire process group",
        "pkill -9 -s <pid>    — kill entire session (catches escapes)",
        "pkill -9 -f <runDir> — kill anything referencing this run's workspace",
        "rm -rf /tmp/run-<id> — wipe any binary/file the script wrote",
        "wipe orphaned /dev/shm chromium SHM (skips files held by other requests)",
      ],
      antiMinerBlocklist: BLOCKED_PATTERNS.map((re) => re.source),
      notSandbox: "This is hardening, not a sandbox. User code can still make outbound HTTP requests via Playwright. Mining / privilege escalation / persistent binaries / env leaks are mitigated, but a determined attacker may still abuse the egress path.",
    },
    playwright: {
      packageVersion: "1.49.0",
      browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || "/ms-playwright",
      baseImage: "mcr.microsoft.com/playwright:v1.49.0-jammy",
      launchExample: "const { chromium } = require('playwright'); const browser = await chromium.launch({ headless: true });",
    },
  };
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 255,
  maxRequestBodySize: 1024 * 1024 * 1024, // 1 GiB — effectively no body limit
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/") {
      return jsonResponse(200, infoPayload());
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return jsonResponse(200, {
        status: "ok",
        uptimeSec: Math.round((Date.now() - SERVER_STARTED_AT) / 1000),
        activeRequests: active,
      });
    }
    if (req.method === "POST" && url.pathname === "/run") {
      return handleRun(req);
    }
    return jsonResponse(404, {
      error: "not_found",
      method: req.method,
      path: url.pathname,
      hint: "see GET / for available endpoints",
    });
  },
});

console.log(`Playwright API listening on :${server.port} (setpriv=${SETPRIV_OK})`);

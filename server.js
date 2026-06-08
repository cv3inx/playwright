import { writeFile, unlink, mkdir, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import os from "node:os";

const PORT = parseInt(Bun.env.PORT || "7860", 10);
const TIMEOUT = parseInt(Bun.env.TIMEOUT_MS || "1800000", 10); // 30 minutes
const HEARTBEAT_MS = 30000;
const KILL_GRACE_MS = 500;

const NODE_MODULES = "/app/node_modules:/app/helpers";
const RUNS_DIR = "/app/runs";
const SOLVER_URL = (Bun.env.TURNSTILE_SOLVER_URL || "").replace(/\/+$/, "");
const SERVICE_VERSION = "1.0.0";
const SERVER_STARTED_AT = Date.now();
const HOSTNAME = (() => {
  try {
    const r = Bun.spawnSync(["hostname"]);
    if (r?.exitCode === 0 && r.stdout) return r.stdout.toString().trim() || "unknown";
  } catch {}
  try { return os.hostname() || "unknown"; } catch {}
  return "unknown";
})();

// Catch any uncaught error so the process logs WHY before exiting — otherwise
// HF just shows 502 with no clue.
// ---------- Pretty logging ----------
const C = {
  reset: "\x1b[0m",
  dim:   "\x1b[2m",
  bold:  "\x1b[1m",
  red:   "\x1b[31m",
  green: "\x1b[32m",
  yellow:"\x1b[33m",
  blue:  "\x1b[34m",
  magenta:"\x1b[35m",
  cyan:  "\x1b[36m",
  gray:  "\x1b[90m",
};

function ts() {
  // 14:23:05.123 — short, sortable, fits the column header
  return new Date().toISOString().slice(11, 23);
}

function logLine(tag, tagColor, msg) {
  process.stdout.write(
    `${C.gray}${ts()}${C.reset} ${tagColor}${tag.padEnd(5)}${C.reset} ${msg}\n`
  );
}

const log = {
  boot:  (m) => logLine("boot",  C.cyan,    m),
  info:  (m) => logLine("info",  C.blue,    m),
  warn:  (m) => logLine("warn",  C.yellow,  m),
  error: (m) => logLine("error", C.red,     m),
  fatal: (m) => logLine("FATAL", C.bold + C.red, m),
};

process.on("uncaughtException", (err) => {
  log.fatal(`uncaughtException: ${err?.stack || err}`);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  log.fatal(`unhandledRejection: ${err?.stack || err}`);
  process.exit(1);
});

log.boot(`bun ${Bun.version} · pid ${process.pid} · port ${PORT}`);

try {
  await mkdir(RUNS_DIR, { recursive: true });
} catch (e) {
  log.error(`could not create RUNS_DIR (${RUNS_DIR}): ${e.message}`);
}

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

  // Hardening (per-process). Most ulimits unlimited so chromium runs unimpeded;
  // only the genuine safety bits remain:
  //   -t cpu seconds  → still bounds runaway CPU (anti-miner, mirrors timeout)
  //   -c 0           → no core dumps written to disk
  //   umask 077       → any file the script writes is private to its run
  // setpriv --no-new-privs (block setuid escalation) when available.
  const ulimits = `umask 077; ulimit -t ${cpuSec} -c 0`;
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

// ---------- Solver proxy endpoints ----------
//
// These proxy the bundled (or compose-network) turnstile-solver service.
// Caller doesn't need to know that solver exists or where it lives — the
// API surface is local to this server.

async function solverFetch(path, body, opts = {}) {
  if (!SOLVER_URL) {
    return { status: 503, body: { error: "solver_unavailable", message: "TURNSTILE_SOLVER_URL is not configured" } };
  }
  const ctrl = new AbortController();
  const timeout = opts.timeout ?? 90000;
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(`${SOLVER_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const txt = await resp.text();
    let parsed;
    try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt }; }
    return { status: resp.status, body: parsed };
  } catch (e) {
    if (e?.name === "AbortError") {
      return { status: 504, body: { error: "solver_timeout", timeoutMs: timeout } };
    }
    return { status: 502, body: { error: "solver_unreachable", message: String(e?.message || e) } };
  } finally {
    clearTimeout(t);
  }
}

// POST /solve  { sitekey, siteurl, action?, cdata?, timeout? }  → { token, elapsed }
async function handleSolve(req) {
  let body;
  try { body = await req.json(); } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const sitekey = (body?.sitekey || "").trim();
  const siteurl = (body?.siteurl || "").trim();
  if (!sitekey || !siteurl) {
    return jsonResponse(400, {
      error: "missing_fields",
      message: '"sitekey" and "siteurl" are required',
      example: { sitekey: "0x4AAAAAAA...", siteurl: "https://example.com" },
    });
  }
  active++;
  try {
    const { status, body: out } = await solverFetch("/solve", {
      sitekey,
      siteurl,
      action: body.action,
      cdata: body.cdata,
      timeout: body.timeout,
    }, { timeout: ((body.timeout || 90) + 15) * 1000 });
    return jsonResponse(status, out);
  } finally {
    active--;
  }
}

// POST /solve-challenge  { siteurl, timeout? }  → { url, title, user_agent, cookies, html }
async function handleSolveChallenge(req) {
  let body;
  try { body = await req.json(); } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const siteurl = (body?.siteurl || "").trim();
  if (!siteurl) {
    return jsonResponse(400, {
      error: "missing_fields",
      message: '"siteurl" is required',
      example: { siteurl: "https://target-with-cf.com" },
    });
  }
  active++;
  try {
    const { status, body: out } = await solverFetch("/solve-challenge", {
      siteurl,
      timeout: body.timeout,
    }, { timeout: ((body.timeout || 90) + 15) * 1000 });
    return jsonResponse(status, out);
  } finally {
    active--;
  }
}

// POST /bypass  { url, return?, timeout? }
//   return: "html" | "text" | "title" | "cookies" | "all" (default)
//
// Convenience: clear CF challenge via solver, then return whatever the caller
// wants. This is the easy button — no Playwright code, just give a URL.
async function handleBypass(req) {
  let body;
  try { body = await req.json(); } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const url = (body?.url || body?.siteurl || "").trim();
  if (!url) {
    return jsonResponse(400, {
      error: "missing_fields",
      message: '"url" is required',
      example: { url: "https://target-with-cf.com", return: "all" },
    });
  }
  const want = (body?.return || "all").toLowerCase();
  active++;
  try {
    const { status, body: out } = await solverFetch("/solve-challenge", {
      siteurl: url,
      timeout: body.timeout,
    }, { timeout: ((body.timeout || 90) + 15) * 1000 });

    if (status !== 200) return jsonResponse(status, out);

    // Shape the response per `return` selector
    if (want === "html") return new Response(out.html || "", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
    if (want === "text") {
      const text = (out.html || "").replace(/<script[\s\S]*?<\/script>/gi, " ")
                                    .replace(/<style[\s\S]*?<\/style>/gi, " ")
                                    .replace(/<[^>]+>/g, " ")
                                    .replace(/\s+/g, " ")
                                    .trim();
      return new Response(text, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    if (want === "title") return jsonResponse(200, { title: out.title || "", url: out.url });
    if (want === "cookies") {
      const cookieHeader = (out.cookies || []).map(c => `${c.name}=${c.value}`).join("; ");
      return jsonResponse(200, {
        cookies: out.cookies || [],
        cookieHeader,
        userAgent: out.user_agent || "",
        url: out.url,
      });
    }
    // default "all"
    return jsonResponse(200, {
      ok: true,
      url: out.url,
      title: out.title,
      userAgent: out.user_agent,
      cookies: out.cookies,
      cookieHeader: (out.cookies || []).map(c => `${c.name}=${c.value}`).join("; "),
      html: out.html,
      htmlLength: (out.html || "").length,
      elapsed: out.elapsed,
    });
  } finally {
    active--;
  }
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
      { method: "GET",  path: "/",                desc: "HTML landing page" },
      { method: "GET",  path: "/api/info",        desc: "this JSON info" },
      { method: "GET",  path: "/health",          desc: "liveness probe" },
      { method: "POST", path: "/run",             desc: "execute Playwright code", body: { code: "string (CJS or ESM)" } },
      { method: "POST", path: "/solve",           desc: "Turnstile token from sitekey + siteurl", body: { sitekey: "string", siteurl: "string", action: "string?", cdata: "string?", timeout: "seconds?" } },
      { method: "POST", path: "/solve-challenge", desc: "clear 'Just a moment' interstitial; returns cookies + html", body: { siteurl: "string", timeout: "seconds?" } },
      { method: "POST", path: "/bypass",          desc: "easy button: navigate + bypass CF + return html/text/title/cookies/all", body: { url: "string", return: "html|text|title|cookies|all" } },
    ],
    solverProxy: {
      enabled: !!SOLVER_URL,
      url: SOLVER_URL || "(not configured)",
      examples: {
        solve: 'curl -X POST $URL/solve -H "Content-Type: application/json" -d \'{"sitekey":"0x4AAAA...","siteurl":"https://target.com"}\'',
        solveChallenge: 'curl -X POST $URL/solve-challenge -H "Content-Type: application/json" -d \'{"siteurl":"https://protected.com"}\'',
        bypass: 'curl -X POST $URL/bypass -H "Content-Type: application/json" -d \'{"url":"https://protected.com","return":"text"}\'',
      },
    },
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
        coreDumps: 0,
        memory: "unlimited (host-wide cgroup is the real limiter)",
        fileSize: "unlimited",
        maxUserProcs: "unlimited",
        maxOpenFiles: "unlimited",
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
      browsers: {
        chromium: "bundled (headless_shell + headed)",
        firefox: "bundled",
        webkit: "bundled",
        chrome: "Google Chrome stable installed (use channel: 'chrome' for Widevine DRM)",
      },
      fonts: ["liberation", "noto", "noto-color-emoji", "noto-cjk", "ipafont-gothic", "wqy-zenhei", "thai-tlwg", "kacst"],
      xvfb: "available — headless:false works via Xvfb if needed",
    },
    stealth: {
      preinstalled: ["playwright-extra", "puppeteer-extra-plugin-stealth"],
      helperModule: "require('stealth') — pre-configured anti-detection wrapper",
      api: {
        "stealth.launch(opts)": "launch chromium with stealth plugin + anti-detect args",
        "stealth.launch({ channel: 'chrome' })": "launch real Google Chrome (Widevine DRM)",
        "stealth.context(browser, opts)": "context with realistic UA, viewport, locale, plugin shims",
        "stealth.gotoBypass(page, url)": "navigate + auto-handle CF (self-hosted solver if available, else local click)",
        "stealth.waitForCloudflare(page)": "standalone wait + auto-handle",
        "stealth.clickTurnstile(page)": "click 'Verify you are human' / Turnstile checkbox locally",
      },
    },
    captcha: {
      module: "require('captcha') — local solvers for several CAPTCHA classes",
      api: {
        "captcha.autoSolve(page)": "detect what CAPTCHA is on the page and try the right solver",
        "captcha.solveTurnstile(page)": "solve CF Turnstile (uses self-hosted solver if TURNSTILE_SOLVER_URL set, else local click)",
        "captcha.solveTurnstileViaSelfHosted(page)": "ask self-hosted solver for a token, inject it into the page",
        "captcha.clearChallenge(siteurl)": "POST /solve-challenge to self-hosted solver, returns { html, cookies, ... }",
        "captcha.clearChallengeAndAdoptCookies(context, siteurl)": "clear CF challenge and bring the cleared cookies into your Playwright context",
        "captcha.solveRecaptchaV2(page)": "full reCAPTCHA v2 audio-fallback flow (local Whisper)",
        "captcha.transcribe(audioBuffer)": "Whisper local transcription (English)",
        "captcha.ocrBuffer(imageBuffer)": "Tesseract local OCR (text/image CAPTCHAs)",
        "captcha.ocrUrl(page, url)": "fetch image with page cookies + OCR",
        "captcha.solveMath('2 + 3 * 4')": "safe math expression evaluator",
        "captcha.extractMath('What is 2 + 3?')": "find math expression in text and solve",
        "captcha.humanMove / humanClick / humanMoveAndClick": "bezier-curve mouse paths for natural cursor movement",
        "captcha.saveCookies / loadCookies / clearCookies": "per-origin cookie jar (skip re-solving challenges)",
      },
      selfHostedSolver: {
        recommended: "https://github.com/cv3inx/turnstile-solver — deploy this as a separate service; gives token-based Turnstile solving without paid APIs",
        howToWire: "Set env TURNSTILE_SOLVER_URL=http://your-solver:9988 — captcha.solveTurnstile() will automatically use it",
        endpoints: {
          "POST /solve": "{ sitekey, siteurl } → { token } — used for sites with widget on page",
          "POST /solve-challenge": "{ siteurl } → { html, cookies, user_agent, ... } — used for full 'Just a moment' interstitial",
        },
      },
      whatItHandles: {
        "CF Turnstile checkbox": "self-hosted solver returns token, OR local human click (~70% pass rate without solver)",
        "CF 'Just a moment'": "self-hosted /solve-challenge returns clearance cookies; OR local stealth click",
        "reCAPTCHA v2 audio fallback": "switches to audio mode, transcribes locally with Whisper",
        "Text/image CAPTCHA (4-8 char)": "local Tesseract OCR",
        "Math CAPTCHA": "safe expression evaluator",
        "Human-like mouse movement": "bezier-curve paths, jitter, variable click hold",
        "Cookie persistence": "save/load CF clearance cookies per origin",
      },
      whatItDoesNotHandle: {
        "hCaptcha image grid": "needs trained CV classifier — not realistic to ship in this repo. Use the self-hosted turnstile-solver only for Turnstile.",
        "reCAPTCHA v2 image challenge": "same",
        "CF Turnstile image challenge": "same — but a properly tuned self-hosted solver service often handles these",
        "CF Bot Management ML": "only the self-hosted solver has any chance",
      },
      env: {
        TURNSTILE_SOLVER_URL: process.env.TURNSTILE_SOLVER_URL || "(not set — local fallbacks only)",
        TRANSFORMERS_CACHE: process.env.TRANSFORMERS_CACHE || "/app/.cache/transformers",
        TESSDATA_PREFIX: process.env.TESSDATA_PREFIX || "/app/tesseract-data",
        WHISPER_MODEL: process.env.WHISPER_MODEL || "Xenova/whisper-tiny.en",
        COOKIES_DIR: process.env.COOKIES_DIR || "/app/cookies",
      },
      example: "const stealth = require('stealth');\nconst captcha = require('captcha');\nconst browser = await stealth.launch({ channel: 'chrome' });\nconst ctx = await stealth.context(browser);\nawait captcha.loadCookies(ctx, 'https://target.com'); // reuse prior CF clearance\nconst page = await ctx.newPage();\nawait stealth.gotoBypass(page, 'https://target.com');  // self-hosted solver if configured\nconst result = await captcha.autoSolve(page);          // catch any extra captcha\nconsole.log(await page.title());\nawait captcha.saveCookies(ctx, 'https://target.com');\nawait browser.close();",
    },
  };
}

const PUBLIC_DIR = "/app/public";
const INDEX_HTML_PATH = `${PUBLIC_DIR}/index.html`;
let HAS_INDEX_HTML = false;
try {
  await access(INDEX_HTML_PATH);
  HAS_INDEX_HTML = true;
  log.boot(`landing page → ${INDEX_HTML_PATH}`);
} catch {
  log.warn(`no index.html at ${INDEX_HTML_PATH} — / will return JSON instead`);
}

// ---------- Request logger ----------
//
// Output is tabular so columns line up across rows:
//   14:23:05.123 200  POST /bypass            12ms  url=https://target.com  ip=1.2.3.4
//   14:23:08.901 200  POST /run             5678ms  code=2048b type=cjs     ip=1.2.3.4
//   14:23:20.222 504  POST /solve          45003ms  sitekey=0x4AAAA…        ip=1.2.3.4
//   14:23:25.555 404  GET  /run                1ms                          ip=1.2.3.4
//
// /health, /api/info, /favicon.ico are quiet by default so Docker probes
// don't spam the log; they're still logged when they return 4xx/5xx.
const LOG_QUIET_PATHS = new Set(["/health", "/api/info", "/favicon.ico"]);

const METHOD_COLORS = {
  GET:    C.green,
  POST:   C.cyan,
  PUT:    C.yellow,
  DELETE: C.red,
  PATCH:  C.magenta,
};

function colorStatus(status) {
  if (status >= 500) return `${C.red}${status}${C.reset}`;
  if (status >= 400) return `${C.yellow}${status}${C.reset}`;
  if (status >= 300) return `${C.cyan}${status}${C.reset}`;
  return `${C.green}${status}${C.reset}`;
}

function colorMethod(method) {
  const c = METHOD_COLORS[method] || C.gray;
  return `${c}${method.padEnd(4)}${C.reset}`;
}

function fmtDuration(ms) {
  // Right-align in a 7-char column so durations stack visually
  const s = ms < 1000 ? `${ms}ms`
          : ms < 60000 ? `${(ms / 1000).toFixed(1)}s`
          : `${Math.round(ms / 1000)}s`;
  return s.padStart(7);
}

function clientIp(req, srv) {
  const peer = srv?.requestIP?.(req)?.address;
  if (peer && peer !== "::1" && peer !== "127.0.0.1") return peer;
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return peer || "-";
}

function truncate(s, n) {
  if (typeof s !== "string") return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function readPayloadHints(req) {
  if (req.method !== "POST") return "";
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) return "";
  try {
    const txt = await req.clone().text();
    if (!txt) return "";
    const data = JSON.parse(txt);
    const hints = [];
    if (data.url) hints.push(`url=${truncate(String(data.url), 50)}`);
    else if (data.siteurl) hints.push(`siteurl=${truncate(String(data.siteurl), 50)}`);
    if (data.sitekey) hints.push(`sitekey=${truncate(String(data.sitekey), 14)}`);
    if (data.return) hints.push(`return=${data.return}`);
    if (data.code) hints.push(`code=${data.code.length}b`);
    if (data.type) hints.push(`type=${data.type}`);
    return hints.join(" ");
  } catch {
    return "";
  }
}

let _headerPrinted = false;
function printLogHeader() {
  if (_headerPrinted) return;
  _headerPrinted = true;
  process.stdout.write(
    `${C.dim}${"time".padEnd(12)} ${"sts".padEnd(3)} ${"method".padEnd(4)} ${"path".padEnd(20)} ${"   dur".padEnd(7)}  ${"hints".padEnd(40)}  ip${C.reset}\n` +
    `${C.dim}${"─".repeat(12)} ${"─".repeat(3)} ${"─".repeat(4)} ${"─".repeat(20)} ${"─".repeat(7)}  ${"─".repeat(40)}  ─${C.reset}\n`
  );
}

async function route(req) {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/") {
    if (HAS_INDEX_HTML) {
      return new Response(Bun.file(INDEX_HTML_PATH), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return jsonResponse(200, infoPayload());
  }
  if (req.method === "GET" && url.pathname === "/api/info") {
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
  if (req.method === "POST" && url.pathname === "/solve") {
    return handleSolve(req);
  }
  if (req.method === "POST" && url.pathname === "/solve-challenge") {
    return handleSolveChallenge(req);
  }
  if (req.method === "POST" && url.pathname === "/bypass") {
    return handleBypass(req);
  }
  return jsonResponse(404, {
    error: "not_found",
    method: req.method,
    path: url.pathname,
    hint: "see GET / for available endpoints",
  });
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 255,
  maxRequestBodySize: 1024 * 1024 * 1024, // 1 GiB — effectively no body limit
  async fetch(req, srv) {
    const t0 = performance.now();
    const url = new URL(req.url);
    const path = url.pathname;
    const quiet = LOG_QUIET_PATHS.has(path);

    const hints = quiet ? "" : await readPayloadHints(req);
    const ip = clientIp(req, srv);
    const ua = req.headers.get("user-agent") || "";

    let resp;
    let errored = null;
    try {
      resp = await route(req);
    } catch (e) {
      errored = e;
      resp = jsonResponse(500, { error: "internal", message: String(e?.message || e) });
    }

    const ms = Math.round(performance.now() - t0);
    if (!quiet || resp.status >= 400) {
      printLogHeader();
      const hintsPad = truncate(hints, 40).padEnd(40);
      const pathPad = truncate(path, 20).padEnd(20);
      process.stdout.write(
        `${C.gray}${ts()}${C.reset} ${colorStatus(resp.status)} ${colorMethod(req.method)} ${pathPad} ${fmtDuration(ms)}  ${C.dim}${hintsPad}${C.reset}  ${C.gray}${ip}${C.reset}\n`
      );
      if (errored) {
        process.stdout.write(`  ${C.red}└─${C.reset} ${errored?.stack || errored}\n`);
      }
    }
    return resp;
  },
});

log.boot(`listening on :${server.port} · setpriv=${SETPRIV_OK} · solver=${SOLVER_URL || "off"}`);
log.boot(`ready · ${C.dim}GET / for the dashboard${C.reset}`);

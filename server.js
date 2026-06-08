import { writeFile, unlink, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const PORT = parseInt(Bun.env.PORT || "7860", 10);
const TIMEOUT = parseInt(Bun.env.TIMEOUT_MS || "1800000", 10); // 30 minutes
const MAX_CODE_BYTES = parseInt(Bun.env.MAX_CODE_BYTES || "50000", 10);
const MAX_BODY_BYTES = parseInt(Bun.env.MAX_BODY_BYTES || "100000", 10);
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const HEARTBEAT_MS = 30000;
const KILL_GRACE_MS = 500;

const NODE_MODULES = "/app/node_modules";
const RUNS_DIR = "/app/runs";

await mkdir(RUNS_DIR, { recursive: true });

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

async function readCapped(stream, maxBytes) {
  if (!stream) return { text: "", truncated: false };
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      const slice = value.subarray(0, Math.max(0, maxBytes - total));
      if (slice.byteLength) chunks.push(slice);
      truncated = true;
      try { await reader.cancel(); } catch {}
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
  return { text: new TextDecoder().decode(merged), truncated };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Burn: kill the entire process tree, then wipe the run workspace ---
async function burn(pid, runDir, runId) {
  // 1. Kill process group (negative PID = pgid)
  if (pid && pid > 1) {
    try { process.kill(-pid, "SIGKILL"); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  await sleep(KILL_GRACE_MS);

  // 2. Session-wide kill — catches anything that escaped the pgid
  if (pid && pid > 1) {
    try { Bun.spawnSync(["pkill", "-9", "-s", String(pid)]); } catch {}
  }

  // 3. Best-effort: kill any leftover playwright/chromium that ran with our run dir as HOME
  if (runDir) {
    try { Bun.spawnSync(["pkill", "-9", "-f", runDir]); } catch {}
  }

  // 4. Wipe the per-run workspace — any binary/file the script wrote here is gone
  if (runDir) {
    try { await rm(runDir, { recursive: true, force: true }); } catch {}
  }

  // 5. Wipe ORPHANED chromium SHM files only — never touch files still in use
  //    by another concurrent request. `fuser -s` exits non-zero if no process
  //    has the file open; only those get deleted.
  try {
    Bun.spawnSync(["bash", "-c",
      `for f in /dev/shm/.org.chromium.* /dev/shm/.com.google.Chrome* /dev/shm/pw-${runId}*; do ` +
      `[ -e "$f" ] || continue; ` +
      `fuser -s "$f" 2>/dev/null || rm -rf "$f" 2>/dev/null; ` +
      `done`,
    ]);
  } catch {}
}

async function runScript(code) {
  const id = randomBytes(8).toString("hex");
  const scriptFile = join(RUNS_DIR, `${id}.js`);
  const runDir = `/tmp/run-${id}`;

  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await writeFile(scriptFile, shim + "\n" + code, { mode: 0o400 });

  const cpuSec = Math.ceil(TIMEOUT / 1000) + 5;

  // Layered hardening:
  //  - umask 077 + ulimits (CPU/mem/file/proc/fd, no core dumps)
  //  - setpriv --no-new-privs (block setuid escalation)
  //  - exec via bash -c, child becomes session leader (detached:true)
  const ulimits = `umask 077; ulimit -t ${cpuSec} -v 1048576 -f 51200 -u 200 -n 1024 -c 0`;
  const inner = SETPRIV_OK
    ? `setpriv --no-new-privs -- bun ${JSON.stringify(scriptFile)}`
    : `bun ${JSON.stringify(scriptFile)}`;
  const wrapped = `${ulimits}; exec ${inner}`;

  const proc = Bun.spawn(["bash", "-c", wrapped], {
    stdout: "pipe",
    stderr: "pipe",
    detached: true, // becomes its own session/pgrp leader → killable as a group
    env: {
      PATH: "/home/user/.bun/bin:/usr/local/bin:/usr/bin:/bin",
      HOME: runDir,        // unique per-run home
      TMPDIR: runDir,      // libraries respecting TMPDIR write here
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

  let out, err, exitCode;
  try {
    [out, err, exitCode] = await Promise.all([
      readCapped(proc.stdout, MAX_OUTPUT_BYTES),
      readCapped(proc.stderr, MAX_OUTPUT_BYTES),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
    // Always burn — even on success. Catches double-forked processes,
    // wipes any binary the script wrote to its workspace.
    await burn(childPid, runDir, id);
    unlink(scriptFile).catch(() => {});
  }

  return {
    timeout: killedByTimer,
    stdout: out?.text || "",
    stderr: err?.text || "",
    exitCode,
    truncated: out?.truncated || err?.truncated || false,
    burned: true,
  };
}

function streamingJson(workFn) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try { controller.enqueue(enc.encode(" ")); } catch {}
      }, HEARTBEAT_MS);
      let body;
      try {
        const result = await workFn();
        body = JSON.stringify(result);
      } catch (e) {
        body = JSON.stringify({ error: "internal", message: String(e?.message || e) });
      } finally {
        clearInterval(heartbeat);
      }
      try { controller.enqueue(enc.encode(body)); } catch {}
      try { controller.close(); } catch {}
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleRun(req) {
  const lenHeader = req.headers.get("content-length");
  if (lenHeader && parseInt(lenHeader, 10) > MAX_BODY_BYTES) {
    return jsonResponse(413, { error: "body_too_large", maxBytes: MAX_BODY_BYTES });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  const code = body?.code;
  if (!code || typeof code !== "string") {
    return jsonResponse(400, { error: 'Missing "code" string in JSON body' });
  }
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    return jsonResponse(413, { error: "code_too_large", maxBytes: MAX_CODE_BYTES });
  }
  const blocked = checkBlocked(code);
  if (blocked) {
    return jsonResponse(403, { error: "code_blocked", reason: "matched abuse pattern" });
  }

  active++;
  return streamingJson(async () => {
    try {
      const result = await runScript(code);
      if (result.timeout) {
        return {
          error: "timeout",
          output: result.stdout.trim(),
          stderr: result.stderr,
          truncated: result.truncated,
          burned: result.burned,
        };
      }
      return {
        output: result.stdout.trim(),
        stderr: result.stderr || undefined,
        exitCode: result.exitCode,
        truncated: result.truncated || undefined,
        burned: result.burned,
      };
    } finally {
      active--;
    }
  });
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/") {
      return jsonResponse(200, {
        status: "ok",
        runtime: `bun ${Bun.version}`,
        endpoint: "POST /run { code }",
        notes: "Code may use either CommonJS (require) or ESM (import).",
        hardening: {
          setpriv: SETPRIV_OK,
          envStripped: true,
          perRequestWorkspace: "/tmp/run-<id>",
          burnOnComplete: true,
          burnSteps: ["killpg(-pid)", "pkill -s sid", "pkill -f runDir", "rm -rf runDir", "wipe /dev/shm chromium leftovers"],
          ulimits: "cpu/mem/files/procs/fd",
        },
        limits: {
          maxCodeBytes: MAX_CODE_BYTES,
          timeoutMs: TIMEOUT,
          heartbeatMs: HEARTBEAT_MS,
          activeNow: active,
        },
      });
    }
    if (req.method === "POST" && url.pathname === "/run") {
      return handleRun(req);
    }
    return jsonResponse(404, { error: "not_found" });
  },
});

console.log(`Playwright API listening on :${server.port} (setpriv=${SETPRIV_OK})`);

// Cookie jar — persist CF clearance / login cookies per origin so we don't
// have to re-solve a challenge on every request.
//
// Storage: /app/cookies/<sha1(origin)>.json
// On HF Space this is wiped on container restart; on a VPS it persists if
// you mount a volume to /app/cookies.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const COOKIES_DIR = process.env.COOKIES_DIR || '/app/cookies';
try { fs.mkdirSync(COOKIES_DIR, { recursive: true }); } catch {}

function originKey(url) {
  try {
    const u = new URL(url);
    return crypto.createHash('sha1').update(u.origin).digest('hex').slice(0, 16);
  } catch {
    return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 16);
  }
}

function pathFor(url) {
  return path.join(COOKIES_DIR, `${originKey(url)}.json`);
}

async function saveCookies(context, url) {
  try {
    const cookies = await context.cookies(url);
    if (!cookies.length) return false;
    fs.writeFileSync(pathFor(url), JSON.stringify({ url, savedAt: Date.now(), cookies }, null, 2));
    return true;
  } catch {
    return false;
  }
}

async function loadCookies(context, url) {
  try {
    const file = pathFor(url);
    if (!fs.existsSync(file)) return false;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data.cookies?.length) return false;
    // Drop expired cookies
    const now = Math.floor(Date.now() / 1000);
    const fresh = data.cookies.filter((c) => !c.expires || c.expires === -1 || c.expires > now);
    if (!fresh.length) return false;
    await context.addCookies(fresh);
    return true;
  } catch {
    return false;
  }
}

function clearCookies(url) {
  try {
    const file = pathFor(url);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

module.exports = { saveCookies, loadCookies, clearCookies, COOKIES_DIR };

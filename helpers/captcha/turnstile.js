// Cloudflare Turnstile / "Verify you are human" — self-hosted solver.
//
// Two paths, picked automatically:
//
//   1. SELF-HOSTED SOLVER (recommended for production)
//      Set env var TURNSTILE_SOLVER_URL=http://your-solver:9988
//      Pointing at an instance of github.com/cv3inx/turnstile-solver.
//      That service exposes:
//        POST /solve            { sitekey, siteurl } -> { token }
//        POST /solve-challenge  { siteurl }          -> { html, cookies, ... }
//      No third-party API, no per-solve fees, runs on your own box.
//
//   2. LOCAL CLICK FALLBACK (if no solver URL is configured)
//      Find the Turnstile iframe, move mouse along a human bezier path,
//      click the checkbox. Works for "soft" Turnstile where checkbox + good
//      fingerprint is enough. Returns false if the challenge needs more.

const { humanMove, humanClick } = require('./mouse');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function solverUrl() {
  return (process.env.TURNSTILE_SOLVER_URL || '').replace(/\/+$/, '') || null;
}

// Extract Turnstile sitekey + page URL from the current page.
async function readSitekey(page) {
  return page.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll('[data-sitekey]'),
      ...document.querySelectorAll('.cf-turnstile'),
    ];
    for (const el of candidates) {
      const k = el.getAttribute('data-sitekey');
      if (k) return k;
    }
    // Sometimes sitekey is inside a turnstile iframe URL
    for (const f of document.querySelectorAll('iframe')) {
      const src = f.src || '';
      if (src.includes('challenges.cloudflare.com')) {
        const m = src.match(/[?&](?:sitekey|k)=([^&]+)/);
        if (m) return decodeURIComponent(m[1]);
      }
    }
    return null;
  }).catch(() => null);
}

async function findTurnstileFrame(page) {
  return page.frames().find((f) => {
    const u = f.url() || '';
    return u.includes('challenges.cloudflare.com') || u.includes('turnstile');
  });
}

// --- Path 1: delegate to self-hosted turnstile-solver service ---
async function solveViaSelfHosted(page, opts = {}) {
  const url = solverUrl();
  if (!url) return false;

  const sitekey = opts.sitekey || (await readSitekey(page));
  if (!sitekey) return false;
  const siteurl = opts.siteurl || page.url();
  const timeout = Math.ceil((opts.timeout ?? 60000) / 1000);

  let token;
  try {
    const resp = await fetch(`${url}/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sitekey, siteurl, timeout, action: opts.action, cdata: opts.cdata }),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    if (!data?.token) return false;
    token = data.token;
  } catch {
    return false;
  }

  // Inject the token into the page so the form/api considers it solved.
  return page.evaluate((tok) => {
    let injected = false;
    document.querySelectorAll('input[name="cf-turnstile-response"]').forEach((el) => {
      el.value = tok;
      injected = true;
    });
    // Fire any registered callbacks (page may have data-callback="..." on .cf-turnstile)
    document.querySelectorAll('.cf-turnstile[data-callback]').forEach((el) => {
      const cb = el.getAttribute('data-callback');
      try { window[cb]?.(tok); injected = true; } catch {}
    });
    // Some sites listen for the explicit window.turnstile.execute() pattern
    try { window.turnstile?.execute?.(); } catch {}
    return injected || !!tok;
  }, token).catch(() => false);
}

// --- Path 2: local human-bezier click ---
async function clickTurnstile(page, opts = {}) {
  const { timeout = 20000 } = opts;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const tsFrame = await findTurnstileFrame(page);
    if (tsFrame) {
      await sleep(800 + Math.random() * 700);
      const el = await tsFrame.frameElement().catch(() => null);
      const box = el ? await el.boundingBox().catch(() => null) : null;
      if (box) {
        const targetX = box.x + 30 + (Math.random() - 0.5) * 4;
        const targetY = box.y + 30 + (Math.random() - 0.5) * 4;
        const startX = box.x + box.width + 200 + Math.random() * 100;
        const startY = box.y - 100 + Math.random() * 50;
        await humanMove(page, startX, startY, targetX, targetY, { steps: 30 });
        await sleep(120 + Math.random() * 200);
        await humanClick(page, targetX, targetY);
        return true;
      }
      const selectors = ['input[type="checkbox"]', 'label.cb-lb', '#challenge-stage input'];
      for (const sel of selectors) {
        const loc = tsFrame.locator(sel).first();
        if (await loc.count().catch(() => 0)) {
          await loc.click({ timeout: 3000, force: true }).catch(() => {});
          return true;
        }
      }
    }

    const buttonSelectors = [
      'button:has-text("Verify you are human")',
      'button:has-text("I am human")',
      'input[type="button"][value*="Verify" i]',
    ];
    for (const sel of buttonSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.count().catch(() => 0)) {
        await btn.click({ timeout: 3000 }).catch(() => {});
        return true;
      }
    }
    await sleep(500);
  }
  return false;
}

// Wait for the Turnstile token to appear (= challenge solved).
async function waitForToken(page, opts = {}) {
  const { timeout = 30000 } = opts;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(() => {
      const el = document.querySelector('input[name="cf-turnstile-response"]');
      return !!(el && el.value && el.value.length > 20);
    }).catch(() => false);
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

// Full flow: try self-hosted solver first, fall back to local click.
async function solveTurnstile(page, opts = {}) {
  if (solverUrl()) {
    const ok = await solveViaSelfHosted(page, opts).catch(() => false);
    if (ok) return true;
    // fall through to click if the solver couldn't get a token
  }
  const clicked = await clickTurnstile(page, opts);
  if (!clicked) return false;
  return waitForToken(page, opts);
}

// --- /solve-challenge — clear "Just a moment..." and return cookies + html ---
async function clearChallenge(siteurl, opts = {}) {
  const url = solverUrl();
  if (!url) return null;
  const timeout = Math.ceil((opts.timeout ?? 60000) / 1000);
  try {
    const resp = await fetch(`${url}/solve-challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteurl, timeout }),
    });
    if (!resp.ok) return null;
    return await resp.json(); // { url, title, user_agent, cookies, html, ... }
  } catch {
    return null;
  }
}

// Convenience: clear CF challenge for a URL, then bring those cookies into
// the current Playwright context so subsequent navigations are unblocked.
async function clearChallengeAndAdoptCookies(context, siteurl, opts = {}) {
  const result = await clearChallenge(siteurl, opts);
  if (!result?.cookies?.length) return null;
  // Coerce shapes into Playwright's expected cookie type
  const cookies = result.cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: typeof c.expires === 'number' ? c.expires : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite || 'Lax',
  }));
  await context.addCookies(cookies).catch(() => {});
  return result;
}

module.exports = {
  clickTurnstile,
  waitForToken,
  solveTurnstile,
  solveViaSelfHosted,
  findTurnstileFrame,
  readSitekey,
  clearChallenge,
  clearChallengeAndAdoptCookies,
  solverUrl,
};

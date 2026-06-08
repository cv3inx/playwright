// Pre-configured stealth helper.
//
// Usage in user code (CJS):
//   const stealth = require('stealth');
//   const browser = await stealth.launch();           // headless chromium with stealth
//   const browser = await stealth.launch({ channel: 'chrome' }); // real Chrome (Widevine DRM)
//   const browser = await stealth.launchHeadful();    // headed mode via Xvfb (kalau perlu)
//
//   const ctx = await stealth.context(browser);       // context dengan UA + viewport realistic
//   const page = await ctx.newPage();
//   await stealth.gotoBypass(page, 'https://target.com');  // navigates + waits for CF challenge to pass
//   await stealth.waitForCloudflare(page);            // standalone — call after a navigation
//
// Or ESM:
//   import stealth from 'stealth';
//   const browser = await stealth.launch();

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

let _registered = false;
function register() {
  if (_registered) return;
  const stealth = StealthPlugin();
  // Aggressive evasions; remove if a site breaks because of them.
  chromium.use(stealth);
  _registered = true;
}

const REALISTIC_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_ARGS = [
  '--no-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
  '--disable-site-isolation-trials',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-infobars',
  '--password-store=basic',
  '--use-mock-keychain',
  '--lang=en-US,en',
];

async function launch(opts = {}) {
  register();
  const {
    channel,            // 'chrome' for real Google Chrome (DRM), undefined for chromium
    headless = true,
    args = [],
    proxy,
    ...rest
  } = opts;
  try {
    return await chromium.launch({
      headless,
      channel,
      proxy,
      args: [...DEFAULT_ARGS, ...args],
      ...rest,
    });
  } catch (err) {
    // Chrome is x86_64-only on Linux. On ARM hosts (AWS Graviton, Oracle
    // Ampere, Raspberry Pi) the Google .deb is unavailable so this lookup
    // fails. Fall back to Playwright's bundled chromium silently — user
    // code shouldn't have to know the host arch.
    const msg = String(err?.message || '');
    const fellback = channel && /Chromium distribution|is not found|install chrome/i.test(msg);
    if (fellback) {
      return await chromium.launch({
        headless,
        proxy,
        args: [...DEFAULT_ARGS, ...args],
        ...rest,
      });
    }
    throw err;
  }
}

async function launchHeadful(opts = {}) {
  // Some bot detectors will only ever pass for non-headless. Xvfb is provided
  // by the Dockerfile; xvfb-run wraps the launch so headless:false still works
  // in a server container. Use launch() with headless:false directly when this
  // function is called.
  return launch({ ...opts, headless: false });
}

async function context(browser, opts = {}) {
  const {
    userAgent = REALISTIC_UA,
    viewport = { width: 1920, height: 1080 },
    locale = 'en-US',
    timezoneId = 'Asia/Jakarta',
    extraHTTPHeaders,
    ...rest
  } = opts;
  const ctx = await browser.newContext({
    userAgent,
    viewport,
    locale,
    timezoneId,
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      ...extraHTTPHeaders,
    },
    ...rest,
  });
  await ctx.addInitScript(() => {
    // Extra evasions on top of the stealth plugin.
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin' },
        { name: 'Chrome PDF Viewer' },
        { name: 'Native Client' },
      ],
    });
    // Window.chrome stub for older detectors
    if (!window.chrome) {
      window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
    }
  });
  return ctx;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.random() * (max - min));

// Local-only Turnstile / reCAPTCHA solvers (no third-party API).
// See helpers/captcha/ for the full implementations.
let _captcha;
function getCaptcha() {
  if (!_captcha) _captcha = require('captcha');
  return _captcha;
}

// Try to click the Turnstile / "Verify you are human" checkbox if present.
// Returns true if a click was attempted, false if no checkbox visible.
//
// Cloudflare Turnstile renders inside an <iframe> on a different origin.
// Playwright cannot read pixel content cross-origin, but it CAN dispatch
// a click at a known coordinate inside that iframe (Turnstile's checkbox
// is positioned at a predictable offset). Combined with stealth fingerprint,
// this passes the 'soft' Turnstile (where checkbox click is enough).
async function clickTurnstile(page, opts = {}) {
  const { timeout = 15000 } = opts;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      // 1. Direct iframe approach (most reliable for current CF Turnstile)
      const tsFrame = page.frames().find((f) => {
        const u = f.url() || '';
        return u.includes('challenges.cloudflare.com') || u.includes('turnstile');
      });
      if (tsFrame) {
        // Wait a beat — Turnstile sometimes needs to finish boot animation
        await jitter(800, 1500);
        // Try the canonical checkbox first
        const candidates = [
          'input[type="checkbox"]',
          'label.cb-lb',
          'div.cb-c',
          '#challenge-stage input',
        ];
        for (const sel of candidates) {
          const loc = tsFrame.locator(sel).first();
          if (await loc.count().catch(() => 0)) {
            await loc.click({ timeout: 3000, force: true }).catch(() => {});
            return true;
          }
        }
        // Fallback: blind click at the typical checkbox offset (28, 28) inside the frame
        const el = await tsFrame.frameElement().catch(() => null);
        if (el) {
          const box = await el.boundingBox().catch(() => null);
          if (box) {
            await page.mouse.move(box.x + 30 + Math.random() * 4, box.y + 30 + Math.random() * 4, { steps: 8 });
            await jitter(150, 400);
            await page.mouse.click(box.x + 30, box.y + 30);
            return true;
          }
        }
      }

      // 2. Generic "Verify you are human" button (sometimes outside iframe)
      const btnSelectors = [
        'button:has-text("Verify you are human")',
        'button:has-text("Verify")',
        'input[type="button"][value*="Verify"]',
      ];
      for (const sel of btnSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.count().catch(() => 0)) {
          await btn.click({ timeout: 3000 }).catch(() => {});
          return true;
        }
      }
    } catch {}
    await sleep(500);
  }
  return false;
}

// Wait until the Cloudflare interstitial / Just A Moment page goes away.
// Resolves true once we see real content, false on timeout.
//
// Strategy (all local, no third-party API):
//   1. Detect the interstitial.
//   2. If a Turnstile checkbox is visible — click it with human mouse path.
//   3. Poll for content to load.
async function waitForCloudflare(page, opts = {}) {
  const {
    timeout = 60000,
    pollMs = 500,
    autoClick = true,
  } = opts;
  const deadline = Date.now() + timeout;
  let clicked = false;

  const isCloudflareWall = async () => {
    try {
      const title = (await page.title()).toLowerCase();
      if (
        title.includes('just a moment') ||
        title.includes('attention required') ||
        title.includes('please wait')
      ) return true;
      const html = await page.content();
      const lower = html.toLowerCase();
      return (
        lower.includes('cf-browser-verification') ||
        lower.includes('cf-challenge-running') ||
        lower.includes('challenge-platform') ||
        lower.includes('checking your browser') ||
        lower.includes('please wait while we verify') ||
        lower.includes('cf-turnstile')
      );
    } catch {
      return false;
    }
  };

  while (Date.now() < deadline) {
    if (!(await isCloudflareWall())) return true;

    if (autoClick && !clicked) {
      const captcha = getCaptcha();
      // 1) If a self-hosted turnstile-solver is configured, ask it for a token
      //    and inject. Cheapest path — no in-browser interaction needed.
      if (captcha.turnstileSolverUrl()) {
        const tokenInjected = await captcha
          .solveTurnstileViaSelfHosted(page, { timeout: 30000 })
          .catch(() => false);
        if (tokenInjected) {
          await sleep(1500);
          continue; // re-check the wall predicate
        }
      }
      // 2) Fall back to local human-bezier click + token poll
      const did = await captcha.solveTurnstile(page, { timeout: 8000 }).catch(() => false);
      if (did) return true;
      clicked = true; // don't retry the click loop forever
      await sleep(2000);
    }

    await sleep(pollMs);
  }
  return false;
}

// Navigate + wait for CF challenge automatically. Returns the response.
async function gotoBypass(page, url, opts = {}) {
  const {
    waitUntil = 'domcontentloaded',
    cfTimeout = 60000,
    autoClick = true,
    ...gotoOpts
  } = opts;
  const resp = await page.goto(url, { waitUntil, ...gotoOpts });
  await waitForCloudflare(page, { timeout: cfTimeout, autoClick });
  return resp;
}

module.exports = {
  chromium,
  launch,
  launchHeadful,
  context,
  waitForCloudflare,
  gotoBypass,
  clickTurnstile,
  REALISTIC_UA,
  DEFAULT_ARGS,
};

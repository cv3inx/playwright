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
  return chromium.launch({
    headless,
    channel,
    proxy,
    args: [...DEFAULT_ARGS, ...args],
    ...rest,
  });
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

// If TWOCAPTCHA_KEY (or CAPSOLVER_KEY) env var is set on the Space, this hook
// can be plugged into waitForCloudflare to solve image-CAPTCHAs that show up
// after the checkbox click. Disabled by default — costs money and requires
// signup. Implementation skeleton follows the 2captcha API.
async function solveTurnstileWithService(page, opts = {}) {
  const apiKey = opts.apiKey || process.env.TWOCAPTCHA_KEY || process.env.CAPSOLVER_KEY;
  if (!apiKey) return false;

  // Extract sitekey + page URL
  const sitekey = await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey], .cf-turnstile[data-sitekey]');
    return el?.getAttribute('data-sitekey') || null;
  });
  if (!sitekey) return false;

  const pageUrl = page.url();
  const service = opts.service || (process.env.CAPSOLVER_KEY ? 'capsolver' : '2captcha');

  try {
    if (service === '2captcha') {
      // Submit job
      const submit = await fetch(`https://2captcha.com/in.php?key=${apiKey}&method=turnstile&sitekey=${sitekey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`);
      const sub = await submit.json();
      if (sub.status !== 1) return false;
      const jobId = sub.request;
      // Poll
      for (let i = 0; i < 40; i++) {
        await sleep(5000);
        const r = await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${jobId}&json=1`);
        const j = await r.json();
        if (j.status === 1) {
          await page.evaluate((token) => {
            const el = document.querySelector('input[name="cf-turnstile-response"]');
            if (el) el.value = token;
            window.turnstile?.execute?.();
          }, j.request);
          return true;
        }
      }
    } else if (service === 'capsolver') {
      const create = await fetch('https://api.capsolver.com/createTask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: apiKey,
          task: { type: 'AntiTurnstileTaskProxyLess', websiteURL: pageUrl, websiteKey: sitekey },
        }),
      });
      const cr = await create.json();
      if (!cr.taskId) return false;
      for (let i = 0; i < 40; i++) {
        await sleep(3000);
        const r = await fetch('https://api.capsolver.com/getTaskResult', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: apiKey, taskId: cr.taskId }),
        });
        const j = await r.json();
        if (j.status === 'ready') {
          await page.evaluate((token) => {
            const el = document.querySelector('input[name="cf-turnstile-response"]');
            if (el) el.value = token;
            window.turnstile?.execute?.();
          }, j.solution.token);
          return true;
        }
      }
    }
  } catch {}
  return false;
}

// Wait until the Cloudflare interstitial / Just A Moment page goes away.
// Resolves true once we see real content, false on timeout.
//
// Strategy:
//   1. Detect the interstitial.
//   2. If a Turnstile checkbox is visible — click it (autoClick=true).
//   3. If a CAPTCHA solver key is configured — try service-based solve.
//   4. Poll for content to load.
async function waitForCloudflare(page, opts = {}) {
  const {
    timeout = 60000,
    pollMs = 500,
    autoClick = true,
    useSolver = !!(process.env.TWOCAPTCHA_KEY || process.env.CAPSOLVER_KEY),
  } = opts;
  const deadline = Date.now() + timeout;
  let clicked = false;
  let solved = false;

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
      const did = await clickTurnstile(page, { timeout: 3000 });
      if (did) {
        clicked = true;
        await sleep(2000); // give CF a moment to validate
        continue;
      }
    }

    if (useSolver && !solved && clicked) {
      // Solver only needed if click alone didn't pass
      const ok = await solveTurnstileWithService(page).catch(() => false);
      if (ok) solved = true;
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
    useSolver,
    ...gotoOpts
  } = opts;
  const resp = await page.goto(url, { waitUntil, ...gotoOpts });
  await waitForCloudflare(page, { timeout: cfTimeout, autoClick, useSolver });
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
  solveTurnstileWithService,
  REALISTIC_UA,
  DEFAULT_ARGS,
};

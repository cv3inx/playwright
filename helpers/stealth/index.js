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

// Wait until the Cloudflare interstitial / Just A Moment page goes away.
// Resolves true once we see real content, false on timeout.
async function waitForCloudflare(page, opts = {}) {
  const { timeout = 60000, pollMs = 500 } = opts;
  const deadline = Date.now() + timeout;

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
        lower.includes('please wait while we verify')
      );
    } catch {
      return false;
    }
  };

  while (Date.now() < deadline) {
    if (!(await isCloudflareWall())) return true;
    await sleep(pollMs);
  }
  return false;
}

// Navigate + wait for CF challenge automatically. Returns the response.
async function gotoBypass(page, url, opts = {}) {
  const {
    waitUntil = 'domcontentloaded',
    cfTimeout = 60000,
    ...gotoOpts
  } = opts;
  const resp = await page.goto(url, { waitUntil, ...gotoOpts });
  await waitForCloudflare(page, { timeout: cfTimeout });
  return resp;
}

module.exports = {
  chromium,
  launch,
  launchHeadful,
  context,
  waitForCloudflare,
  gotoBypass,
  REALISTIC_UA,
  DEFAULT_ARGS,
};

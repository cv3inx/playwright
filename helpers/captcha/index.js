// Local-only CAPTCHA solvers — no third-party API services.
//
// What's included:
//   - Audio CAPTCHA  (Whisper, runs locally; English)
//   - Text/OCR CAPTCHA (Tesseract.js, runs locally)
//   - Math CAPTCHA  (safe expression eval)
//   - reCAPTCHA v2  (full audio-fallback flow)
//   - Cloudflare Turnstile (stealth click + human mouse path)
//   - Cookie jar  (skip re-solving by reusing CF clearance per origin)
//
// What is NOT included (and why):
//   - hCaptcha image grid / reCAPTCHA v2 image challenge / CF Turnstile
//     image challenge — these need a trained CV classifier. There is no
//     accurate, license-free, sub-1GB classifier for "select all cars/buses
//     /traffic lights" tasks. To avoid pretending otherwise, those modes
//     return false instead of guessing.

const audio = require('./audio');
const ocr = require('./ocr');
const math = require('./math');
const recaptcha = require('./recaptcha');
const turnstile = require('./turnstile');
const mouse = require('./mouse');
const cookies = require('./cookies');

// Dispatcher: figure out what CAPTCHA is on the page and try the right solver.
async function autoSolve(page, opts = {}) {
  const html = await page.content().catch(() => '');
  const lower = html.toLowerCase();

  // Order matters — try the cheapest detectors first.
  if (lower.includes('cf-turnstile') || page.frames().some((f) => /challenges\.cloudflare\.com/.test(f.url() || ''))) {
    const ok = await turnstile.solveTurnstile(page, opts);
    return { type: 'turnstile', solved: ok };
  }
  if (lower.includes('g-recaptcha') || page.frames().some((f) => /\/recaptcha\/api2\/anchor/.test(f.url() || ''))) {
    const ok = await recaptcha.solveRecaptchaV2(page, opts);
    return { type: 'recaptcha-v2', solved: ok };
  }
  // Math text? Look for "X + Y =" style on the page
  const mathAns = math.extractAndSolve(await page.evaluate(() => document.body.innerText).catch(() => ''));
  if (mathAns !== null) {
    return { type: 'math', solved: false, answer: mathAns, hint: 'fill the answer into the captcha input field yourself' };
  }
  return { type: 'unknown', solved: false };
}

module.exports = {
  // Audio (Whisper)
  transcribe: audio.transcribe,
  transcribeUrl: audio.transcribeUrl,
  // OCR (Tesseract)
  ocrBuffer: ocr.recognizeBuffer,
  ocrUrl: ocr.recognizeUrl,
  ocrElement: ocr.recognizeElement,
  // Math
  solveMath: math.safeEvalMath,
  extractMath: math.extractAndSolve,
  // reCAPTCHA v2
  solveRecaptchaV2: recaptcha.solveRecaptchaV2,
  // Turnstile
  clickTurnstile: turnstile.clickTurnstile,
  waitForTurnstileToken: turnstile.waitForToken,
  solveTurnstile: turnstile.solveTurnstile,
  solveTurnstileViaSelfHosted: turnstile.solveViaSelfHosted,
  readTurnstileSitekey: turnstile.readSitekey,
  clearChallenge: turnstile.clearChallenge,
  clearChallengeAndAdoptCookies: turnstile.clearChallengeAndAdoptCookies,
  turnstileSolverUrl: turnstile.solverUrl,
  // Mouse (exposed for general use)
  humanMove: mouse.humanMove,
  humanClick: mouse.humanClick,
  humanMoveAndClick: mouse.humanMoveAndClick,
  // Cookie jar
  saveCookies: cookies.saveCookies,
  loadCookies: cookies.loadCookies,
  clearCookies: cookies.clearCookies,
  // Top-level dispatcher
  autoSolve,
};

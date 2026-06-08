// reCAPTCHA v2 audio-fallback flow.
//
// Strategy: click checkbox → if image challenge appears, switch to audio
// challenge → download audio → transcribe with Whisper → submit answer.
//
// Returns true on success, false otherwise. Throws nothing.

const audio = require('./audio');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findFrame(page, predicate) {
  return page.frames().find((f) => {
    const u = f.url() || '';
    return predicate(u);
  });
}

async function solveRecaptchaV2(page, opts = {}) {
  const { timeout = 60000, attempts = 3 } = opts;
  const deadline = Date.now() + timeout;

  // 1) The checkbox (anchor) iframe — click it to start the challenge
  const anchor = findFrame(page, (u) => u.includes('/recaptcha/api2/anchor') || u.includes('/recaptcha/enterprise/anchor'));
  if (!anchor) return false;
  try {
    const cb = anchor.locator('#recaptcha-anchor');
    await cb.click({ timeout: 5000 });
  } catch {
    return false;
  }
  await sleep(1500);

  // 2) Wait for the bframe (challenge popup); if no popup, checkbox alone passed.
  let bframe = null;
  for (let i = 0; i < 10 && !bframe; i++) {
    bframe = findFrame(page, (u) => u.includes('/recaptcha/api2/bframe') || u.includes('/recaptcha/enterprise/bframe'));
    if (!bframe) await sleep(500);
  }
  if (!bframe) {
    // Token might already be set
    const ok = await page.evaluate(() => {
      const t = document.getElementById('g-recaptcha-response');
      return !!(t && t.value);
    });
    return ok;
  }

  // 3) Switch to audio challenge
  try {
    await bframe.locator('#recaptcha-audio-button').click({ timeout: 5000 });
  } catch {
    return false;
  }
  await sleep(1500);

  // Detect "automated requests" lockout
  const locked = await bframe
    .locator('text=/automated queries|try again later/i')
    .first()
    .isVisible({ timeout: 1000 })
    .catch(() => false);
  if (locked) return false;

  for (let i = 0; i < attempts && Date.now() < deadline; i++) {
    // 4) Get audio source URL
    const src = await bframe
      .locator('audio#audio-source, .rc-audiochallenge-tdownload-link')
      .first()
      .getAttribute('href')
      .catch(() => null) ||
      await bframe.locator('audio#audio-source').first().getAttribute('src').catch(() => null);
    if (!src) return false;

    // 5) Transcribe via local Whisper
    let answer = '';
    try {
      answer = (await audio.transcribeUrl(page, src)).trim().toLowerCase();
    } catch {
      return false;
    }
    if (!answer) continue;

    // 6) Type the answer + verify
    try {
      const input = bframe.locator('#audio-response');
      await input.fill('');
      await input.type(answer, { delay: 60 + Math.random() * 60 });
      await bframe.locator('#recaptcha-verify-button').click();
    } catch {
      return false;
    }
    await sleep(2500);

    // 7) Check if solved
    const solved = await page.evaluate(() => {
      const t = document.getElementById('g-recaptcha-response');
      return !!(t && t.value);
    });
    if (solved) return true;

    // If wrong, reCAPTCHA may show "Multiple solutions required" or refresh — loop.
    const errVisible = await bframe
      .locator('text=/incorrect|try again/i')
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (errVisible) {
      try { await bframe.locator('#recaptcha-reload-button').click({ timeout: 1500 }); } catch {}
      await sleep(1500);
    }
  }
  return false;
}

module.exports = { solveRecaptchaV2 };

// Text/image CAPTCHA solver — Tesseract.js running locally.
// Best fit: simple text-in-image CAPTCHAs. Trained data is pre-downloaded
// at build time to /app/tesseract-data.

let _workerPromise = null;

async function getWorker() {
  if (_workerPromise) return _workerPromise;
  _workerPromise = (async () => {
    const { createWorker } = require('tesseract.js');
    const worker = await createWorker('eng', 1, {
      langPath: process.env.TESSDATA_PREFIX || '/app/tesseract-data',
      cachePath: process.env.TESSDATA_PREFIX || '/app/tesseract-data',
      gzip: false,
    });
    await worker.setParameters({
      // Most CAPTCHAs are 4-8 chars; treat as a single line.
      tessedit_pageseg_mode: 7,
      // Restrict to alphanumerics — fewer hallucinations.
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    });
    return worker;
  })();
  return _workerPromise;
}

async function recognizeBuffer(imageBuffer) {
  const w = await getWorker();
  const { data } = await w.recognize(imageBuffer);
  return (data?.text || '').replace(/\s+/g, '').trim();
}

async function recognizeUrl(page, url) {
  const buf = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    if (!r.ok) throw new Error('image fetch failed: ' + r.status);
    const ab = await r.arrayBuffer();
    return Array.from(new Uint8Array(ab));
  }, url);
  return recognizeBuffer(Buffer.from(buf));
}

async function recognizeElement(page, selector) {
  const buf = await page.locator(selector).first().screenshot();
  return recognizeBuffer(buf);
}

module.exports = { recognizeBuffer, recognizeUrl, recognizeElement, getWorker };

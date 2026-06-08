// Audio CAPTCHA solver — Whisper running locally via @huggingface/transformers.
// No API key, no external service. Model files are pre-downloaded at build time.
//
// Best fit: reCAPTCHA v2 audio fallback (English).

let _pipePromise = null;

async function getPipeline() {
  if (_pipePromise) return _pipePromise;
  _pipePromise = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    // Cache + offline-friendly defaults
    env.allowLocalModels = true;
    env.cacheDir = process.env.TRANSFORMERS_CACHE || '/app/.cache/transformers';
    // whisper-tiny.en is fast, English-only, ~40MB. Good for reCAPTCHA.
    const model = process.env.WHISPER_MODEL || 'Xenova/whisper-tiny.en';
    return pipeline('automatic-speech-recognition', model, {
      quantized: true,
    });
  })();
  return _pipePromise;
}

// Transcribe an audio buffer (Uint8Array or Buffer) → text.
async function transcribe(audioBuffer) {
  const pipe = await getPipeline();
  // The pipeline accepts a URL, a Buffer, or a Float32Array. Buffer is simplest.
  const result = await pipe(new Uint8Array(audioBuffer), {
    chunk_length_s: 30,
    stride_length_s: 5,
  });
  return (result?.text || '').trim();
}

// Convenience: download the URL with the page's auth cookies & transcribe.
async function transcribeUrl(page, url) {
  const buf = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    if (!r.ok) throw new Error('audio fetch failed: ' + r.status);
    const ab = await r.arrayBuffer();
    return Array.from(new Uint8Array(ab));
  }, url);
  return transcribe(Buffer.from(buf));
}

module.exports = { transcribe, transcribeUrl, getPipeline };

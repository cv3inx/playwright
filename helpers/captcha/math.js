// Math CAPTCHA solver — extract a math expression from text and evaluate it
// safely (no eval; only +, -, *, /, parens, digits).

function safeEvalMath(expr) {
  if (typeof expr !== 'string') return null;
  // Normalize common surface forms
  const s = expr
    .replace(/[×x]/gi, '*')
    .replace(/÷/g, '/')
    .replace(/[—–−]/g, '-')
    .replace(/[^\d+\-*/().\s]/g, '');
  if (!s.trim()) return null;
  // eslint-disable-next-line no-new-func
  try { return Function(`"use strict"; return (${s});`)(); }
  catch { return null; }
}

// Pull the first math expression out of free text.
function extractAndSolve(text) {
  if (!text) return null;
  const m = String(text).match(/(\d+(?:\s*[+\-*/×÷]\s*\d+)+)/);
  if (!m) return null;
  return safeEvalMath(m[1]);
}

module.exports = { safeEvalMath, extractAndSolve };

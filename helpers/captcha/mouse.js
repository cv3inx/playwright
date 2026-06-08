// Human-like mouse movement: bezier curve with jitter + variable step delays.
// Used by turnstile.js and exported for any code that wants natural cursor paths.

function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function humanMove(page, fromX, fromY, toX, toY, opts = {}) {
  const { steps = 25, jitter = 4, baseDelayMs = 8 } = opts;
  // Two control points slightly off the straight line — gives a curved path
  const dx = toX - fromX;
  const dy = toY - fromY;
  const c1 = {
    x: fromX + dx * 0.3 + (Math.random() - 0.5) * 80,
    y: fromY + dy * 0.3 + (Math.random() - 0.5) * 80,
  };
  const c2 = {
    x: fromX + dx * 0.7 + (Math.random() - 0.5) * 80,
    y: fromY + dy * 0.7 + (Math.random() - 0.5) * 80,
  };
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = bezier({ x: fromX, y: fromY }, c1, c2, { x: toX, y: toY }, t);
    const jx = (Math.random() - 0.5) * jitter;
    const jy = (Math.random() - 0.5) * jitter;
    await page.mouse.move(p.x + jx, p.y + jy);
    await sleep(baseDelayMs + Math.random() * 12);
  }
}

async function humanClick(page, x, y, opts = {}) {
  const { holdMs = 60 + Math.random() * 80 } = opts;
  await page.mouse.move(x + (Math.random() - 0.5) * 2, y + (Math.random() - 0.5) * 2);
  await sleep(80 + Math.random() * 120);
  await page.mouse.down();
  await sleep(holdMs);
  await page.mouse.up();
}

// Move from current position (or center if unknown) to (x,y) and click
async function humanMoveAndClick(page, x, y, opts = {}) {
  const cur = page._lastMousePos || { x: 200, y: 200 };
  await humanMove(page, cur.x, cur.y, x, y, opts);
  await humanClick(page, x, y, opts);
  page._lastMousePos = { x, y };
}

module.exports = { humanMove, humanClick, humanMoveAndClick };

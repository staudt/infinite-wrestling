// Character colors must be told apart at a glance on a dark background, so colors are
// picked greedily: each new character gets the palette color farthest from every color
// already in use.

/** Bright, well-separated colors for a dark background (crew colors are excluded). */
export const PALETTE = [
  '#ff4d4d', '#ff9f1c', '#ffe14f', '#a3e635', '#22c55e', '#2dd4bf', '#38bdf8', '#6b8cff',
  '#b388ff', '#f062f5', '#ff6fb5', '#ffa38a', '#c08a4a', '#7cfc9f', '#00e5ff', '#ff7f50',
  '#e6ff7a', '#c77dff', '#ffc2e2', '#5eead4', '#fb923c', '#d9f99d', '#8b5cf6', '#f43f5e',
];

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** "Redmean" perceptual approximation of the distance between two colors (0..~765). */
export function colorDistance(a: string, b: string): number {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const rm = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

/** Below this, two characters are too easy to confuse. */
export const MIN_DISTANCE = 110;

/** The palette color farthest from all `used` colors (ties go to palette order). */
export function farthestColor(used: string[], palette: string[] = PALETTE): string {
  let best = palette[0];
  let bestD = -1;
  for (const c of palette) {
    const d = used.length ? Math.min(...used.map((u) => colorDistance(c, u))) : Infinity;
    if (d > bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** Keep `color` if it is distinct enough from `used`, otherwise pick a better one. */
export function distinctColor(color: string, used: string[]): string {
  const close = used.some((u) => colorDistance(color, u) < MIN_DISTANCE);
  return close ? farthestColor(used) : color;
}

/**
 * tests/contrast.test.ts — WCAG AA contrast for the supporting-text tokens.
 *
 * The UX audit found --steel (#608ACD) at 2.84:1 on paper. A later darkening
 * (#5b6ba8) cleared plain paper by 0.01 but still failed on vellum, ice and the
 * top of the page gradient. This computes every normal-text pairing from the
 * live CSS so a palette edit cannot quietly regress it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CSS } from '../src/views';

const token = (name: string): string => {
  const m = CSS.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(m, `token --${name} is a hex colour`);
  return m![1]!;
};

const rgb = (hex: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** An rgba() overlay composited onto an opaque background. */
const over = (fg: [number, number, number], alpha: number, bg: string): string =>
  '#' + rgb(bg).map((b, i) => Math.round(fg[i]! * alpha + b * (1 - alpha)).toString(16).padStart(2, '0')).join('');

const lum = (hex: string) => {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** Every light surface supporting text sits on, including composited washes. */
function lightSurfaces(): Record<string, string> {
  const paper = token('paper');
  return {
    paper,
    'paper (top gradient)': over([18, 48, 184], 0.07, paper),
    vellum: token('vellum'),
    card: token('card'),
    ice: token('ice'),
    'accent wash on card': over([18, 48, 184], 0.08, token('card')),
    'notice warn': '#fff8e7',
    'notice good': '#eef7f2',
    'pill queued': over([96, 138, 205], 0.1, token('card')),
  };
}

for (const name of ['steel', 'muted']) {
  test(`--${name} meets 4.5:1 on every light surface`, () => {
    const fg = token(name);
    for (const [surface, bg] of Object.entries(lightSurfaces())) {
      const r = ratio(fg, bg);
      assert.ok(r >= 4.5, `--${name} ${fg} on ${surface} ${bg} is ${r.toFixed(2)}:1`);
    }
  });
}

test('the header external link stays readable on hover over the dark header', () => {
  // The dark-chrome skin must restate the hover, or the earlier light-skin rule
  // (color:var(--seros)) wins on specificity and paints navy on navy.
  assert.match(CSS, /nav\.app-nav a\.ext-link:hover\{color:#fff/);
  const header = over(rgb(token('night')), 0.96, token('paper'));
  assert.ok(ratio('#ffffff', header) >= 4.5);
  assert.ok(ratio(token('accent-dim'), header) >= 4.5);
});

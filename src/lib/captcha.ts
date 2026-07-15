import { readFileSync } from "node:fs";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { CAPTCHA_CHARSET } from "./verification-logic";

// Safe charset: 0/O/1/I/L are already gone, and for each remaining look-alike
// digit/letter pair (2/Z, 5/S, 6/G, 8/B) we drop the digit and keep the letter,
// so a rotated glyph can't be misread as the other member of the pair. Shared with
// isCodeShaped so "is this a code?" uses the exact same alphabet the renderer draws.
const CHARSET = CAPTCHA_CHARSET;

// Assets are resolved relative to THIS module, not the process cwd, so the bot
// renders regardless of the working directory it is launched from (systemd,
// Docker, `bun test` from a subdir, …).
const FONT_URL = new URL("../../assets/captcha-font.ttf", import.meta.url);
const WASM_URL = new URL("../../node_modules/@resvg/resvg-wasm/index_bg.wasm", import.meta.url);

let wasmReady: Promise<void> | null = null;
export function ensureWasm(): Promise<void> {
  if (!wasmReady) wasmReady = initWasm(readFileSync(WASM_URL));
  return wasmReady;
}

let fontBuffer: Buffer | null = null;
function font(): Buffer {
  if (!fontBuffer) fontBuffer = readFileSync(FONT_URL);
  return fontBuffer;
}

// Uniform pick from CHARSET via rejection sampling. A plain `byte % len` skews
// toward the first `256 % len` glyphs; rejecting bytes at/above the largest
// multiple of len keeps every character equally likely.
export function generateCode(length = 6): string {
  const limit = 256 - (256 % CHARSET.length);
  const buf = new Uint8Array(1);
  let out = "";
  while (out.length < length) {
    crypto.getRandomValues(buf);
    const b = buf[0]!;
    if (b < limit) out += CHARSET[b % CHARSET.length]!;
  }
  return out;
}

// Difficulty 1 (easiest) … 5 (brutal). Higher levels overlap the glyphs more,
// warp them harder (rotation/skew/scale), ride a taller sine baseline, and lay
// more same-colour strokes through the text — all aimed at breaking the free
// per-glyph segmentation that makes clean captchas trivial to OCR.
export type CaptchaDifficulty = 1 | 2 | 3 | 4 | 5;
interface Profile {
  rot: number; // ± per-glyph rotation (deg)
  skew: number; // ± per-glyph horizontal skew (deg)
  overlap: number; // fraction of a glyph's advance that neighbours overlap
  wave: number; // sine-baseline amplitude (px)
  scaleVar: number; // ± non-uniform per-glyph scale
  occlude: number; // thick same-colour strokes drawn through the text
  back: number; // faint background scribbles
}
const PROFILES: Record<CaptchaDifficulty, Profile> = {
  1: { rot: 8, skew: 4, overlap: 0.02, wave: 4, scaleVar: 0.08, occlude: 1, back: 4 },
  2: { rot: 12, skew: 9, overlap: 0.09, wave: 6, scaleVar: 0.12, occlude: 1, back: 6 },
  3: { rot: 17, skew: 13, overlap: 0.16, wave: 8, scaleVar: 0.17, occlude: 2, back: 8 },
  4: { rot: 22, skew: 18, overlap: 0.22, wave: 10, scaleVar: 0.22, occlude: 2, back: 9 },
  5: { rot: 27, skew: 23, overlap: 0.28, wave: 12, scaleVar: 0.27, occlude: 3, back: 10 },
};

const LEFT = 30;
const STEP_MAX = 36; // upper-bound advance used for the canvas width
const RIGHT_PAD = 30;
const HEIGHT = 100;
const FONT_SIZE = 46;

// Canvas width grows with the code length (configurable up to 8) so glyphs never
// clip off the right edge. It's an UPPER bound — glyphs are overlapped and centred
// inside it, so extra room is just margin that absorbs rotation/skew overflow.
export function captchaWidth(length: number): number {
  return LEFT + length * STEP_MAX + RIGHT_PAD;
}

function buildSvg(code: string, difficulty: CaptchaDifficulty): string {
  const p = PROFILES[difficulty];
  const w = captchaWidth(code.length);
  const h = HEIGHT;
  const rand = () => Math.random();
  const jit = (amp: number) => rand() * 2 * amp - amp;
  // A light grey with per-element lightness jitter; glyphs AND the occlusion strokes
  // draw from the same range so a solver can't key on colour to separate them.
  const grey = () => {
    const v = (200 + Math.floor(rand() * 48)).toString(16);
    return `#${v}${v}${v}`;
  };

  const advance = FONT_SIZE * 0.6;
  const step = advance * (1 - p.overlap);
  const contentW = (code.length - 1) * step + advance;
  const startX = (w - contentW) / 2;
  const midY = h * 0.6;
  const phase = rand() * Math.PI * 2;

  let back = "";
  for (let i = 0; i < p.back; i++) {
    back += `<line x1="${(rand() * w).toFixed(0)}" y1="${(rand() * h).toFixed(0)}" x2="${(rand() * w).toFixed(0)}" y2="${(rand() * h).toFixed(0)}" stroke="#6b6b6b" stroke-width="1" opacity="0.5"/>`;
  }

  let chars = "";
  for (let i = 0; i < code.length; i++) {
    const x = startX + i * step + jit(2);
    const y = midY + Math.sin(phase + i * 0.9) * p.wave + jit(2);
    const rot = jit(p.rot);
    const skew = jit(p.skew);
    const sx = (1 + jit(p.scaleVar)).toFixed(2);
    const sy = (1 + jit(p.scaleVar)).toFixed(2);
    chars += `<text x="0" y="0" font-family="CaptchaFont" font-size="${FONT_SIZE}" font-weight="bold" fill="${grey()}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot.toFixed(1)}) skewX(${skew.toFixed(1)}) scale(${sx} ${sy})">${code[i]}</text>`;
  }

  // Occlusion: medium strokes in the glyph colour that snake across the text band,
  // so they touch/cross the letters and merge with them — this is what actually
  // defeats naive segmentation, far more than the old faint lines behind the text.
  let front = "";
  for (let i = 0; i < p.occlude; i++) {
    const y0 = midY - 22 + jit(12);
    const y1 = midY + jit(26);
    const y2 = midY + jit(26);
    const y3 = midY - 22 + jit(26);
    front += `<path d="M ${jit(6).toFixed(0)} ${y0.toFixed(0)} C ${(w * 0.33).toFixed(0)} ${y1.toFixed(0)}, ${(w * 0.66).toFixed(0)} ${y2.toFixed(0)}, ${(w + jit(6)).toFixed(0)} ${y3.toFixed(0)}" stroke="${grey()}" stroke-width="${(2 + rand() * 1.6).toFixed(1)}" fill="none" opacity="0.55"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#2b2d31"/>${back}${chars}${front}</svg>`;
}

export async function renderCaptcha(
  code: string,
  difficulty: CaptchaDifficulty = 3,
): Promise<Uint8Array> {
  await ensureWasm();
  const resvg = new Resvg(buildSvg(code, difficulty), {
    font: { fontBuffers: [font()], loadSystemFonts: false, defaultFontFamily: "CaptchaFont" },
    // Render at 2× so the image stays crisp when Discord upscales it on mobile / hi-DPI.
    fitTo: { mode: "zoom", value: 2 },
  });
  return resvg.render().asPng();
}

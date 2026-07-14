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

// Difficulty scales glyph rotation and interference-line counts (1 easiest …
// 3 hardest). Kept mild by default so legitimate humans on mobile can still read it.
export type CaptchaDifficulty = 1 | 2 | 3;
const PROFILES: Record<CaptchaDifficulty, { rot: number; backLines: number; frontLines: number }> = {
  1: { rot: 12, backLines: 4, frontLines: 1 },
  2: { rot: 16, backLines: 7, frontLines: 2 },
  3: { rot: 24, backLines: 10, frontLines: 3 },
};

const LEFT = 26;
const STEP = 34;
const RIGHT_PAD = 20;
const HEIGHT = 90;

// Canvas width grows with the code length so glyphs never clip off the right
// edge — the code length is configurable up to 8 and a fixed width silently
// cropped (and thus locked out) longer codes.
export function captchaWidth(length: number): number {
  return LEFT + length * STEP + RIGHT_PAD;
}

function buildSvg(code: string, difficulty: CaptchaDifficulty): string {
  const w = captchaWidth(code.length);
  const h = HEIGHT;
  const p = PROFILES[difficulty];
  const rand = () => Math.random();

  const line = (opacity: number, stroke: string) =>
    `<line x1="${(rand() * w).toFixed(0)}" y1="${(rand() * h).toFixed(0)}" x2="${(rand() * w).toFixed(0)}" y2="${(rand() * h).toFixed(0)}" stroke="${stroke}" stroke-width="1" opacity="${opacity}"/>`;

  // Faint background texture (behind the glyphs).
  let back = "";
  for (let i = 0; i < p.backLines; i++) back += line(0.5, "#7a7a7a");

  let chars = "";
  for (let i = 0; i < code.length; i++) {
    const x = LEFT + i * STEP;
    const y = 58 + (rand() * 16 - 8);
    const rot = rand() * 2 * p.rot - p.rot;
    // Jitter each glyph's lightness so a solver can't key on one fill value.
    const shade = (200 + Math.floor(rand() * 48)).toString(16).padStart(2, "0");
    chars += `<text x="${x}" y="${y}" font-family="CaptchaFont" font-size="44" font-weight="bold" fill="#${shade}${shade}${shade}" transform="rotate(${rot.toFixed(1)} ${x} ${y})">${code[i]}</text>`;
  }

  // Interference drawn ON TOP of the glyphs so it actually crosses them. The old
  // noise sat entirely behind the text and obscured nothing.
  let front = "";
  for (let i = 0; i < p.frontLines; i++) front += line(0.28, "#c8c8c8");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#2b2d31"/>${back}${chars}${front}</svg>`;
}

export async function renderCaptcha(
  code: string,
  difficulty: CaptchaDifficulty = 2,
): Promise<Uint8Array> {
  await ensureWasm();
  const resvg = new Resvg(buildSvg(code, difficulty), {
    font: { fontBuffers: [font()], loadSystemFonts: false, defaultFontFamily: "CaptchaFont" },
    // Render at 2× so the image stays crisp when Discord upscales it on mobile / hi-DPI.
    fitTo: { mode: "zoom", value: 2 },
  });
  return resvg.render().asPng();
}

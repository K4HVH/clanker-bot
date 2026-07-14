import { readFileSync } from "node:fs";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

const CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
const FONT_PATH = "./assets/captcha-font.ttf";

let wasmReady: Promise<void> | null = null;
function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm(readFileSync("node_modules/@resvg/resvg-wasm/index_bg.wasm"));
  }
  return wasmReady;
}

let fontBuffer: Buffer | null = null;
function font(): Buffer {
  if (!fontBuffer) fontBuffer = readFileSync(FONT_PATH);
  return fontBuffer;
}

export function generateCode(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CHARSET[b % CHARSET.length];
  return out;
}

function buildSvg(code: string): string {
  const w = 240;
  const h = 90;
  const rand = () => Math.random();
  let chars = "";
  for (let i = 0; i < code.length; i++) {
    const x = 26 + i * 34;
    const y = 58 + (rand() * 16 - 8);
    const rot = rand() * 40 - 20;
    chars += `<text x="${x}" y="${y}" font-family="CaptchaFont" font-size="44" font-weight="bold" fill="#e6e6e6" transform="rotate(${rot.toFixed(1)} ${x} ${y})">${code[i]}</text>`;
  }
  let noise = "";
  for (let i = 0; i < 7; i++) {
    noise += `<line x1="${(rand() * w).toFixed(0)}" y1="${(rand() * h).toFixed(0)}" x2="${(rand() * w).toFixed(0)}" y2="${(rand() * h).toFixed(0)}" stroke="#7a7a7a" stroke-width="1" opacity="0.5"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#2b2d31"/>${noise}${chars}</svg>`;
}

export async function renderCaptcha(code: string): Promise<Uint8Array> {
  await ensureWasm();
  const resvg = new Resvg(buildSvg(code), {
    font: { fontBuffers: [font()], loadSystemFonts: false, defaultFontFamily: "CaptchaFont" },
  });
  return resvg.render().asPng();
}

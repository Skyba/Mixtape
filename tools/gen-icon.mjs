// Generates the Mixtape app icons from inline SVG. Run: node tools/gen-icon.mjs
// Requires: npm install sharp --no-save
import { writeFileSync } from "node:fs";
import sharp from "sharp";

// A clean cassette-tape mark. `bg` toggles the filled background (legacy icon)
// vs transparent (adaptive foreground).
function cassetteSvg({ bg }) {
  const background = bg
    ? `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0" stop-color="#1f2937"/><stop offset="1" stop-color="#0b0d12"/>
       </linearGradient></defs>
       <rect width="1024" height="1024" fill="url(#g)"/>`
    : "";
  // Adaptive foreground keeps the cassette in the safe center; legacy fills more.
  const s = bg ? 1 : 0.78;
  const tx = bg ? 0 : 112;
  const ty = bg ? 0 : 112;
  return `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
    ${background}
    <g transform="translate(${tx},${ty}) scale(${s})">
      <rect x="160" y="300" width="704" height="468" rx="56" fill="#f8fafc"/>
      <!-- mixtape label stripes -->
      <path d="M160 356 a56 56 0 0 1 56 -56 h592 a56 56 0 0 1 56 56 v34 h-704 z" fill="#3b82f6"/>
      <rect x="160" y="390" width="704" height="26" fill="#ec4899"/>
      <rect x="160" y="416" width="704" height="22" fill="#f59e0b"/>
      <!-- window -->
      <rect x="226" y="470" width="572" height="180" rx="26" fill="#0f1115"/>
      <!-- reels -->
      <g>
        <circle cx="372" cy="560" r="66" fill="#11151c" stroke="#3b82f6" stroke-width="12"/>
        <circle cx="652" cy="560" r="66" fill="#11151c" stroke="#3b82f6" stroke-width="12"/>
        <circle cx="372" cy="560" r="18" fill="#3b82f6"/>
        <circle cx="652" cy="560" r="18" fill="#3b82f6"/>
      </g>
      <!-- spindle holes row -->
      <rect x="300" y="706" width="424" height="22" rx="11" fill="#cbd5e1"/>
    </g>
  </svg>`;
}

const full = Buffer.from(cassetteSvg({ bg: true }));
const fg = Buffer.from(cassetteSvg({ bg: false }));

await sharp(full).resize(1024, 1024).png().toFile("assets/icon.png");
await sharp(full).resize(1024, 1024).png().toFile("assets/splash-icon.png");
await sharp(fg).resize(1024, 1024).png().toFile("assets/adaptive-icon.png");
await sharp(full).resize(48, 48).png().toFile("assets/favicon.png");

console.log("icons written to assets/");

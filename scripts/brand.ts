// Draws Shebang's own art for the bank: the coin, the Slack app icon and the link-preview card.
// Run with `bun scripts/brand.ts`. It needs the JetBrains Mono font for the #! on the coin.
import sharp from "sharp"
import { mkdirSync } from "node:fs"

const MONO = "JetBrainsMono Nerd Font, JetBrains Mono, monospace"

/** A struck gold coin with #! on it, drawn in a 512 box so it can be placed and scaled anywhere. */
function coin(id: string) {
  const ticks = Array.from({ length: 72 }, (_, index) => {
    const angle = (index / 72) * Math.PI * 2
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)]
    return `<line x1="${256 + cos * 222}" y1="${256 + sin * 222}" x2="${256 + cos * 240}" y2="${256 + sin * 240}"/>`
  }).join("")
  return `
    <defs>
      <linearGradient id="${id}-face" x1="0.15" y1="0.05" x2="0.85" y2="0.95">
        <stop offset="0" stop-color="#ffe9a3"/><stop offset="0.45" stop-color="#f2bd3b"/><stop offset="1" stop-color="#b9780f"/>
      </linearGradient>
      <linearGradient id="${id}-well" x1="0.15" y1="0.05" x2="0.85" y2="0.95">
        <stop offset="0" stop-color="#d9981c"/><stop offset="0.55" stop-color="#f0b930"/><stop offset="1" stop-color="#ffdf85"/>
      </linearGradient>
      <linearGradient id="${id}-edge" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#c98a14"/><stop offset="1" stop-color="#7a4c06"/>
      </linearGradient>
    </defs>
    <ellipse cx="256" cy="282" rx="244" ry="244" fill="url(#${id}-edge)"/>
    <circle cx="256" cy="256" r="244" fill="url(#${id}-face)"/>
    <g stroke="#a86c0c" stroke-width="5" stroke-linecap="round" opacity="0.55">${ticks}</g>
    <circle cx="256" cy="256" r="204" fill="#9c6408"/>
    <circle cx="256" cy="259" r="198" fill="url(#${id}-well)"/>
    <g font-family="${MONO}" font-weight="700" font-style="normal" font-size="236" text-anchor="middle" letter-spacing="-14">
      <text x="250" y="346" fill="#ffe9a3">#!</text>
      <text x="256" y="338" fill="#7d4f06">#!</text>
      <text x="253" y="341" fill="#9a6509">#!</text>
    </g>`
}

const INK = "#101114"

const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><radialGradient id="glow" cx="0.5" cy="0.42" r="0.75"><stop offset="0" stop-color="#262a33"/><stop offset="1" stop-color="${INK}"/></radialGradient></defs>
  <rect width="1024" height="1024" fill="url(#glow)"/>
  <g transform="translate(152 140) scale(1.40625)">${coin("icon")}</g>
</svg>`

const card = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><radialGradient id="glow" cx="0.78" cy="0.5" r="0.7"><stop offset="0" stop-color="#2a2e38"/><stop offset="1" stop-color="${INK}"/></radialGradient></defs>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <g transform="translate(640 86) rotate(-8 220 220) scale(0.84)">${coin("back")}</g>
  <g transform="translate(724 138) scale(0.84)">${coin("front")}</g>
  <g font-family="${MONO}" font-style="normal" fill="#f4f1e8">
    <text x="84" y="252" font-size="132" font-weight="700" letter-spacing="-6">bank</text>
    <text x="88" y="322" font-size="38" font-weight="500" fill="#c9c5b8">a tiny currency</text>
    <text x="88" y="370" font-size="38" font-weight="500" fill="#c9c5b8">for our Slack</text>
    <text x="88" y="532" font-size="30" font-weight="500" fill="#f2bd3b">#! labs.shebang.se/bank</text>
  </g>
</svg>`

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 -14 512 540">${coin("favicon")}</svg>`

mkdirSync("art/shebang", { recursive: true })
for (const [svg, output, size] of [
  [icon, "art/shebang/app-icon.png", 1024],
  [card, "public/og.png", 1200],
  [favicon, "public/coin.png", 256],
] as const) {
  await sharp(Buffer.from(svg)).resize(size).png({ compressionLevel: 9 }).toFile(output)
  console.log(output)
}

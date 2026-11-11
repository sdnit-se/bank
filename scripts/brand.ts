// Draws the bank's art in Shebang's design system: the coin, the Slack app icon and the link-preview card.
// Run with `bun scripts/brand.ts`.
//
// The logo is art/shebang/logo.svg exactly as the brand manual supplies it, never redrawn or stretched. The colours
// and the flat, outlined, extruded shapes follow the manual too, and the type is Inter, which the app already ships.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const BURGUNDY = "#19000b"
const IVORY = "#f2eddf"
const YELLOW = "#ffdf80"
const RED = "#eb7254"
const BLUE = "#47adb2"

// Inter isn't installed system-wide, so point the renderer at the copy in node_modules before it starts.
const fonts = join(tmpdir(), "bank-fonts.conf")
writeFileSync(
  fonts,
  `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${resolve("node_modules/@opencode/ui/src/assets/fonts")}</dir><include ignore_missing="yes">/etc/fonts/fonts.conf</include></fontconfig>`,
)
// The renderer reads this from the environment it was started with, so start again with it set.
if (process.env.FONTCONFIG_FILE !== fonts) {
  const again = Bun.spawnSync([process.execPath, ...process.argv.slice(1)], {
    env: { ...process.env, FONTCONFIG_FILE: fonts },
    stdout: "inherit",
    stderr: "inherit",
  })
  process.exit(again.exitCode)
}
const { default: sharp } = await import("sharp")

const logo = `data:image/svg+xml;base64,${readFileSync("art/shebang/logo.svg").toString("base64")}`
/** The logo's own proportions: 235.42 wide to 190.42 tall. */
const LOGO = 190.42 / 235.42

/**
 * A coin seen face on: an ivory face inside a yellow rim, pushed out toward the bottom right the way the manual's
 * boxes are. The logo sits in the middle with clear space around it.
 */
function coin(cx: number, cy: number, r: number, edge: string) {
  const line = r * 0.03
  const depth = r * 0.16
  const wide = r * 1.02
  return `
    <line x1="${cx}" y1="${cy}" x2="${cx + depth}" y2="${cy + depth}" stroke="${BURGUNDY}" stroke-width="${2 * r + line}" stroke-linecap="round"/>
    <line x1="${cx}" y1="${cy}" x2="${cx + depth}" y2="${cy + depth}" stroke="${edge}" stroke-width="${2 * r - line}" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${YELLOW}" stroke="${BURGUNDY}" stroke-width="${line}"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 0.8}" fill="${IVORY}" stroke="${BURGUNDY}" stroke-width="${line * 0.8}"/>
    <image href="${logo}" x="${cx - wide / 2}" y="${cy - (wide * LOGO) / 2}" width="${wide}" height="${wide * LOGO}"/>`
}

/**
 * A temple-fronted bank, drawn the way the logo is: the front is seen straight on and everything else recedes up and
 * to the right at 45 degrees. That keeps the pediment flat, so the logo sits on it undistorted.
 */
function bank() {
  const LEFT = 107
  const GROUND = 884
  /** Where a point `x` across, `y` up and `z` back lands on the page. */
  const at = (x: number, y: number, z: number) => `${LEFT + x + z / 2},${GROUND - y - z / 2}`
  const face = (fill: string, ...points: [number, number, number][]) =>
    `<polygon points="${points.map((point) => at(...point)).join(" ")}" fill="${fill}"/>`
  /** A block: ivory front, yellow top, blue side, unless told otherwise. */
  const block = (x: [number, number], y: [number, number], z: [number, number], front = IVORY, top = YELLOW, side = BLUE) =>
    face(top, [x[0], y[1], z[0]], [x[1], y[1], z[0]], [x[1], y[1], z[1]], [x[0], y[1], z[1]]) +
    face(side, [x[1], y[0], z[0]], [x[1], y[1], z[0]], [x[1], y[1], z[1]], [x[1], y[0], z[1]]) +
    face(front, [x[0], y[0], z[0]], [x[1], y[0], z[0]], [x[1], y[1], z[0]], [x[0], y[1], z[0]])

  const column = (x: number) =>
    block([x - 9, x + 67], [68, 86], [35, 111]) + block([x, x + 58], [86, 300], [44, 102]) + block([x - 9, x + 67], [300, 318], [35, 111])

  // The pediment, and the largest the logo can be inside it with room on every side.
  const [eave, peak, front, back] = [362, 606, 8, 292]
  const [low, room] = [26, 26]
  const wide = (632 * (1 - low / (peak - eave)) - 2 * room) / (1 + (LOGO * 632) / (peak - eave))
  const [mx, my] = at(330, eave + low, front).split(",").map(Number) as [number, number]

  return `<g stroke="${BURGUNDY}" stroke-width="7" stroke-linejoin="round">
    ${block([0, 660], [0, 34], [0, 300])}
    ${block([30, 630], [34, 68], [22, 278])}
    ${block([90, 570], [68, 318], [120, 262], RED)}
    ${face(BURGUNDY, [268, 68, 120], [322, 68, 120], [322, 262, 120], [268, 262, 120])}
    ${[60, 221, 381, 542].map(column).join("")}
    ${block([36, 624], [318, 362], [30, 272])}
    ${face(YELLOW, [14, eave, front], [330, peak, front], [330, peak, back], [14, eave, back])}
    ${face(RED, [330, peak, front], [646, eave, front], [646, eave, back], [330, peak, back])}
    ${face(IVORY, [14, eave, front], [646, eave, front], [330, peak, front])}
  </g>
  <image href="${logo}" x="${mx - wide / 2}" y="${my - wide * LOGO}" width="${wide}" height="${wide * LOGO}"/>`
}

const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="${BURGUNDY}"/>
  <g transform="translate(512 512) scale(0.9) translate(-512 -512)">${bank()}</g>
</svg>`

const card = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${BURGUNDY}"/>
  ${coin(1010, 190, 150, BLUE)}
  ${coin(880, 372, 196, RED)}
  <g font-family="Inter" fill="${IVORY}">
    <text x="80" y="270" font-size="150" font-weight="700" letter-spacing="-4">BANK</text>
    <text x="84" y="344" font-size="40" font-weight="400">A tiny <tspan fill="${YELLOW}" font-weight="700">currency</tspan> for our Slack.</text>
    <text x="84" y="540" font-size="28" font-weight="700" fill="${RED}">labs.shebang.se/bank</text>
  </g>
</svg>`

// The favicon is the coin alone, with a little room for its edge.
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${coin(236, 236, 216, RED)}</svg>`

mkdirSync("art/shebang", { recursive: true })
for (const [svg, output, size] of [
  [icon, "art/shebang/app-icon.png", 1024],
  [card, "public/og.png", 1200],
  [favicon, "public/coin.png", 256],
] as const) {
  await sharp(Buffer.from(svg), { density: 144 }).resize(size).png({ compressionLevel: 9 }).toFile(output)
  console.log(output)
}

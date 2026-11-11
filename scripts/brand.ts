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
 * A temple-fronted bank in true isometric, the projection the manual's illustrations use: width runs down to the
 * right, depth down to the left, both at 30 degrees, and height straight up. Every block shows its top, its front
 * and its right side.
 */
function bank(size: number) {
  type Point = [x: number, y: number, z: number]
  const flat = ([x, y, z]: Point): [number, number] => [(x - z) * 0.866, (x + z) / 2 - y]
  const faces: { fill: string; points: Point[] }[] = []
  const face = (fill: string, ...points: Point[]) => void faces.push({ fill, points })
  /** A block: yellow on top, ivory in front, blue on the right, unless told otherwise. */
  const block = (x: [number, number], y: [number, number], z: [number, number], front = IVORY, right = BLUE, top = YELLOW) => {
    face(top, [x[0], y[1], z[0]], [x[1], y[1], z[0]], [x[1], y[1], z[1]], [x[0], y[1], z[1]])
    face(front, [x[0], y[0], z[1]], [x[1], y[0], z[1]], [x[1], y[1], z[1]], [x[0], y[1], z[1]])
    face(right, [x[1], y[0], z[0]], [x[1], y[0], z[1]], [x[1], y[1], z[1]], [x[1], y[1], z[0]])
  }

  // Two steps, the walls, four evenly spaced columns along the front, the beam they carry, and the roof.
  block([0, 420], [0, 30], [0, 340])
  block([22, 398], [30, 60], [22, 318])
  block([70, 350], [60, 278], [70, 250], RED, RED)
  for (const x of [36, 141.33, 246.67, 352]) {
    block([x - 6, x + 38], [60, 74], [268, 312])
    block([x, x + 32], [74, 264], [274, 306])
    block([x - 6, x + 38], [264, 278], [268, 312])
  }
  block([26, 394], [278, 312], [26, 314])
  const [eave, ridge, near, far] = [312, 438, 328, 12]
  // The roof is shallow enough that the far slope shows past the ridge as well.
  face(YELLOW, [12, eave, near], [210, ridge, near], [210, ridge, far], [12, eave, far])
  face(YELLOW, [210, ridge, near], [408, eave, near], [408, eave, far], [210, ridge, far])
  face(IVORY, [12, eave, near], [408, eave, near], [210, ridge, near])
  // A coin in the gable.
  face(RED, ...Array.from({ length: 48 }, (_, step): Point => {
    const angle = (step / 48) * Math.PI * 2
    return [210 + 27 * Math.cos(angle), eave + 46 + 27 * Math.sin(angle), near]
  }))

  // Centre the drawing on the page whatever its shape, leaving a margin.
  const all = faces.flatMap((item) => item.points.map(flat))
  const [left, right] = [Math.min(...all.map(([x]) => x)), Math.max(...all.map(([x]) => x))]
  const [top, bottom] = [Math.min(...all.map(([, y]) => y)), Math.max(...all.map(([, y]) => y))]
  const scale = (size * 0.66) / Math.max(right - left, bottom - top)
  const place = (point: Point) => {
    const [x, y] = flat(point)
    return `${(size / 2 + (x - (left + right) / 2) * scale).toFixed(1)},${(size / 2 + (y - (top + bottom) / 2) * scale).toFixed(1)}`
  }
  return `<g stroke="${BURGUNDY}" stroke-width="${(size / 1024) * 6}" stroke-linejoin="round">${faces
    .map((item) => `<polygon points="${item.points.map(place).join(" ")}" fill="${item.fill}"/>`)
    .join("")}</g>`
}

const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="${BURGUNDY}"/>
  ${bank(1024)}
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

mkdirSync("art/shebang", { recursive: true })
for (const [svg, output, size] of [
  [icon, "art/shebang/app-icon.png", 1024],
  [card, "public/og.png", 1200],
  // The browser tab shows the same bank as the bot.
  [icon, "public/icon.png", 256],
] as const) {
  await sharp(Buffer.from(svg), { density: 144 }).resize(size).png({ compressionLevel: 9 }).toFile(output)
  console.log(output)
}

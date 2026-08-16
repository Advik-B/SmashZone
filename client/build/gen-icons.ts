// One-off generator for the PWA icons: `bun run icons` from client/.
//
// The output PNGs are committed — this exists so the artwork can be changed in
// one place and regenerated, not to run on every build.  It renders the same
// wordmark the menu uses (Lilita One, the extruded pink of `.sz-title` in
// theme.css) through the Playwright Chromium the e2e suite already depends on.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const clientDir = new URL("..", import.meta.url).pathname;
const publicDir = join(clientDir, "public");
const outDir = join(publicDir, "icons");

const BG = "#0a0d1c";
const FACE = "#ef5878";
/** The `.sz-title` extrude, darkest last. */
const EXTRUDE = ["#c14663", "#8f3049", "#5e1f31"];

function fontFace(): string {
  const woff2 = readFileSync(join(publicDir, "assets/fonts/lilitaone-400-latin.woff2"));
  return `@font-face{font-family:"Lilita One";src:url(data:font/woff2;base64,${woff2.toString("base64")}) format("woff2");}`;
}

/**
 * @param scale 1 fills the tile; maskable icons shrink to clear the 20 % that
 *   Android may crop away.
 */
function svg(scale: number, font = "Lilita One"): string {
  const layers = [...EXTRUDE]
    .reverse()
    .map((c, i) => {
      const dy = (EXTRUDE.length - i) * 9;
      return `<text x="256" y="256" dy="${dy}" fill="${c}">SZ</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <radialGradient id="glow" cx="50%" cy="42%" r="62%">
      <stop offset="0%" stop-color="#2b3462"/>
      <stop offset="100%" stop-color="${BG}"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#glow)"/>
  <g transform="translate(256 256) rotate(-6) scale(${scale}) translate(-256 -256)"
     font-family="${font}" font-size="232" text-anchor="middle"
     dominant-baseline="central" letter-spacing="4">
    ${layers}
    <text x="256" y="256" fill="${FACE}">SZ</text>
  </g>
</svg>`;
}

const ICONS = [
  { file: "icon-192.png", size: 192, scale: 1 },
  { file: "icon-512.png", size: 512, scale: 1 },
  { file: "icon-512-maskable.png", size: 512, scale: 0.72 },
  // iOS never masks this one, and shows it on a light background.
  { file: "apple-touch-180.png", size: 180, scale: 0.88 },
  { file: "favicon-32.png", size: 32, scale: 1 },
];

function chromiumPath(): string | undefined {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const preinstalled = "/opt/pw-browsers/chromium";
  return existsSync(preinstalled) ? preinstalled : undefined;
}

const browser = await chromium.launch({ executablePath: chromiumPath() });
mkdirSync(outDir, { recursive: true });

for (const { file, size, scale } of ICONS) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>${fontFace()}html,body{margin:0;background:${BG}}svg{display:block;width:${size}px;height:${size}px}</style>${svg(scale)}`,
  );
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.screenshot({ path: join(outDir, file) });
  await page.close();
  console.log(`icons: ${file} (${size}×${size})`);
}

await browser.close();

// The SVG favicon scales to any tab density (the 32 px PNG covers browsers
// that want a raster). SVG favicons are rendered in a restricted mode, so it
// names a fallback stack rather than relying on a webfont it can't load.
writeFileSync(
  join(outDir, "favicon.svg"),
  svg(1, "Lilita One, Impact, Haettenschweiler, system-ui, sans-serif") + "\n",
);
console.log("icons: favicon.svg");

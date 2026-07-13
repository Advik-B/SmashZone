import { chromium, type Browser } from "playwright";
import { existsSync } from "node:fs";

let browser: Browser | null = null;

/**
 * Chromium binary resolution: explicit override → the preinstalled browser in
 * Claude/CI-style sandboxes → Playwright's own registry (works after a local
 * `bunx playwright install chromium`).
 */
function chromiumPath(): string | undefined {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const preinstalled = "/opt/pw-browsers/chromium";
  if (existsSync(preinstalled)) return preinstalled;
  return undefined;
}

export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({
      executablePath: chromiumPath(),
      args: [
        // All test traffic is localhost; keep any environment proxy out.
        "--no-proxy-server",
        // The game renders with WebGL (Three.js). Headless has no GPU; allow the
        // SwiftShader software path that stricter Chromium builds gate behind a
        // flag (default headless already provides it, so this is just a safety
        // net for CI images).
        "--enable-unsafe-swiftshader",
      ],
    });
  }
  return browser;
}

export async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  await b?.close();
}

import { describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { getBrowser } from "../helpers/browser";
import { createRoom, menuError } from "../helpers/game";

// This spec needs its own disposable server to SIGTERM, so it only runs when
// the orchestrator hands us the built binary path.
const bin = process.env.E2E_SERVER_BIN;
const PORT = process.env.E2E_RESTART_PORT ?? "8092";
const URL = `http://127.0.0.1:${PORT}`;

async function waitHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${URL}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(200);
  }
  throw new Error("private server never became healthy");
}

describe("server restart", () => {
  test.skipIf(!bin)("clients are told to rejoin when the server shuts down", async () => {
    let server: Subprocess | null = null;
    const browser = await getBrowser();
    const ctx = await browser.newContext({ baseURL: URL });
    try {
      server = Bun.spawn([bin!], {
        env: { ...process.env, PORT, RUST_LOG: "warn" },
        stdout: "ignore",
        stderr: "ignore",
      });
      await waitHealthy(30_000);

      await ctx.addInitScript(() => {
        localStorage.setItem("sz-input-mode", "keyboard");
        localStorage.setItem("sz-quality", "low");
        localStorage.setItem("sz-muted", "1");
        localStorage.setItem("sz-music-muted", "1");
      });
      const page = await ctx.newPage();
      await page.goto("/");
      await page.waitForSelector("#m-create", { timeout: 30_000 });
      await createRoom(page, "Ghost");

      // SIGTERM → the server notifies each room before exiting.
      server.kill("SIGTERM");
      expect((await menuError(page)).toLowerCase()).toMatch(/restart|rejoin/);
    } finally {
      await ctx.close();
      server?.kill("SIGKILL");
    }
  }, 60_000);
});

import { afterEach, describe, expect, test } from "bun:test";
import {
  closeGamePages,
  createRoom,
  joinRoom,
  myId,
  newGamePage,
  startMatch,
  waitPhase,
} from "../helpers/game";

afterEach(closeGamePages);

describe("hud & rendering", () => {
  test("HUD shows the room code and a ping reading", async () => {
    const { page } = await newGamePage({ name: "Hudson" });
    const code = await createRoom(page, "Hudson");
    expect(await page.textContent(".hud-room")).toContain(code);
    // Ping fills in after the first Pong (ping timer runs every 2 s).
    await page.waitForFunction(() => /\d+\s*ms/.test(document.querySelector("#h-ping")?.textContent ?? ""), undefined, {
      timeout: 8_000,
    });
    expect(await page.textContent("#h-ping")).toMatch(/\d+\s*ms/);
  });

  test("center title is populated during the countdown", async () => {
    const host = await newGamePage({ name: "Ceo" });
    const guest = await newGamePage({ name: "Emp" });
    const code = await createRoom(host.page, "Ceo");
    await joinRoom(guest.page, code, "Emp");
    await host.page.waitForFunction(() => document.querySelectorAll(".pcard").length === 2, undefined, {
      timeout: 15_000,
    });
    await startMatch(host.page);
    await waitPhase(host.page, "Countdown", 15_000);
    await host.page.waitForFunction(() => (document.querySelector("#h-title")?.textContent ?? "") !== "", undefined, {
      timeout: 5_000,
    });
    expect(((await host.page.textContent("#h-title")) ?? "").length).toBeGreaterThan(0);
    expect(await myId(host.page)).toBeGreaterThanOrEqual(0);
  });

  test("the 3D scene renders and animates", async () => {
    const { page } = await newGamePage({ name: "Pixel" });
    await createRoom(page, "Pixel");
    await page.waitForTimeout(500);
    const a = await page.screenshot();
    await page.waitForTimeout(600);
    const b = await page.screenshot();
    // A real rendered frame is far from blank, and the scene is animating.
    expect(a.length).toBeGreaterThan(15_000);
    expect(b.length).toBeGreaterThan(15_000);
    expect(Buffer.compare(a, b)).not.toBe(0);
  });
});

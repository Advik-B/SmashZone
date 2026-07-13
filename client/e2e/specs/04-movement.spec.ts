import { afterEach, describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import {
  closeGamePages,
  createRoom,
  myPos,
  newGamePage,
  setYaw,
  waitPhase,
} from "../helpers/game";

// Movement is predicted in the Lobby too (free-play while waiting), so these
// run with a single player and never need a match.
afterEach(closeGamePages);

/** Settle on the ground after spawn, return the resting y. */
async function groundY(page: Page): Promise<number> {
  await page.waitForTimeout(1200);
  return (await myPos(page)).y;
}

describe("movement", () => {
  test("running displaces the player", async () => {
    const { page } = await newGamePage({ name: "Runner" });
    await createRoom(page, "Runner");
    await waitPhase(page, "Lobby");
    await groundY(page);
    const before = await myPos(page);
    // Head toward the arena center-ish so we don't immediately fall off.
    await setYaw(page, Math.atan2(-before.x, -before.z));
    await page.keyboard.down("w");
    await page.waitForTimeout(1000);
    await page.keyboard.up("w");
    const after = await myPos(page);
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    expect(moved).toBeGreaterThan(3); // ~8 u/s; loose bound for 27 fps headless
  });

  test("jumping raises then lowers the player", async () => {
    const { page } = await newGamePage({ name: "Hopper" });
    await createRoom(page, "Hopper");
    await waitPhase(page, "Lobby");
    const ground = await groundY(page);
    await page.keyboard.press("Space");
    // Sample the peak over the next ~500 ms.
    let peak = ground;
    for (let i = 0; i < 10; i++) {
      peak = Math.max(peak, (await myPos(page)).y);
      await page.waitForTimeout(50);
    }
    expect(peak).toBeGreaterThan(ground + 1);
    // And comes back down.
    await page.waitForTimeout(1500);
    expect((await myPos(page)).y).toBeLessThan(peak - 0.5);
  });

  test("double jump reaches higher than the apex of a single jump", async () => {
    const { page } = await newGamePage({ name: "Doubler" });
    await createRoom(page, "Doubler");
    await waitPhase(page, "Lobby");
    const ground = await groundY(page);

    async function jumpPeak(second: boolean): Promise<number> {
      await page.keyboard.press("Space");
      let peak = ground;
      for (let i = 0; i < 6; i++) {
        peak = Math.max(peak, (await myPos(page)).y);
        await page.waitForTimeout(50);
        if (second && i === 2) await page.keyboard.press("Space"); // 2nd jump near apex
      }
      // let it land again
      for (let i = 0; i < 20; i++) {
        if ((await myPos(page)).y <= ground + 0.2) break;
        await page.waitForTimeout(50);
      }
      return peak;
    }

    const single = await jumpPeak(false);
    const double = await jumpPeak(true);
    expect(double).toBeGreaterThan(single + 0.5);
  });

  test("dashing covers more ground than a normal step", async () => {
    const { page } = await newGamePage({ name: "Dasher" });
    await createRoom(page, "Dasher");
    await waitPhase(page, "Lobby");
    await groundY(page);
    const before = await myPos(page);
    await setYaw(page, Math.atan2(-before.x, -before.z));
    // Dash: hold a direction and tap Shift; the burst is ~150 ms.
    await page.keyboard.down("w");
    await page.keyboard.press("Shift");
    await page.waitForTimeout(220);
    await page.keyboard.up("w");
    const after = await myPos(page);
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    expect(moved).toBeGreaterThan(2.5); // dash 22 u/s ≫ walk over the same window
  });
});

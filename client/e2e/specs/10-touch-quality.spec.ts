import { afterEach, describe, expect, test } from "bun:test";
import {
  closeGamePages,
  createRoom,
  myPos,
  newGamePage,
  startMatch,
  waitPhase,
} from "../helpers/game";

afterEach(closeGamePages);

describe("touch controls", () => {
  test("touch devices get on-screen controls", async () => {
    const { page } = await newGamePage({ name: "Thumb", touch: true });
    await createRoom(page, "Thumb");
    await waitPhase(page, "Lobby");
    await page.waitForSelector("#touch-controls", { state: "visible", timeout: 10_000 });
    expect(await page.locator("#touch-controls .tc-jump").count()).toBe(1);
  });

  test("the touch jump button gets the player airborne", async () => {
    const { page } = await newGamePage({ name: "Thumb", touch: true });
    await createRoom(page, "Thumb");
    await waitPhase(page, "Lobby");
    // Start a solo match so the lobby panel clears off the touch buttons.
    await startMatch(page);
    await waitPhase(page, "Playing", 15_000);
    await page.waitForSelector("#touch-controls", { state: "visible", timeout: 10_000 });
    await page.waitForTimeout(1000); // settle on the ground
    const ground = (await myPos(page)).y;
    await page.tap(".tc-jump");
    let peak = ground;
    for (let i = 0; i < 12; i++) {
      peak = Math.max(peak, (await myPos(page)).y);
      await page.waitForTimeout(50);
    }
    expect(peak).toBeGreaterThan(ground + 1);
  });
});

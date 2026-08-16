import { afterEach, describe, expect, test } from "bun:test";
import { closeGamePages, createRoom, newGamePage } from "../helpers/game";

/**
 * Fullscreen is the experience the PWA exists for, and most players never
 * install: they open a tab. So the Fullscreen API path is the one that has to
 * work.
 *
 * Not covered here: real browsers only honor `requestFullscreen` while the
 * click that triggered it is still the active user gesture, which is why
 * main.ts asks before its first `await`. Headless Chromium grants the request
 * with no gesture at all, so that ordering can't be asserted from a spec —
 * it needs a real browser.
 */
const isFullscreen = () => document.fullscreenElement !== null;

describe("fullscreen", () => {
  afterEach(async () => {
    await closeGamePages();
  });

  test("the menu button takes the game fullscreen and back", async () => {
    const { page } = await newGamePage({ name: "FS" });

    expect(await page.evaluate(isFullscreen)).toBe(false);

    await page.click("#m-fullscreen");
    await page.waitForFunction(() => document.fullscreenElement !== null, undefined, {
      timeout: 10_000,
    });
    // The preference sticks, so the next match starts fullscreen too.
    expect(await page.evaluate(() => localStorage.getItem("sz-fullscreen"))).toBe("1");

    await page.click("#m-fullscreen");
    await page.waitForFunction(() => document.fullscreenElement === null, undefined, {
      timeout: 10_000,
    });
    expect(await page.evaluate(() => localStorage.getItem("sz-fullscreen"))).toBe("0");
  });

  test("starting a match goes fullscreen", async () => {
    const { page } = await newGamePage({ name: "Host" });

    await createRoom(page, "Host");
    expect(await page.evaluate(isFullscreen)).toBe(true);
  });

  test("a player who turned fullscreen off is left alone", async () => {
    const { page, ctx } = await newGamePage({ name: "Windowed" });
    await ctx.addInitScript(() => localStorage.setItem("sz-fullscreen", "0"));
    await page.reload();
    await page.waitForSelector("#m-create", { timeout: 30_000 });

    await createRoom(page, "Windowed");
    expect(await page.evaluate(isFullscreen)).toBe(false);
  });
});

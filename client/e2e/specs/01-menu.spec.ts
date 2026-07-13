import { afterEach, describe, expect, test } from "bun:test";
import {
  closeGamePages,
  createRoom,
  joinRoom,
  menuError,
  newGamePage,
} from "../helpers/game";
import type { Page } from "playwright";

afterEach(closeGamePages);

async function setRange(page: Page, sel: string, value: number): Promise<void> {
  await page.$eval(
    sel,
    (el, v) => {
      (el as HTMLInputElement).value = String(v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    value,
  );
}

function ls(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), key);
}

describe("menu", () => {
  test("player name persists across reload", async () => {
    const { page } = await newGamePage();
    await createRoom(page, "Persisto");
    expect(await ls(page, "sz-name")).toBe("Persisto");
    await page.reload();
    await page.waitForSelector("#m-name");
    expect(await page.inputValue("#m-name")).toBe("Persisto");
  });

  test("first-join input-mode prompt appears and persists the choice", async () => {
    const { page } = await newGamePage({ inputMode: null });
    await page.fill("#m-name", "Chooser");
    await page.click("#m-create");
    // The prompt is appended on top of the menu before connecting.
    await page.waitForSelector(".mode-card[data-mode='keyboard']", { timeout: 10_000 });
    // A 250 ms guard swallows the click that opened the modal.
    await page.waitForTimeout(300);
    await page.click(".mode-card[data-mode='keyboard']");
    expect(await ls(page, "sz-input-mode")).toBe("keyboard");
    // Having chosen, the join proceeds into a room.
    await page.waitForSelector(".hud-room", { timeout: 20_000 });
  });

  test("settings persist audio + quality across reload", async () => {
    const { page } = await newGamePage({ seedAudio: false });
    await page.click("#m-settings");
    await page.waitForSelector("#set-vol");
    await setRange(page, "#set-vol", 30);
    await page.check("#set-mute");
    await setRange(page, "#set-mvol", 70);
    await page.check("#set-mmute");
    await page.click(".q-btn[data-q='medium']");

    expect(Number(await ls(page, "sz-volume"))).toBeCloseTo(0.3, 1);
    expect(await ls(page, "sz-muted")).toBe("1");
    expect(Number(await ls(page, "sz-music-vol"))).toBeCloseTo(0.7, 1);
    expect(await ls(page, "sz-music-muted")).toBe("1");
    expect(await ls(page, "sz-quality")).toBe("medium");

    // Reload and reopen: the modal reflects the saved values.
    await page.reload();
    await page.waitForSelector("#m-settings");
    await page.click("#m-settings");
    await page.waitForSelector("#set-vol");
    expect(await page.inputValue("#set-vol")).toBe("30");
    expect(await page.isChecked("#set-mute")).toBe(true);
  });

  test("quality preset click keeps the page alive", async () => {
    const { page, errors } = await newGamePage();
    await page.click("#m-settings");
    await page.waitForSelector(".q-btn[data-q='low']");
    await page.click(".q-btn[data-q='low']");
    expect(await ls(page, "sz-quality")).toBe("low");
    expect(errors).toEqual([]);
  });

  test("joining a nonexistent room surfaces an error", async () => {
    const { page } = await newGamePage();
    await page.fill("#m-name", "Lost");
    await page.fill("#m-code", "ZZZZ");
    await page.click("#m-join");
    expect((await menuError(page)).toLowerCase()).toContain("not found");
  });

  test("create then join by code lands both players in one lobby", async () => {
    const host = await newGamePage({ name: "Host" });
    const guest = await newGamePage({ name: "Guest" });
    const code = await createRoom(host.page, "Host");
    await joinRoom(guest.page, code, "Guest");
    for (const p of [host.page, guest.page]) {
      await p.waitForFunction(() => document.querySelectorAll(".pcard").length === 2, undefined, {
        timeout: 15_000,
      });
      expect(await p.locator(".pcard").count()).toBe(2);
    }
  });
});

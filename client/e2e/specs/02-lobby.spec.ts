import { afterEach, describe, expect, test } from "bun:test";
import {
  addBot,
  closeGamePages,
  createRoom,
  joinRoom,
  menuError,
  newGamePage,
} from "../helpers/game";

afterEach(closeGamePages);

describe("lobby", () => {
  test("player list shows the host star and share code", async () => {
    const host = await newGamePage({ name: "Star" });
    const guest = await newGamePage({ name: "Buddy" });
    const code = await createRoom(host.page, "Star");
    await joinRoom(guest.page, code, "Buddy");

    await host.page.waitForFunction(
      () => document.querySelectorAll(".pcard").length === 2,
      undefined,
      { timeout: 15_000 },
    );
    // Host card carries the ★; the lobby prompts you to share the code.
    const hostCard = await host.page.textContent(".pcard");
    expect(hostCard).toContain("★");
    const overlay = (await host.page.textContent("#h-overlay")) ?? "";
    expect(overlay).toContain(code);
    expect(overlay.toLowerCase()).toContain("share this code");
  });

  test("host can add bots across all five difficulty tiers", async () => {
    const { page } = await newGamePage({ name: "Coach" });
    await createRoom(page, "Coach");
    for (const diff of [0, 1, 2, 3, 4]) await addBot(page, diff);

    const tags = await page.$$eval(".bot-tag", (els) => els.map((e) => e.textContent ?? ""));
    expect(tags).toHaveLength(5);
    for (const tier of ["EASY", "MEDIUM", "HARD", "EXPERT", "IMPOSSIBLE"]) {
      expect(tags.some((t) => t.includes(tier))).toBe(true);
    }
  });

  test("host can remove a bot", async () => {
    const { page } = await newGamePage({ name: "Coach" });
    await createRoom(page, "Coach");
    await addBot(page, 2);
    expect(await page.locator(".pcard").count()).toBe(2);
    await page.click(".bot-x");
    await page.waitForFunction(() => document.querySelectorAll(".pcard").length === 1, undefined, {
      timeout: 10_000,
    });
    expect(await page.locator(".pcard").count()).toBe(1);
  });

  test("START MATCH shows for the host only", async () => {
    const host = await newGamePage({ name: "Boss" });
    const guest = await newGamePage({ name: "Peon" });
    const code = await createRoom(host.page, "Boss");
    await joinRoom(guest.page, code, "Peon");
    await guest.page.waitForFunction(
      () => document.querySelectorAll(".pcard").length === 2,
      undefined,
      { timeout: 15_000 },
    );
    expect(await host.page.locator("#h-start").count()).toBe(1);
    expect(await guest.page.locator("#h-start").count()).toBe(0);
  });

  test("a full room rejects an extra player", async () => {
    const host = await newGamePage({ name: "Full" });
    const code = await createRoom(host.page, "Full");
    // Host + 7 bots = 8 = maxPlayers.
    for (let i = 0; i < 7; i++) await addBot(host.page, 1);
    expect(await host.page.locator(".pcard").count()).toBe(8);

    const extra = await newGamePage({ name: "TooMany" });
    await extra.page.fill("#m-name", "TooMany");
    await extra.page.fill("#m-code", code);
    await extra.page.click("#m-join");
    expect((await menuError(extra.page)).toLowerCase()).toContain("full");
  });

  test("hostile player names are rendered as text, not markup", async () => {
    const host = await newGamePage({ name: "Safe" });
    const guest = await newGamePage({ name: "x", inputMode: "keyboard" });
    const code = await createRoom(host.page, "Safe");
    await joinRoom(guest.page, code, "<b>x");

    await host.page.waitForFunction(
      () => document.querySelectorAll(".pcard").length === 2,
      undefined,
      { timeout: 15_000 },
    );
    // The literal text is present; no injected <b> element exists.
    const overlay = (await host.page.textContent("#h-overlay")) ?? "";
    expect(overlay).toContain("<b>x");
    expect(await host.page.locator("#h-overlay b").count()).toBe(0);
  });
});

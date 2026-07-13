import { afterEach, describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import {
  closeGamePages,
  createRoom,
  joinRoom,
  newGamePage,
  recordEvents,
  startMatch,
  waitEvent,
  waitPhase,
  walkOffEdge,
  clearEvents,
} from "../helpers/game";

afterEach(closeGamePages);

// Two idle players; start a match and watch the authoritative event stream.
async function playingMatch(): Promise<{ host: Page; guest: Page }> {
  const host = await newGamePage({ name: "Isla" });
  const guest = await newGamePage({ name: "Reef" });
  const code = await createRoom(host.page, "Isla");
  await joinRoom(guest.page, code, "Reef");
  await host.page.waitForFunction(() => document.querySelectorAll(".pcard").length === 2, undefined, {
    timeout: 15_000,
  });
  await startMatch(host.page);
  await waitPhase(host.page, "Playing", 20_000);
  return { host: host.page, guest: guest.page };
}

describe("arena & pickups", () => {
  test("a weapon pickup spawns on an island", async () => {
    const { host } = await playingMatch();
    await recordEvents(host);
    // First pickup drops at 480 ticks (~8 s); give generous headroom.
    const ev = await waitEvent(host, "PickupSpawn", {}, 20_000);
    expect(ev.kind).toBeGreaterThanOrEqual(1); // Hammer..Bomb = 1..4
    expect(ev.kind).toBeLessThanOrEqual(4);
    // Islands sit out past the main platform.
    expect(Math.hypot(ev.pos[0], ev.pos[2])).toBeGreaterThan(6);
  }, 40_000);

  test("the arena warns then drops tiles as it shrinks", async () => {
    const { host, guest } = await playingMatch();
    await recordEvents(host);
    // Shrink starts at 1200 ticks (~20 s) with a 90-tick (~1.5 s) warning.
    const warn = await waitEvent(host, "TileWarn", {}, 40_000);
    const fall = await waitEvent(host, "TileFall", {}, 10_000);
    expect(typeof warn.tile).toBe("number");
    expect(typeof fall.tile).toBe("number");
    // End the round quickly rather than waiting it out.
    await recordEvents(guest);
    await clearEvents(guest);
    await walkOffEdge(guest);
  }, 70_000);
});

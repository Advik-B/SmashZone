import { afterEach, describe, expect, test } from "bun:test";
import {
  closeGamePages,
  createRoom,
  joinRoom,
  myId,
  newGamePage,
  startMatch,
  suicideRound,
} from "../helpers/game";

afterEach(closeGamePages);

describe("reconnection", () => {
  test("a dropped socket auto-reconnects and keeps the slot and score", async () => {
    const host = await newGamePage({ name: "Rock" });
    const guest = await newGamePage({ name: "Winner" });
    const code = await createRoom(host.page, "Rock");
    await joinRoom(guest.page, code, "Winner");
    await host.page.waitForFunction(() => document.querySelectorAll(".pcard").length === 2, undefined, {
      timeout: 15_000,
    });
    await startMatch(host.page);

    // Host rings out → guest wins a round and banks a point.
    await suicideRound(host.page, [host.page, guest.page]);
    await guest.page.waitForFunction(
      () => [...document.querySelectorAll("#h-scores .row b")].some((b) => Number(b.textContent) >= 1),
      undefined,
      { timeout: 15_000 },
    );
    const guestId = await myId(guest.page);

    // Watch for the "reconnecting…" notice, then sever the socket.
    await guest.page.evaluate(() => {
      const w = window as any;
      w.__sawReconnect = false;
      const el = document.getElementById("h-title");
      if (el) {
        new MutationObserver(() => {
          if ((el.textContent ?? "").toLowerCase().includes("reconnect")) w.__sawReconnect = true;
        }).observe(el, { childList: true, characterData: true, subtree: true });
      }
      w.__gc.conn.ws.close();
    });

    // The client shows it's reconnecting, then recovers on the same session.
    await guest.page.waitForFunction(() => (window as any).__sawReconnect === true, undefined, {
      timeout: 8_000,
    });
    await guest.page.waitForFunction(
      () => {
        const gc = (window as any).__gc;
        return gc?.conn?.ws?.readyState === 1 &&
          ["Lobby", "Countdown", "Playing", "RoundEnd", "MatchEnd"].includes(gc?.phase?.type);
      },
      undefined,
      { timeout: 15_000 },
    );

    expect(await myId(guest.page)).toBe(guestId); // same slot
    expect(await guest.page.textContent(".hud-room")).toContain(code);
    // Score survived the blip (client keeps lastScores; server keeps the slot).
    const maxWins = await guest.page.evaluate(() =>
      Math.max(0, ...[...document.querySelectorAll("#h-scores .row b")].map((b) => Number(b.textContent))),
    );
    expect(maxWins).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

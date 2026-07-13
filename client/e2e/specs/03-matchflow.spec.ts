import { afterEach, describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import {
  closeGamePages,
  createRoom,
  joinRoom,
  myId,
  newGamePage,
  scoreRows,
  startMatch,
  suicideRound,
  waitPhase,
} from "../helpers/game";

afterEach(closeGamePages);

/** Host + guest in a started match. Returns pages and the host's player id. */
async function startedMatch(): Promise<{ host: Page; guest: Page; hostId: number }> {
  const host = await newGamePage({ name: "Ace" });
  const guest = await newGamePage({ name: "Blue" });
  const code = await createRoom(host.page, "Ace");
  await joinRoom(guest.page, code, "Blue");
  await host.page.waitForFunction(
    () => document.querySelectorAll(".pcard").length === 2,
    undefined,
    { timeout: 15_000 },
  );
  await startMatch(host.page);
  return { host: host.page, guest: guest.page, hostId: await myId(host.page) };
}

describe("match flow", () => {
  test("countdown leads into play", async () => {
    const { host } = await startedMatch();
    await waitPhase(host, "Countdown", 15_000);
    // The countdown renders a center title (the "3/2/1/GO" ticker). It's
    // written by the render loop's next frame, not the phase change itself,
    // so wait for it rather than sampling once (slow CI runners can read the
    // DOM before the first countdown frame paints).
    await host.waitForFunction(
      () => (document.getElementById("h-title")?.textContent ?? "").length > 0,
      undefined,
      { timeout: 10_000, polling: 100 },
    );
    await waitPhase(host, "Playing", 15_000);
  });

  test("a round resolves to the survivor with a scored win and kill feed", async () => {
    const { host, guest, hostId } = await startedMatch();
    // Guest walks off the edge → host is last standing.
    const end = await suicideRound(guest, [host, guest]);
    expect(end.type).toBe("RoundEnd");
    expect(end.winner).toBe(hostId);

    // Solo fall shows in the host's kill feed.
    await host.waitForFunction(
      () => document.querySelectorAll("#h-feed .feed-line").length > 0,
      undefined,
      { timeout: 10_000 },
    );
    expect(((await host.textContent("#h-feed")) ?? "").toLowerCase()).toContain("fell");

    // Once the round-end pause settles, the host shows one win.
    await host.waitForFunction(
      () => {
        const rows = [...document.querySelectorAll("#h-scores .row b")];
        return rows.some((b) => Number(b.textContent) >= 1);
      },
      undefined,
      { timeout: 15_000 },
    );
    const rows = await scoreRows(host);
    expect(Math.max(...rows.map((r) => r.wins))).toBe(1);
  });

  test("first to three wins ends the match, and rematch resets the score", async () => {
    const { host, guest } = await startedMatch();
    // Guest loses three rounds; the win is scored at each RoundEnd.
    for (let round = 1; round <= 3; round++) {
      const end = await suicideRound(guest, [host, guest]);
      expect(end.type).toBe("RoundEnd");
    }
    // After the third round-end pause the room advances to MatchEnd.
    await waitPhase(host, "MatchEnd", 20_000);
    const winnerText = (await host.textContent("#h-overlay")) ?? "";
    expect(winnerText).toContain("Ace");
    expect(winnerText.toUpperCase()).toContain("WINS");

    // Host rematches → back to Countdown with scores wiped.
    await host.click("#h-rematch");
    await waitPhase(host, "Countdown", 15_000);
    const rows = await scoreRows(host);
    expect(Math.max(...rows.map((r) => r.wins))).toBe(0);
  });
});

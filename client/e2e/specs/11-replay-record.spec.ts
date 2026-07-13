// Match recording: every match auto-records client-side and lands in the
// IndexedDB replay library (window.__replayStore dev hook) at MatchEnd, or as
// a partial replay when the session ends mid-match.
import { afterEach, describe, expect, test } from "bun:test";
import {
  closeGamePages,
  createRoom,
  joinRoom,
  myId,
  newGamePage,
  startMatch,
  suicideRound,
  waitPhase,
} from "../helpers/game";
import { listReplays, waitReplayCount } from "../helpers/replay";

afterEach(closeGamePages);

describe("replay recording", () => {
  test("a finished match is saved with rounds, KO markers and the result", async () => {
    const host = await newGamePage({ name: "Alpha" });
    const loser = await newGamePage({ name: "Bravo" });
    const code = await createRoom(host.page, "Alpha");
    await joinRoom(loser.page, code, "Bravo");
    await host.page.waitForFunction(
      () => document.querySelectorAll(".pcard").length === 2,
      undefined,
      { timeout: 15_000 },
    );
    const alphaId = await myId(host.page);
    const bravoId = await myId(loser.page);
    await startMatch(host.page);

    // Bravo rings out three rounds in a row -> Alpha wins the match 3-0.
    // (The server always announces RoundEnd first; MatchEnd follows after the
    // round-end pause, so wait for it explicitly on both pages.)
    for (let round = 0; round < 3; round++) {
      const end = await suicideRound(loser.page, [host.page, loser.page]);
      expect(["RoundEnd", "MatchEnd"]).toContain(end.type);
    }
    await waitPhase(host.page, "MatchEnd", 20_000);
    await waitPhase(loser.page, "MatchEnd", 20_000);

    // Both clients recorded the match on their side.
    const [rep] = await waitReplayCount(host.page, 1);
    expect(rep.header.partial).toBe(false);
    expect(rep.header.joinedMidMatch).toBe(false);
    expect(rep.header.code).toBe(code);
    expect(rep.header.localPlayerId).toBe(alphaId);
    expect(rep.header.result?.winner).toBe(alphaId);
    expect(rep.header.endTick).toBeGreaterThan(rep.header.startTick);
    expect(rep.sizeBytes).toBeGreaterThan(1_000);
    expect(rep.header.players.map((p) => p.name).sort()).toEqual(["Alpha", "Bravo"]);

    // Three closed rounds, three KO markers, all Bravo's deaths.
    expect(rep.header.rounds.length).toBe(3);
    for (const r of rep.header.rounds) expect(r.endTick).not.toBeNull();
    const kos = rep.header.markers.filter((m) => m.kind === "ko");
    expect(kos.length).toBe(3);
    for (const ko of kos) expect(ko.player).toBe(bravoId);

    const [loserRep] = await waitReplayCount(loser.page, 1);
    expect(loserRep.header.localPlayerId).toBe(bravoId);
    expect(loserRep.header.result?.winner).toBe(alphaId);

    // Replays survive a reload (they live in IndexedDB, not memory).
    await host.page.goto("/");
    await host.page.waitForSelector("#m-create", { timeout: 30_000 });
    const persisted = await listReplays(host.page);
    expect(persisted.length).toBe(1);
    expect(persisted[0].id).toBe(rep.id);
  }, 170_000);

  test("leaving mid-match saves a partial replay", async () => {
    const host = await newGamePage({ name: "Alpha" });
    const other = await newGamePage({ name: "Bravo" });
    const code = await createRoom(host.page, "Alpha");
    await joinRoom(other.page, code, "Bravo");
    await host.page.waitForFunction(
      () => document.querySelectorAll(".pcard").length === 2,
      undefined,
      { timeout: 15_000 },
    );
    await startMatch(host.page);
    await waitPhase(host.page, "Playing", 30_000);
    // Countdown alone yields ~60 snapshots (> the recorder's keep threshold);
    // linger a moment into the round, then leave.
    await host.page.waitForTimeout(1_500);
    await host.page.evaluate(() => (window as any).__gc.destroy());

    const [rep] = await waitReplayCount(host.page, 1);
    expect(rep.header.partial).toBe(true);
    expect(rep.header.result).toBeNull();
    expect(rep.header.rounds.length).toBe(1);
    expect(rep.header.rounds[0].endTick).toBeNull();
  }, 90_000);
});

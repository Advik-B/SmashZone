import { afterEach, describe, expect, test } from "bun:test";
import {
  aliveIds,
  clearEvents,
  closeGamePages,
  createRoom,
  joinRoom,
  myId,
  newGamePage,
  phase,
  recordEvents,
  scoreRows,
  startMatch,
  waitPhase,
  walkOffEdge,
} from "../helpers/game";

afterEach(closeGamePages);

describe("spectating", () => {
  test("a knocked-out player keeps watching while the round continues", async () => {
    const host = await newGamePage({ name: "Alpha" });
    const g1 = await newGamePage({ name: "Bravo" });
    const g2 = await newGamePage({ name: "Charlie" });
    const code = await createRoom(host.page, "Alpha");
    await joinRoom(g1.page, code, "Bravo");
    await joinRoom(g2.page, code, "Charlie");
    await host.page.waitForFunction(() => document.querySelectorAll(".pcard").length === 3, undefined, {
      timeout: 15_000,
    });
    await startMatch(host.page);
    await waitPhase(host.page, "Playing", 20_000);

    const aId = await myId(host.page);
    const cId = await myId(g2.page);

    // Alpha rings out first.
    await recordEvents(host.page);
    await clearEvents(host.page);
    await walkOffEdge(host.page);

    // Alpha is out, but the round is still live and Alpha spectates.
    expect((await phase(host.page)).type).toBe("Playing");
    expect(await aliveIds(host.page)).not.toContain(aId);
    const alphaRow = (await scoreRows(host.page)).find((r) => r.name.includes("Alpha"));
    expect(alphaRow?.dead).toBe(true);

    // Bravo rings out too → Charlie is the last one standing.
    await recordEvents(g1.page);
    await clearEvents(g1.page);
    await walkOffEdge(g1.page);
    await waitPhase(host.page, "RoundEnd", 20_000);
    expect((await phase(host.page)).winner).toBe(cId);
  }, 90_000);
});

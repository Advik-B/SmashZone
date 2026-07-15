import { afterEach, describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import {
  approach,
  clearEvents,
  closeGamePages,
  createRoom,
  faceToward,
  joinRoom,
  myId,
  myPos,
  newGamePage,
  playerPos,
  recordEvents,
  tap,
  waitEvent,
  waitPhase,
  walkToCenter,
} from "../helpers/game";

afterEach(closeGamePages);

// Combat is enabled in the Lobby (free-play), so an attacker + an idle victim
// is all we need — no match, no RNG.
async function attackerAndVictim(): Promise<{
  a: Page;
  b: Page;
  aId: number;
  bId: number;
}> {
  const host = await newGamePage({ name: "Atk" });
  const guest = await newGamePage({ name: "Vic" });
  const code = await createRoom(host.page, "Atk");
  await joinRoom(guest.page, code, "Vic");
  await waitPhase(host.page, "Lobby");
  const bId = await myId(guest.page);
  // Both players present and the victim has a render position to walk toward.
  await host.page.waitForFunction(
    (id) => (window as any).__gc?.metas?.size >= 2 && !!(window as any).__gc?.renderer?.playerPos(id),
    bId,
    { timeout: 15_000 },
  );
  // Let spawn invulnerability (90 ticks ≈ 1.5 s) lapse before striking.
  await host.page.waitForTimeout(1800);
  const aId = await myId(host.page);
  // Stage the fight at arena center with the victim right next to the attacker:
  // A chasing B is the flaky part (cold-browser lag makes it overshoot), and a
  // central hit won't ring the victim out. Whiffs don't move a stationary
  // adjacent victim, so swinging until one lands is then deterministic.
  await walkToCenter(host.page);
  await approach(guest.page, aId, 1.1);
  return { a: host.page, b: guest.page, aId, bId };
}

/** Swing until a Hit by us on the (adjacent) victim is recorded. Facing and the
 *  button-edge happen in-page so facing is exact at the press (round-trip
 *  facing jitters under load); attacks are edge-triggered so we toggle the
 *  button each swing. */
async function landHit(a: Page, bId: number, key: "j" | "k"): Promise<any> {
  const bit = key === "k" ? 8 : 4; // BTN_HEAVY : BTN_LIGHT
  await recordEvents(a);
  await clearEvents(a);
  const hit = await a.evaluate(
    async ({ tid, bit }) => {
      const gc = (window as any).__gc;
      const input = (window as any).__input;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const mine = gc.myId;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const me = gc.renderer.playerPos(mine);
        const t = gc.renderer.playerPos(tid);
        if (me && t) input.camYaw = Math.atan2(t.x - me.x, t.z - me.z);
        input.touchPress(bit); // edge press
        await sleep(70);
        input.touchRelease(bit); // drop so the next press is a fresh edge
        const h = ((window as any).__events ?? []).find(
          (e: any) => e.type === "Hit" && e.target === tid && e.attacker === mine,
        );
        if (h) return h;
        await sleep(bit === 8 ? 300 : 180); // wait out the attack cycle
      }
      return null;
    },
    { tid: bId, bit },
  );
  if (!hit) throw new Error(`no ${key} hit landed on ${bId}`);
  return hit;
}

describe("combat", () => {
  test("a light attack lands 12 damage and shows on the victim HUD", async () => {
    const { a, b, bId } = await attackerAndVictim();
    const hit = await landHit(a, bId, "j");
    expect(hit.heavy).toBe(false);
    expect(hit.damage).toBe(12);
    await b.waitForFunction(() => (document.querySelector("#h-damage")?.textContent ?? "") !== "0%", undefined, {
      timeout: 5_000,
    });
    expect(await b.textContent("#h-damage")).toContain("12%");
  });

  test("a heavy attack lands 24 damage", async () => {
    const { a, bId } = await attackerAndVictim();
    const hit = await landHit(a, bId, "k");
    expect(hit.heavy).toBe(true);
    expect(hit.damage).toBe(24);
  });

  test("a hit knocks the victim back", async () => {
    const { a, b, bId } = await attackerAndVictim();
    const before = await myPos(b);
    await landHit(a, bId, "k");
    // Give the impulse a moment to move them.
    await a.waitForTimeout(400);
    const after = await myPos(b);
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    expect(moved).toBeGreaterThan(1);
  });

  test("consecutive hits build the combo counter", async () => {
    const { a, b, bId } = await attackerAndVictim();
    // Setup already centered the attacker with the victim adjacent; have the
    // victim keep marching in so it stays in reach after each light's knockback.
    const ap = await myPos(a);
    await faceToward(b, ap.x, ap.z);
    await b.keyboard.down("w");
    await recordEvents(a);
    // Attacker swings light in-page on clean press→release→press edges (attacks
    // are edge-triggered, so a held button fires only once) at the ~330 ms
    // attack cadence — fast and jitter-free. Two hits < 2.5 s apart → "N HITS".
    let res: { reached: boolean; hud: string };
    try {
      res = await a.evaluate(async (tid) => {
        const gc = (window as any).__gc;
        const input = (window as any).__input;
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        // Generous window: under the full parallel suite (16 files sharing the
        // CPU) the render/predict loop slows, so give the two combo hits room
        // to land. Well under the 120 s per-test timeout.
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const me = gc.renderer.playerPos(gc.myId);
          const t = gc.renderer.playerPos(tid);
          if (me && t) input.camYaw = Math.atan2(t.x - me.x, t.z - me.z);
          input.touchPress(4); // BTN_LIGHT edge
          await sleep(70);
          input.touchRelease(4); // drop it so the next press is a fresh edge
          await sleep(270); // wait out windup+active+recovery
          if (gc.combo >= 2) {
            return { reached: true, hud: document.querySelector("#h-combo")?.textContent ?? "" };
          }
        }
        return { reached: false, hud: document.querySelector("#h-combo")?.textContent ?? "" };
      }, bId);
    } finally {
      await b.keyboard.up("w");
    }
    expect(res.reached).toBe(true);
    expect(res.hud).toMatch(/HITS/);
  });

  test("an air-light attack lands 9 damage", async () => {
    const { a, bId } = await attackerAndVictim();
    const aId = await myId(a);
    await recordEvents(a);
    let landed: any = null;
    for (let attempt = 0; attempt < 14 && !landed; attempt++) {
      try {
        await approach(a, bId, 1.2);
      } catch {
        /* victim drifted; try again from wherever we are */
      }
      const bp = await playerPos(a, bId);
      if (bp) await faceToward(a, bp.x, bp.z);
      await clearEvents(a); // only look at this swing's hit
      await a.keyboard.press("Space");
      await a.waitForTimeout(110); // clearly airborne (apex ≈ 430 ms)
      await tap(a, "j", 60);
      try {
        const hit = await waitEvent(a, "Hit", { attacker: aId, target: bId }, 1000);
        // Air-light does 9; a grounded light (12) means we struck too late.
        if (hit.damage === 9) landed = hit;
      } catch {
        /* whiffed */
      }
      await a.waitForTimeout(350); // land before the next attempt
    }
    expect(landed).toBeTruthy();
    expect(landed.damage).toBe(9);
  });

  test("a ground slam emits a slam event", async () => {
    const { a } = await attackerAndVictim();
    const aId = await myId(a);
    await recordEvents(a);
    await clearEvents(a);
    let slam: any = null;
    for (let attempt = 0; attempt < 8 && !slam; attempt++) {
      await a.keyboard.press("Space");
      await a.waitForTimeout(130); // airborne
      await tap(a, "k", 80); // heavy while airborne = slam
      try {
        slam = await waitEvent(a, "Slam", { player: aId }, 1500);
      } catch {
        await a.waitForTimeout(300);
      }
    }
    expect(slam).toBeTruthy();
  });
});

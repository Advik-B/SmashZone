// Shared SimEvent -> feedback dispatcher: turns authoritative events into
// world VFX, SFX, kill-feed lines and camera juice. The live client and replay
// playback both route events through here; the ctx carries what differs
// between them (whose screen it is, whether sounds play, the ms timeline for
// kill credit) plus the live-only personal juice hooks (combo, hitstop,
// haptics) that replay leaves undefined.
//
// Tile events are deliberately not handled: both live play and replay drive
// tiles from the local sim's arena_apply_until, which emits identical events
// in sync with collision changes.

import * as THREE from "three";
import { sfx } from "./audio";
import { JUICE } from "./juice";
import { colorOf, esc } from "../ui/ui";
import { PU_BOMB, PU_GUN } from "../net/messages";
import type { GameEvent, PlayerMeta } from "../net/messages";
import type { Renderer } from "./renderer";

export type HitEvent = Extract<GameEvent, { type: "Hit" }>;

export interface EventFxCtx {
  renderer: Renderer;
  metas: Map<number, PlayerMeta>;
  /** Whose screen this is — gates involvement juice (shake, FOV kicks, flash
   *  intensity, KO haptics). Live: the local player; replay: the followed
   *  player, or null for a neutral camera. */
  localId: number | null;
  /** Suppress the Fired sound for this id. Live passes the local player (the
   *  button press already played it); replay passes null so every shot is
   *  audible. */
  firedSuppressId: number | null;
  /** Kill-feed credit bookkeeping (attacker of the last hit per victim). */
  lastHitBy: Map<number, { attacker: number; t: number }>;
  streaks: Map<number, number>;
  /** Timeline in ms for the 5 s kill-credit window. Live: performance.now();
   *  replay: playhead time, so credit survives pauses and speed changes. */
  now(): number;
  sfxOn: boolean;
  addFeed(html: string): void;
  flash(strength: number): void;
  /** Live-only combo bookkeeping; returns the hit-SFX pitch (1 = flat). */
  comboPitch?(ev: HitEvent): number;
  onHitstop?(ms: number): void;
  /** Live-only: the local player just died (combo break etc.). */
  onOwnDeath?(): void;
  haptic?(pattern: number | readonly number[]): void;
}

export function dispatchEventFx(ev: GameEvent, ctx: EventFxCtx): void {
  const r = ctx.renderer;
  switch (ev.type) {
    case "Hit": {
      r.flashPlayer(ev.target);
      const p = r.playerPos(ev.target);
      if (p) {
        r.effects.impactBurst(p, ev.dir, ev.heavy, ev.damage);
        r.effects.spawnFlash(
          new THREE.Vector3(p.x, p.y + 0.6, p.z),
          ev.heavy ? 1.5 : 0.9 + ev.damage * 0.01,
        );
        r.spawnDamage([p.x, p.y, p.z], ev.damage, ev.heavy);
      }
      const pitch = ctx.comboPitch?.(ev) ?? 1;
      if (ctx.sfxOn) {
        if (ev.heavy) sfx.hitHeavy(pitch);
        else sfx.hitLight(pitch);
      }
      // Feedback scales with the hit, gated on involvement.
      if (ev.target === ctx.localId) {
        r.shake(
          Math.min(
            JUICE.shake.takenMax,
            (ev.heavy ? JUICE.shake.takenHeavy : JUICE.shake.takenLight) +
              ev.damage * JUICE.shake.takenPerDamage,
          ),
        );
        if (ev.heavy) r.kickFov(JUICE.fov.takenHeavy);
        ctx.haptic?.(ev.heavy ? JUICE.haptics.hitHeavy : JUICE.haptics.hitLight);
      } else if (ev.attacker === ctx.localId) {
        r.shake(JUICE.shake.dealtBase + ev.damage * JUICE.shake.dealtPerDamage);
        if (ev.heavy) r.kickFov(JUICE.fov.dealtHeavy);
        ctx.haptic?.(JUICE.haptics.dealt);
      }
      // Kill-feed credit (valid 5 s) + hitstop for involved parties.
      ctx.lastHitBy.set(ev.target, { attacker: ev.attacker, t: ctx.now() });
      if (ev.target === ctx.localId || ev.attacker === ctx.localId) {
        ctx.onHitstop?.(
          ev.heavy
            ? Math.min(
                JUICE.hitstop.maxMs,
                JUICE.hitstop.heavyBaseMs + ev.damage * JUICE.hitstop.heavyPerDamage,
              )
            : JUICE.hitstop.lightMs,
        );
      }
      break;
    }
    case "Slam": {
      const p = r.playerPos(ev.player);
      if (p) r.effects.slamRing(p);
      if (ctx.sfxOn) sfx.slam();
      r.shake(JUICE.shake.slam);
      break;
    }
    case "Death": {
      const p = r.playerPos(ev.player);
      if (p && p.y > -30) {
        r.effects.deathBurst(p, r.playerColor(ev.player), ev.vel);
      }
      // "KO!" where they went out (wire pos; clamped up so it stays in view).
      r.spawnText(
        [ev.pos[0], Math.max(ev.pos[1], -6), ev.pos[2]],
        "KO!",
        JUICE.floater.koScale,
        JUICE.floater.koColor,
      );
      if (ctx.sfxOn) sfx.death();
      // Kill feed: credit the last attacker within 5 s, else a solo fall.
      const victim = esc(ctx.metas.get(ev.player)?.name ?? "?");
      const credit = ctx.lastHitBy.get(ev.player);
      const killer =
        credit && ctx.now() - credit.t < 5000 && credit.attacker !== ev.player
          ? credit.attacker
          : null;
      if (killer !== null) {
        const meta = ctx.metas.get(killer);
        const streak = (ctx.streaks.get(killer) ?? 0) + 1;
        ctx.streaks.set(killer, streak);
        const name = `<b style="color:${colorOf(meta?.slot ?? 0)}">${esc(meta?.name ?? "?")}</b>`;
        const spice =
          streak === 2
            ? ` <span class="feed-streak">double KO!</span>`
            : streak >= 3
              ? ` <span class="feed-streak">${streak} KO streak!</span>`
              : "";
        ctx.addFeed(`${name} knocked out ${victim}${spice}`);
      } else {
        ctx.addFeed(`${victim} fell`);
      }
      ctx.streaks.delete(ev.player); // dying ends the victim's streak
      ctx.lastHitBy.delete(ev.player);
      // KO spectacle: flash for everyone, freeze/kick only when involved.
      const involved = ev.player === ctx.localId || killer === ctx.localId;
      ctx.flash(involved ? 0.5 : 0.3);
      if (involved) {
        ctx.onHitstop?.(JUICE.hitstop.koMs);
        r.kickFov(JUICE.fov.ko);
        r.shake(JUICE.shake.ko);
      }
      if (ev.player === ctx.localId) {
        ctx.onOwnDeath?.();
        ctx.haptic?.(JUICE.haptics.death);
      } else if (killer === ctx.localId) {
        ctx.haptic?.(JUICE.haptics.kill);
      }
      break;
    }
    case "PickupSpawn": {
      if (ctx.sfxOn) sfx.pickupSpawn();
      const v = new THREE.Vector3(ev.pos[0], ev.pos[1], ev.pos[2]);
      r.effects.hitBurst(v, false);
      break;
    }
    case "PickupTaken": {
      if (ctx.sfxOn) sfx.pickup();
      const p = r.playerPos(ev.player);
      if (p) r.effects.hitBurst(p, false);
      break;
    }
    case "Fired": {
      if (ev.player !== ctx.firedSuppressId && ctx.sfxOn) {
        if (ev.kind === PU_GUN) sfx.shoot();
        else sfx.throwBomb();
      }
      break;
    }
    case "Explosion": {
      const v = new THREE.Vector3(ev.pos[0], ev.pos[1], ev.pos[2]);
      if (ev.kind === PU_BOMB) {
        r.effects.hitBurst(v, true);
        r.effects.slamRing(v);
        r.effects.spawnFlash(v, 2.2, 0xffb347);
        r.shake(JUICE.shake.explosion);
        r.kickFov(JUICE.fov.explosion);
        if (ctx.sfxOn) sfx.explosion();
      } else {
        r.effects.hitBurst(v, false);
      }
      break;
    }
    default:
      break; // tile events handled via local sim
  }
}

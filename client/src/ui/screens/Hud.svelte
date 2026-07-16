<script lang="ts">
  import {
    damage,
    damageColor,
    damageBump,
    ping,
    powerup,
    powerupColor,
    combo,
    comboBump,
    scores,
    hudCode,
    overlay,
  } from "../app/stores";
  import { retrigger } from "../app/actions";
  import Icon from "../components/Icon.svelte";
  import BotTag from "../components/BotTag.svelte";
  import ControlsHint from "../components/ControlsHint.svelte";
  import HudFx from "../components/HudFx.svelte";
  import Lobby from "./Lobby.svelte";
  import MatchEnd from "./MatchEnd.svelte";
  import { isTouchDevice, savedInputMode } from "../../game/input";

  const touch = isTouchDevice();
  const mode = savedInputMode();
</script>

<div class="hud">
  <HudFx />

  <div class="hud-room">
    <span>ROOM {$hudCode}</span>
    <span class="sep">·</span>
    <span class="wifi"><Icon name="wifi" size={14} /></span>
    <span id="h-ping">{$ping}</span>
  </div>

  <div class="hud-scores" id="h-scores">
    {#each $scores as s (s.id)}
      <div
        class="row"
        class:dead={s.dead}
        class:disconnected={s.disconnected}
        use:retrigger={{ cls: "bump", dep: s.wins }}
      >
        <div class="dot" style="background:{s.color}"></div>
        <span class="pname">{s.name}{#if s.disconnected}&nbsp;⟳{/if}</span>
        {#if s.bot}<BotTag difficulty={s.difficulty} size={12} />{/if}
        <b>{s.wins}</b>
      </div>
    {/each}
  </div>

  <div
    class="hud-damage"
    id="h-damage"
    style="color:{$damageColor}"
    use:retrigger={{ cls: "dmg-pop", dep: $damageBump }}
  >
    {$damage}
  </div>

  <div class="hud-powerup" id="h-powerup" style="color:{$powerupColor}">{$powerup}</div>

  <div class="hud-combo" id="h-combo" use:retrigger={{ cls: "combo-pop", dep: $comboBump }}>
    {$combo}
  </div>

  <div id="h-overlay">
    {#if $overlay.kind === "lobby"}
      <Lobby data={$overlay} />
    {:else if $overlay.kind === "matchend"}
      <MatchEnd data={$overlay} />
    {/if}
  </div>

  {#if !touch}
    <div class="controls-hint">
      <ControlsHint {mode} context="hud" touch={false} />
    </div>
  {/if}
</div>

<style>
  .wifi {
    color: #6fe08a;
    display: inline-flex;
  }
</style>

<script lang="ts">
  import type { Overlay } from "../app/stores";
  import Icon from "../components/Icon.svelte";
  import BotTag from "../components/BotTag.svelte";
  import Keycap from "../components/Keycap.svelte";

  let { data }: { data: Extract<Overlay, { kind: "matchend" }> } = $props();
  const initial = (n: string) => (n.trim()[0] ?? "?").toUpperCase();
</script>

<div class="sz-screen scrim end">
  <span class="trophy"><Icon name="trophy" size={46} /></span>
  <div class="code winner">{data.winnerName} WINS!</div>

  <div class="players">
    {#each data.players as p (p.id)}
      <div class="pcard">
        <div class="puck-wrap">
          <div class="puck" style="background:{p.color}">{initial(p.name)}</div>
          {#if p.best}<span class="crown"><Icon name="crown" size={18} /></span>{/if}
        </div>
        <span class="pname">{p.name}</span>
        {#if p.bot}<BotTag difficulty={p.difficulty} size={11} />{/if}
        <b>{p.wins}</b>
      </div>
    {/each}
  </div>

  <div class="btns">
    {#if data.onWatchReplay}
      <button id="h-replay" class="sz-btn" onclick={data.onWatchReplay}>
        <Icon name="replays" size={17} /><span>WATCH REPLAY</span>
      </button>
    {:else if data.onSaveReplayFile}
      <button
        id="h-replay-save"
        class="sz-btn"
        title="couldn't save to browser storage — download the file instead"
        onclick={data.onSaveReplayFile}
      >
        <Icon name="save" size={17} /><span>SAVE REPLAY FILE</span>
      </button>
    {/if}
    {#if data.isHost}
      <button id="h-rematch" class="sz-btn primary" onclick={data.onRematch}>
        <Icon name="refresh" size={17} /><span>REMATCH</span>
      </button>
    {/if}
  </div>

  {#if data.isHost}
    <div class="enter-hint"><Keycap k="Enter" /><span>rematch</span></div>
  {:else}
    <div class="hint">waiting for the host…</div>
  {/if}
</div>

<style>
  .end {
    gap: 12px;
  }
  .trophy {
    color: var(--gold);
    filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.5));
  }
  .winner {
    font: 400 58px/1 var(--font-display);
    letter-spacing: 2px;
    color: var(--gold);
    text-shadow: 0 3px 0 #8a6416, 0 6px 0 #533c0b, 0 9px 18px rgba(0, 0, 0, 0.55);
  }
  .players {
    display: flex;
    gap: 13px;
    margin: 16px 0;
    flex-wrap: wrap;
    justify-content: center;
    max-width: 80%;
  }
  .pcard {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 14px 18px;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-bottom: 3px solid var(--navy-btm);
    border-radius: 14px;
  }
  .puck-wrap {
    position: relative;
    margin-bottom: 2px;
  }
  .puck {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font: 400 22px/1 var(--font-display);
    color: #fff;
    text-shadow: 0 2px 3px rgba(0, 0, 0, 0.45);
    box-shadow: inset 0 -3px 6px rgba(0, 0, 0, 0.35);
  }
  .crown {
    position: absolute;
    top: -11px;
    right: -9px;
    transform: rotate(22deg);
    filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.5));
  }
  .pname {
    font: 700 15px var(--font-body);
  }
  .pcard b {
    font: 400 32px/1 var(--font-display);
    color: var(--gold);
  }
  .btns {
    display: flex;
    gap: 10px;
    justify-content: center;
  }
  .enter-hint {
    display: flex;
    align-items: center;
    gap: 7px;
    font: 600 12px var(--font-body);
    color: var(--dim);
  }
  .enter-hint :global(.kc) {
    height: 24px;
    filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.5));
  }
</style>

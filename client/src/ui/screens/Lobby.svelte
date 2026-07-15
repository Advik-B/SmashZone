<script lang="ts">
  import type { Overlay } from "../app/stores";
  import { lobbyCopied } from "../app/stores";
  import Icon from "../components/Icon.svelte";
  import BotTag from "../components/BotTag.svelte";
  import Keycap from "../components/Keycap.svelte";

  let { data }: { data: Extract<Overlay, { kind: "lobby" }> } = $props();

  const initial = (n: string) => (n.trim()[0] ?? "?").toUpperCase();
</script>

<div class="sz-screen scrim-soft lobby">
  <div class="sz-eyebrow dim">ROOM CODE — SHARE IT</div>
  <div class="code-row">
    <div class="code">{data.code}</div>
    <button
      class="sz-iconbtn"
      aria-label="copy room code"
      title="copy code"
      onclick={data.onCopyCode}
    >
      <Icon name="copy" size={17} />
    </button>
  </div>
  <div class="copied">{#if $lobbyCopied}copied!{/if}</div>

  <div class="players">
    {#each data.players as p (p.id)}
      <div class="pcard" class:host={p.host}>
        <div class="puck-wrap">
          <div class="puck" style="background:{p.color}">{initial(p.name)}</div>
          {#if p.host}<span class="crown"><Icon name="crown" size={20} /></span>{/if}
          {#if p.removable}
            <button
              class="bot-x"
              aria-label="remove bot"
              title="remove bot"
              onclick={() => data.onRemoveBot(p.id)}
            >
              <Icon name="close" size={11} />
            </button>
          {/if}
        </div>
        <div class="pname">{p.name}</div>
        {#if p.bot}<BotTag difficulty={p.difficulty} />{/if}
      </div>
    {/each}
  </div>

  {#if data.isHost}
    <button id="h-start" class="sz-btn primary big-btn" onclick={data.onStart}>START MATCH</button>
    <div class="enter-hint"><Keycap k="Enter" /><span>to start</span></div>
  {:else}
    <div class="hint">waiting for the host to start…</div>
  {/if}

  {#if data.canAddBot}
    <div class="addbot-row">
      <span class="addbot-label"><Icon name="plus" size={13} />ADD BOT</span>
      {#each data.botTiers as tier, i}
        <button
          class="bot-add diff-{i}"
          data-diff={i}
          id={i === 1 ? "h-addbot" : undefined}
          onclick={() => data.onAddBot(i)}
        >
          {tier}
        </button>
      {/each}
    </div>
  {/if}

  <div class="hint wide">
    you can run around and brawl while you wait — falling off just respawns you
  </div>
</div>

<style>
  .lobby {
    gap: 12px;
  }
  .dim {
    color: var(--dim);
    letter-spacing: 4px;
  }
  .code-row {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .code {
    font: 400 64px/1 var(--font-display);
    letter-spacing: 12px;
    color: var(--gold);
    text-shadow: 0 3px 0 #8a6416, 0 6px 0 #533c0b, 0 9px 18px rgba(0, 0, 0, 0.55);
    padding-left: 12px;
  }
  .copied {
    min-height: 16px;
    font: 600 12px var(--font-body);
    color: var(--pink-soft);
  }
  .players {
    display: flex;
    gap: 13px;
    margin: 10px 0 16px;
    flex-wrap: wrap;
    justify-content: center;
    max-width: 82%;
  }
  .pcard {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    padding: 14px 18px;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-bottom: 3px solid var(--navy-btm);
    border-radius: 14px;
  }
  .puck-wrap {
    position: relative;
    margin-bottom: 3px;
  }
  .puck {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font: 400 24px/1 var(--font-display);
    color: #fff;
    text-shadow: 0 2px 3px rgba(0, 0, 0, 0.45);
    box-shadow: inset 0 -3px 6px rgba(0, 0, 0, 0.35);
  }
  .crown {
    position: absolute;
    top: -12px;
    right: -10px;
    transform: rotate(22deg);
    filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.5));
  }
  .bot-x {
    position: absolute;
    top: -9px;
    right: -9px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 23px;
    height: 23px;
    padding: 0;
    border-radius: 50%;
    border: 1px solid var(--navy-border);
    background: var(--navy);
    color: var(--muted);
    cursor: pointer;
  }
  .bot-x:hover {
    background: #47243a;
    border-color: #7c3a52;
    color: var(--pink-soft);
  }
  .pname {
    font: 700 16px var(--font-body);
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
  .addbot-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .addbot-label {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font: 800 11px var(--font-body);
    letter-spacing: 1.5px;
    color: var(--dim);
  }
  .bot-add {
    font: 800 11px var(--font-body);
    letter-spacing: 0.5px;
    padding: 6px 11px;
    border-radius: 8px;
    border: 1px solid var(--navy-border);
    border-bottom: 2px solid var(--navy-btm);
    background: var(--navy);
    color: var(--ghost-text);
    cursor: pointer;
  }
  .bot-add:hover {
    background: var(--navy-hi);
  }
  .bot-add.diff-0 { color: #7ee0a6; }
  .bot-add.diff-1 { color: #9be8ff; }
  .bot-add.diff-2 { color: #ffe08a; }
  .bot-add.diff-3 { color: #ffb27a; }
  .bot-add.diff-4 { color: #ff8d9d; }
  .wide {
    max-width: 520px;
    text-align: center;
  }
  .big-btn {
    font-size: 24px;
    letter-spacing: 2px;
    padding: 16px 46px 15px;
  }
</style>

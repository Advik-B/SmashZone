<script lang="ts">
  import type { ReplayLibState } from "../app/stores";
  import Icon from "../components/Icon.svelte";

  let { data }: { data: ReplayLibState } = $props();
  let fileInput: HTMLInputElement;

  function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    if (f) data.onImport(f);
    input.value = ""; // let the same file be picked again
  }
</script>

<div class="sz-screen scrim lib">
  <div class="title">
    <span class="ico"><Icon name="replays" size={30} /></span>
    <div class="big">REPLAYS</div>
  </div>
  <div class="notice">{data.notice}</div>

  <div class="rl-list">
    {#each data.rows as r (r.id)}
      <div class="rl-row" data-id={r.id}>
        <div class="rl-info">
          <div class="rl-line1">
            <span>{r.line1}</span>
            {#if r.partial}<span class="rl-badge rl-partial">PARTIAL</span>{/if}
            {#if r.otherBuild}
              <span class="rl-badge rl-oldbuild" title={r.otherBuildTitle}>OTHER BUILD</span>
            {/if}
            {#if r.pinned}
              <span class="rl-badge rl-pinned"><Icon name="pin" size={10} />PINNED</span>
            {/if}
          </div>
          <div class="rl-line2">
            {#each r.chips as c}<span class="rl-chip" style="background:{c.color}"></span>{/each}
            {#if r.winner}
              <span class="rl-winner"><Icon name="trophy" size={12} /><span>{r.winner}</span></span>
            {/if}
          </div>
        </div>
        <div class="rl-actions">
          <button class="rl-watch" onclick={r.onWatch}>
            <Icon name="play" size={13} /><span>Watch</span>
          </button>
          <button
            class="rl-icon rl-pin"
            title={r.pinned ? "unpin" : "pin"}
            aria-label={r.pinned ? "unpin" : "pin"}
            onclick={r.onPin}
          >
            <Icon name={r.pinned ? "pin" : "pinoff"} size={15} />
          </button>
          <button
            class="rl-icon rl-save"
            title="download as .szr file"
            aria-label="save replay file"
            onclick={r.onSave}
          >
            <Icon name="save" size={15} />
          </button>
          <button
            class="rl-icon rl-del"
            title="delete replay"
            aria-label="delete replay"
            onclick={r.onDelete}
          >
            <Icon name="trash" size={15} />
          </button>
        </div>
      </div>
    {/each}
    {#if data.rows.length === 0}
      <div class="rl-empty">no replays yet — play a match and it records itself.</div>
    {/if}
  </div>

  <div class="foot">
    <button id="rl-back" class="sz-btn small" onclick={data.onBack}>
      <Icon name="back" size={14} /><span>Back</span>
    </button>
    <button class="sz-btn small rl-import" onclick={() => fileInput.click()}>
      <Icon name="save" size={14} /><span>Import .szr</span>
    </button>
    <input
      id="rl-file"
      bind:this={fileInput}
      type="file"
      accept=".szr"
      style="display:none"
      onchange={onFile}
    />
    <span class="hint store">{data.storageLine}</span>
  </div>
</div>

<style>
  .lib {
    gap: 10px;
    pointer-events: auto;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .title .ico {
    color: var(--title-pink);
  }
  .big {
    font: 400 44px/1 var(--font-display);
    letter-spacing: 2px;
    color: var(--title-pink);
    text-shadow: 0 2px 0 #c14663, 0 4px 0 #8f3049, 0 7px 14px rgba(0, 0, 0, 0.55);
  }
  .notice {
    min-height: 18px;
    font: 600 13px var(--font-body);
    color: var(--gold);
  }
  .rl-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(740px, 90vw);
    max-height: 56vh;
    overflow-y: auto;
    padding: 4px 6px;
    pointer-events: auto;
  }
  .rl-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    background: #141936;
    border: 1px solid var(--panel-border);
    border-bottom: 3px solid #0d1129;
    border-radius: 14px;
    padding: 12px 16px;
    text-align: left;
  }
  .rl-info {
    min-width: 0;
  }
  .rl-line1 {
    display: flex;
    align-items: center;
    gap: 7px;
    font: 600 14px var(--font-body);
    color: var(--ghost-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rl-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font: 800 10px var(--font-body);
    letter-spacing: 1px;
    padding: 3px 7px;
    border-radius: 5px;
    flex: none;
  }
  .rl-partial {
    background: #3a2a12;
    color: #ffcf8a;
  }
  .rl-oldbuild {
    background: #3a1c22;
    color: var(--pink-soft);
  }
  .rl-pinned {
    background: #1c3a4a;
    color: #9be8ff;
  }
  .rl-line2 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 7px;
  }
  .rl-chip {
    width: 14px;
    height: 14px;
    border-radius: 4px;
    flex: none;
  }
  .rl-winner {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font: 600 12px var(--font-body);
    color: var(--gold);
    margin-left: 3px;
  }
  .rl-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }
  .rl-watch {
    display: flex;
    align-items: center;
    gap: 6px;
    font: 800 13px var(--font-body);
    padding: 8px 13px;
    border-radius: 9px;
    border: 1px solid var(--pink-border);
    border-bottom: 3px solid var(--pink-border-btm);
    background: var(--pink);
    color: #fff;
    cursor: pointer;
  }
  .rl-watch:hover {
    background: var(--pink-hi);
  }
  .rl-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    padding: 0;
    border-radius: 9px;
    border: 1px solid var(--navy-border);
    border-bottom: 3px solid var(--navy-btm);
    background: var(--navy);
    color: var(--muted);
    cursor: pointer;
  }
  .rl-icon:hover {
    background: var(--navy-hi);
    color: var(--text);
  }
  .rl-del:hover {
    background: #47243a;
    border-color: #7c3a52;
    color: var(--pink-soft);
  }
  .rl-empty {
    text-align: center;
    line-height: 1.6;
    padding: 30px 0;
    color: var(--dim);
    font: 500 14px var(--font-body);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 8px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .small {
    font: 800 13px var(--font-body);
    padding: 9px 15px;
  }
  .store {
    color: var(--dim);
  }
</style>

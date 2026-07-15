<script lang="ts">
  import type { SettingsState } from "../app/stores";
  import type { InputMode } from "../../game/input";
  import type { Quality } from "../../game/quality";
  import Icon from "../components/Icon.svelte";
  import Keycap from "../components/Keycap.svelte";
  import { focusOnMount } from "../app/actions";

  let { data }: { data: SettingsState } = $props();

  const modes: InputMode[] = ["pointer", "keyboard"];
  const qualities: Quality[] = ["low", "medium", "high"];

  let vol = $state(Math.round(data.volume * 100));
  let muted = $state(data.muted);
  let mvol = $state(Math.round(data.musicVolume * 100));
  let mmuted = $state(data.musicMuted);
  let quality = $state<Quality>(data.quality);
  let record = $state(data.recordReplays);

  function pickMode(m: InputMode) {
    data.onPickMode(m);
    data.onClose();
  }
  function pickQuality(q: Quality) {
    quality = q;
    data.onQuality(q);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      data.onClose();
    }
  }
</script>

<div
  class="mode-modal"
  role="dialog"
  aria-modal="true"
  aria-label="Settings"
  tabindex="-1"
  use:focusOnMount
  onkeydown={onKey}
>
  <h2>SETTINGS</h2>

  {#if !data.touch}
    <div class="settings-section">
      <div class="sec-label">CONTROLS</div>
      <div class="mode-cards">
        {#each modes as m}
          <button
            class="mode-card"
            class:active={m === data.mode}
            data-mode={m}
            onclick={() => pickMode(m)}
          >
            <b>{m === "keyboard" ? "Keyboard + Trackpad" : "Keyboard + Mouse"}</b>
            <span>{m === "keyboard" ? "no mouse needed" : "aim with the mouse"}</span>
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="settings-section">
    <div class="sec-label"><Icon name="sound" size={14} /><span>AUDIO</span></div>
    <label class="settings-row">
      <span>sfx volume</span>
      <input
        id="set-vol"
        type="range"
        min="0"
        max="100"
        value={vol}
        oninput={(e) => {
          vol = +e.currentTarget.value;
          data.onVolume(vol / 100);
        }}
      />
    </label>
    <label class="settings-row">
      <span>sfx mute</span>
      <input
        id="set-mute"
        type="checkbox"
        checked={muted}
        onchange={(e) => {
          muted = e.currentTarget.checked;
          data.onMuted(muted);
        }}
      />
    </label>
    <label class="settings-row">
      <span><Icon name="music" size={14} /> music volume</span>
      <input
        id="set-mvol"
        type="range"
        min="0"
        max="100"
        value={mvol}
        oninput={(e) => {
          mvol = +e.currentTarget.value;
          data.onMusicVolume(mvol / 100);
        }}
      />
    </label>
    <label class="settings-row">
      <span>music mute</span>
      <input
        id="set-mmute"
        type="checkbox"
        checked={mmuted}
        onchange={(e) => {
          mmuted = e.currentTarget.checked;
          data.onMusicMuted(mmuted);
        }}
      />
    </label>
  </div>

  <div class="settings-section">
    <div class="sec-label">QUALITY</div>
    <div class="quality-cards">
      {#each qualities as q}
        <button class="q-btn" class:active={q === quality} data-q={q} onclick={() => pickQuality(q)}>
          {q}
        </button>
      {/each}
    </div>
  </div>

  <div class="settings-section">
    <div class="sec-label"><Icon name="replays" size={14} /><span>REPLAYS</span></div>
    <label class="settings-row">
      <span>auto-record matches</span>
      <input
        id="set-record"
        type="checkbox"
        checked={record}
        onchange={(e) => {
          record = e.currentTarget.checked;
          data.onRecordReplays(record);
        }}
      />
    </label>
  </div>

  <div class="close-row">
    <button class="sz-btn" onclick={data.onClose}>CLOSE</button>
    <span class="esc-hint"><Keycap k="Esc" /><span>to close</span></span>
  </div>
</div>

<style>
  .close-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .esc-hint {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font: 600 12px var(--font-body);
    color: var(--dim);
  }
  .esc-hint :global(.kc) {
    height: 22px;
    filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.5));
  }
  .sec-label :global(svg) {
    color: var(--dim);
  }
</style>

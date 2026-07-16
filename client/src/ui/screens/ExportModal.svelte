<script lang="ts">
  import type { ExportModalState } from "../app/stores";
  import { exExporting, exProgress, exStatus, exPreviewing, exPreviewTime, exNote } from "../app/stores";
  import Icon from "../components/Icon.svelte";
  import Keycap from "../components/Keycap.svelte";
  import { untrack } from "svelte";

  let { data }: { data: ExportModalState } = $props();

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  // Bounds + initial selection are fixed for the modal's lifetime; snapshot once.
  const init = untrack(() => ({
    start: data.startTick,
    end: data.endTick,
    inTick: data.inTick,
    outTick: data.outTick,
    name: data.defaultName,
    sel: Object.fromEntries(data.groups.map((g) => [g.key, g.initial])) as Record<string, string>,
  }));
  const total = Math.max(1, init.end - init.start);
  const pct = (tick: number) => ((clamp(tick, init.start, init.end) - init.start) / total) * 100;

  let inTick = $state(init.inTick);
  let outTick = $state(init.outTick);
  let name = $state(init.name);
  let sel = $state<Record<string, string>>(init.sel);

  let strip = $state<HTMLDivElement>();
  let dragging: "in" | "out" | null = null;

  function stripTick(e: PointerEvent): number {
    const r = strip!.getBoundingClientRect();
    const f = clamp((e.clientX - r.left) / r.width, 0, 1);
    return Math.round(init.start + f * total);
  }
  function onHandleDown(which: "in" | "out", e: PointerEvent) {
    e.stopPropagation();
    dragging = which;
  }
  function onMove(e: PointerEvent) {
    if (!dragging) return;
    const t = stripTick(e);
    if (dragging === "in") inTick = clamp(t, init.start, outTick - 1);
    else outTick = clamp(t, inTick + 1, init.end);
    data.onPreviewSeek(dragging === "in" ? inTick : outTick);
  }
  function onUp() {
    dragging = null;
  }
  function preset(inT: number, outT: number) {
    inTick = inT;
    outTick = outT;
    data.onPreviewSeek(inT);
  }
  function render() {
    data.onRender({
      camera: sel.camera,
      size: sel.size,
      fps: sel.fps,
      quality: sel.quality,
      sound: sel.sound,
      inTick,
      outTick,
      name,
    });
  }

  const summary = $derived(
    `${sel.size === "1080" ? "1080p" : "720p"} · ${sel.fps}fps · ${
      sel.quality === "high" ? "high quality" : "standard"
    } · ${sel.sound === "off" ? "muted" : "sound"} · ${data.durationLabel(inTick, outTick)}`,
  );
</script>

<svelte:window onpointermove={onMove} onpointerup={onUp} />

<div class="mode-modal rv-export-modal">
  <div class="ex-card">
    <div class="ex-head">
      <h2>EXPORT CLIP</h2>
      <span id="ex-dur" class="ex-dur">{data.durationLabel(inTick, outTick)}</span>
      <button
        id="ex-close"
        class="ex-x"
        title="close (esc)"
        aria-label="close"
        onclick={data.onClose}
      >
        <Icon name="close" size={18} />
      </button>
    </div>

    <div class="ex-preview">
      <canvas id="ex-prev" class="ex-prev"></canvas>
      <span id="ex-ptime" class="ex-ptime">{$exPreviewTime}</span>
      {#if !$exExporting}
        <button class="ex-play" title="play the selected range once" onclick={() => data.onPreviewToggle(inTick, outTick)}>
          {#if $exPreviewing}<Icon name="pause" size={16} />{:else}<Icon name="play" size={16} />{/if}
          <span>{$exPreviewing ? "Pause" : "Preview"}</span>
        </button>
      {/if}
    </div>

    {#if !$exExporting}
      <div class="ex-trim">
        <div class="ex-trim-head">
          <span class="sec-label">TRIM</span>
          <span class="ex-inout">in <b id="ex-tin">{data.tickLabel(inTick)}</b> · out <b id="ex-tout">{data.tickLabel(outTick)}</b></span>
        </div>
        <div id="ex-strip" class="ex-strip" bind:this={strip}>
          <div class="ex-strip-bg"></div>
          <div id="ex-sel" class="ex-sel" style="left:{pct(inTick)}%;width:{pct(outTick) - pct(inTick)}%"></div>
          {#each data.koPcts as p}<div class="ex-ko" title="KO" style="left:{p}%">✖</div>{/each}
          <button
            id="ex-in"
            class="ex-handle"
            aria-label="trim in"
            style="left:{pct(inTick)}%"
            onpointerdown={(e) => onHandleDown("in", e)}
          ></button>
          <button
            id="ex-out"
            class="ex-handle"
            aria-label="trim out"
            style="left:{pct(outTick)}%"
            onpointerdown={(e) => onHandleDown("out", e)}
          ></button>
        </div>
        <div class="ex-presets">
          {#each data.presets as p}
            <button class="ex-chip" onclick={() => preset(p.inTick, p.outTick)}>{p.label}</button>
          {/each}
        </div>
      </div>

      <div class="ex-groups">
        {#each data.groups as g}
          <div class="ex-group">
            <span class="sec-label">{g.label}</span>
            <div class="ex-opts">
              {#each g.options as o}
                <button
                  class="ex-opt"
                  class:active={sel[g.key] === o.value}
                  disabled={o.disabled}
                  title={o.title}
                  onclick={() => (sel[g.key] = o.value)}
                >
                  {o.label}
                </button>
              {/each}
            </div>
          </div>
        {/each}
      </div>

      <div class="ex-file">
        <span class="sec-label">FILE</span>
        <div class="ex-name">
          <input bind:value={name} spellcheck="false" />
          <span class="ex-ext">.mp4</span>
        </div>
        <span class="ex-summary">{summary}</span>
      </div>
    {:else}
      <div class="ex-progress">
        <div class="ex-bar"><div id="ex-fill" class="ex-fill" style="width:{$exProgress * 100}%"></div></div>
        <span id="ex-pct" class="ex-pct">{Math.round($exProgress * 100)}%</span>
        <span id="ex-sub" class="ex-sub">{$exStatus}</span>
      </div>
    {/if}

    {#if $exNote && !$exExporting}<div class="ex-note hint">{$exNote}</div>{/if}

    <div class="ex-foot">
      {#if !$exExporting}
        <button id="ex-start" class="sz-btn primary" disabled={!data.canExport} onclick={render}>
          RENDER CLIP
        </button>
      {/if}
      <button class="sz-btn" onclick={data.onClose}>{$exExporting ? "CANCEL" : "CLOSE"}</button>
    </div>
    <span class="esc-hint"><Keycap k="Esc" /><span>cancel / close</span></span>
  </div>
</div>

<style>
  .ex-card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: min(560px, 94vw);
    padding: 20px;
    background: #101429;
    border: 1px solid var(--panel-border);
    border-radius: 18px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
  }
  .ex-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .ex-head h2 {
    font: 400 28px/1 var(--font-display);
    letter-spacing: 1px;
  }
  .ex-dur {
    font: 700 12px var(--font-body);
    color: var(--gold);
    font-variant-numeric: tabular-nums;
  }
  .ex-x {
    margin-left: auto;
    display: inline-flex;
    padding: 6px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .ex-x:hover {
    background: #1a2044;
    color: var(--text);
  }
  .ex-preview {
    position: relative;
    aspect-ratio: 16 / 9;
    border-radius: 12px;
    overflow: hidden;
    background: #05070f;
    border: 1px solid var(--panel-border);
  }
  .ex-prev {
    width: 100%;
    height: 100%;
    display: block;
  }
  .ex-ptime {
    position: absolute;
    top: 8px;
    left: 10px;
    font: 700 12px var(--font-body);
    color: #fff;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
    font-variant-numeric: tabular-nums;
  }
  .ex-play {
    position: absolute;
    bottom: 10px;
    left: 50%;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    border-radius: 10px;
    border: 1px solid var(--navy-border);
    background: rgba(20, 25, 54, 0.9);
    color: var(--text);
    cursor: pointer;
    font: 800 12px var(--font-body);
  }
  .ex-play:hover {
    background: var(--navy-hi);
  }
  .ex-trim-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .ex-inout {
    font: 600 12px var(--font-body);
    color: var(--muted);
  }
  .ex-inout b {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .ex-strip {
    position: relative;
    height: 26px;
    touch-action: none;
    margin-bottom: 8px;
  }
  .ex-strip-bg {
    position: absolute;
    inset: 8px 0;
    border-radius: 5px;
    background: #0e1229;
    border: 1px solid var(--panel-border);
  }
  .ex-sel {
    position: absolute;
    top: 8px;
    bottom: 8px;
    background: rgba(239, 88, 120, 0.28);
    border-top: 1px solid var(--pink);
    border-bottom: 1px solid var(--pink);
  }
  .ex-ko {
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
    font-size: 9px;
    color: #ff8d9d;
    pointer-events: none;
  }
  .ex-handle {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 12px;
    margin-left: -6px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: ew-resize;
    touch-action: none;
  }
  .ex-handle::after {
    content: "";
    position: absolute;
    top: 2px;
    bottom: 2px;
    left: 50%;
    width: 6px;
    transform: translateX(-50%);
    border-radius: 3px;
    background: var(--pink);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  }
  .ex-presets {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .ex-chip {
    padding: 6px 11px;
    border-radius: 8px;
    border: 1px solid var(--navy-border);
    border-bottom: 2px solid var(--navy-btm);
    background: var(--navy);
    color: var(--ghost-text);
    cursor: pointer;
    font: 800 11px var(--font-body);
  }
  .ex-chip:hover {
    background: var(--navy-hi);
  }
  .ex-groups {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .ex-group {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .ex-opts {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
  }
  .ex-opt {
    flex: 1;
    padding: 7px 8px;
    border-radius: 8px;
    border: 1px solid var(--navy-border);
    background: var(--navy);
    color: var(--ghost-text);
    cursor: pointer;
    font: 700 11px var(--font-body);
    white-space: nowrap;
  }
  .ex-opt:hover:not(:disabled) {
    background: var(--navy-hi);
  }
  .ex-opt.active {
    background: var(--pink);
    border-color: var(--pink-border);
    color: #fff;
  }
  .ex-opt:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .ex-file {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .ex-name {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ex-name input {
    flex: 1;
    min-width: 0;
    padding: 9px 12px;
    border-radius: 9px;
    border: 1px solid var(--panel-border);
    background: var(--input-bg);
    color: var(--text);
    font: 600 13px var(--font-body);
    outline: none;
  }
  .ex-name input:focus {
    border-color: var(--pink);
  }
  .ex-ext {
    font: 700 13px var(--font-body);
    color: var(--muted);
  }
  .ex-summary {
    font: 600 12px var(--font-body);
    color: var(--dim);
  }
  .ex-progress {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    padding: 8px 0;
  }
  .ex-bar {
    flex: 1;
    min-width: 160px;
    height: 12px;
    border-radius: 6px;
    background: #0e1229;
    border: 1px solid var(--panel-border);
    overflow: hidden;
  }
  .ex-fill {
    height: 100%;
    background: linear-gradient(to right, #7a2740, var(--pink));
  }
  .ex-pct {
    font: 800 13px var(--font-body);
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .ex-sub {
    width: 100%;
    font: 600 12px var(--font-body);
    color: var(--muted);
  }
  .ex-note {
    text-align: center;
  }
  .ex-foot {
    display: flex;
    gap: 10px;
    justify-content: center;
  }
  .esc-hint {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font: 600 12px var(--font-body);
    color: var(--dim);
  }
  .esc-hint :global(.kc) {
    height: 20px;
    filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.5));
  }
</style>

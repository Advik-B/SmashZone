<script lang="ts">
  import type { ReplayViewerState } from "../app/stores";
  import { rvFill, rvTime, rvPlaying, rvSpeed, rvCam, rvFollowId } from "../app/stores";
  import Icon from "../components/Icon.svelte";
  import HudFx from "../components/HudFx.svelte";

  let { data }: { data: ReplayViewerState } = $props();

  const cams = [
    { mode: "follow", label: "FOLLOW" },
    { mode: "free", label: "FREE" },
    { mode: "playerview", label: "POV" },
  ] as const;

  let track: HTMLDivElement;
  let scrubbing = false;

  function frac(e: PointerEvent): number {
    const r = track.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  }
  function onDown(e: PointerEvent) {
    const t = e.target as HTMLElement;
    if (t.closest(".rv-chip") || t.closest(".rv-marker")) return; // those seek on click
    scrubbing = true;
    track.setPointerCapture(e.pointerId);
    data.onScrubStart();
    data.onScrubFrac(frac(e));
  }
  function onMove(e: PointerEvent) {
    if (scrubbing) data.onScrubFrac(frac(e));
  }
  function onUp(e: PointerEvent) {
    if (!scrubbing) return;
    scrubbing = false;
    data.onScrubFrac(frac(e));
    data.onScrubEnd();
  }
</script>

<div class="rv-screen">
  <HudFx />

  <div class="hud-room rv-room">
    <Icon name="replays" size={14} />
    <span>REPLAY · ROOM {data.code}{#if data.partial} · PARTIAL{/if}</span>
  </div>

  {#if data.buildMismatch}
    <div class="rv-warn">recorded on a different game build — playback may drift</div>
  {/if}

  <div class="rv-bar">
    <button id="rv-back" class="rv-ctl" onclick={data.onBack}>
      <Icon name="back" size={15} /><span>Library</span>
    </button>

    <div class="rv-main">
      <div
        class="rv-track"
        id="rv-track"
        role="slider"
        aria-label="scrub timeline"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={$rvFill}
        tabindex="0"
        bind:this={track}
        onpointerdown={onDown}
        onpointermove={onMove}
        onpointerup={onUp}
        onpointercancel={onUp}
      >
        <div class="rv-fill" id="rv-fill" style="width:{$rvFill}%"></div>
        {#each data.gaps as g}
          <div class="rv-gapmark" style="left:{g.leftPct}%;width:{g.widthPct}%"></div>
        {/each}
        {#each data.chips as c}
          <button
            class="rv-chip"
            data-tick={c.tick}
            style="left:{c.pct}%"
            onclick={(e) => {
              e.stopPropagation();
              data.onSeekTick(c.tick);
            }}>{c.label}</button>
        {/each}
        {#each data.markers as m}
          <button
            class="rv-marker mk-{m.kind}"
            data-tick={m.tick}
            title={m.title}
            style="left:{m.pct}%;--mk:{m.color}"
            onclick={(e) => {
              e.stopPropagation();
              data.onSeekTick(m.tick);
            }}>{m.glyph}</button>
        {/each}
        <div class="rv-head" id="rv-head" style="left:{$rvFill}%"></div>
      </div>

      <div class="rv-controls" id="rv-controls">
        <button id="rv-prev" class="rv-ctl" title="previous KO (p)" onclick={data.onPrevKO}>
          <Icon name="koPrev" size={16} /><span>KO</span>
        </button>
        <button
          id="rv-play"
          class="rv-ctl"
          title="play / pause (space)"
          aria-label="play / pause"
          onclick={data.onTogglePlay}
        >
          {#if $rvPlaying}<Icon name="pause" size={16} />{:else}<Icon name="play" size={16} />{/if}
        </button>
        <button id="rv-next" class="rv-ctl" title="next KO (n)" onclick={data.onNextKO}>
          <span>KO</span><Icon name="koNext" size={16} />
        </button>

        <div class="rv-speeds">
          {#each data.speeds as s}
            <button
              class="rv-speed"
              class:active={$rvSpeed === s}
              data-speed={s}
              onclick={() => data.onSpeed(s)}>{s}×</button>
          {/each}
        </div>

        <div class="rv-cams">
          {#each cams as c}
            <button
              class="rv-cam"
              class:active={$rvCam === c.mode}
              data-cam={c.mode}
              onclick={() => data.onCamera(c.mode)}>{c.label}</button>
          {/each}
        </div>

        <button id="rv-export" class="rv-ctl" title="export a video clip" onclick={data.onExport}>
          <Icon name="export" size={16} /><span>EXPORT</span>
        </button>

        <span id="rv-time" class="rv-time">{$rvTime}</span>

        <div class="rv-players">
          {#each data.players as p}
            <button
              class="rv-pchip"
              class:active={$rvFollowId === p.id}
              data-id={p.id}
              onclick={() => data.onFollow(p.id)}
            >
              <span class="dot" style="background:{p.color}"></span><span>{p.name}</span>
            </button>
          {/each}
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .rv-room {
    gap: 6px;
  }
  .rv-warn {
    position: absolute;
    top: 44px;
    right: 18px;
    font: 700 12px var(--font-body);
    color: #ffcf8a;
    background: rgba(58, 42, 18, 0.7);
    padding: 5px 10px;
    border-radius: 7px;
    pointer-events: none;
  }
  .rv-bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
    background: linear-gradient(to top, rgba(8, 11, 23, 0.96), rgba(8, 11, 23, 0.82) 70%, transparent);
    pointer-events: auto;
  }
  .rv-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .rv-track {
    position: relative;
    height: 20px;
    border-radius: 6px;
    background: #141936;
    border: 1px solid var(--panel-border);
    cursor: pointer;
    touch-action: none;
  }
  .rv-fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    background: linear-gradient(to right, #7a2740, var(--pink));
    border-radius: 6px 0 0 6px;
    pointer-events: none;
  }
  .rv-head {
    position: absolute;
    top: -3px;
    bottom: -3px;
    width: 3px;
    margin-left: -1.5px;
    background: #fff;
    border-radius: 2px;
    box-shadow: 0 0 6px rgba(255, 255, 255, 0.6);
    pointer-events: none;
  }
  .rv-gapmark {
    position: absolute;
    top: 0;
    bottom: 0;
    background: repeating-linear-gradient(45deg, rgba(0, 0, 0, 0.4) 0 4px, transparent 4px 8px);
    pointer-events: none;
  }
  .rv-chip {
    position: absolute;
    top: -22px;
    transform: translateX(-50%);
    font: 800 9px var(--font-body);
    letter-spacing: 0.5px;
    padding: 2px 5px;
    border-radius: 4px;
    border: 1px solid var(--navy-border);
    background: var(--navy);
    color: var(--muted);
    cursor: pointer;
    white-space: nowrap;
  }
  .rv-chip:hover {
    background: var(--navy-hi);
    color: var(--text);
  }
  .rv-marker {
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 14px;
    height: 14px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    line-height: 1;
    border: none;
    background: transparent;
    color: var(--mk, #fff);
    cursor: pointer;
  }
  .rv-marker.mk-hit {
    width: 3px;
    height: 8px;
    border-radius: 1px;
    background: var(--mk, #fff);
    opacity: 0.7;
  }
  .rv-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .rv-ctl {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 7px 11px;
    border-radius: 9px;
    border: 1px solid var(--navy-border);
    border-bottom: 3px solid var(--navy-btm);
    background: var(--navy);
    color: var(--ghost-text);
    cursor: pointer;
    font: 800 12px var(--font-body);
    letter-spacing: 0.5px;
  }
  .rv-ctl:hover {
    background: var(--navy-hi);
    color: var(--text);
  }
  .rv-speeds,
  .rv-cams {
    display: inline-flex;
    gap: 3px;
    padding: 3px;
    border-radius: 9px;
    background: #0e1229;
  }
  .rv-speed,
  .rv-cam {
    padding: 5px 8px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font: 800 11px var(--font-body);
  }
  .rv-speed:hover,
  .rv-cam:hover {
    color: var(--text);
  }
  .rv-speed.active,
  .rv-cam.active {
    background: var(--pink);
    color: #fff;
  }
  .rv-time {
    font: 700 13px var(--font-body);
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    margin-left: 2px;
  }
  .rv-players {
    display: inline-flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .rv-pchip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 9px;
    border-radius: 8px;
    border: 1px solid var(--navy-border);
    background: var(--navy);
    color: var(--muted);
    cursor: pointer;
    font: 700 11px var(--font-body);
  }
  .rv-pchip .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .rv-pchip.active {
    border-color: var(--pink);
    color: var(--text);
    background: var(--navy-hi);
  }
</style>

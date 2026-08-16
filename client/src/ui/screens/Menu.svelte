<script lang="ts">
  import type { MenuState } from "../app/stores";
  import Icon from "../components/Icon.svelte";
  import ControlsHint from "../components/ControlsHint.svelte";
  import {
    fullscreenSupported,
    isFullscreen,
    onFullscreenChange,
    toggleFullscreen,
  } from "../../game/fullscreen";
  import { canInstall, promptInstall } from "../../pwa/install";

  let { data }: { data: MenuState } = $props();

  // iPhone Safari has no Fullscreen API; there the install button is the only
  // route to a chrome-free game, so don't offer a button that can't work.
  const canGoFullscreen = fullscreenSupported();
  let fullscreen = $state(isFullscreen());
  // Also catches the player leaving fullscreen with Esc / the system gesture.
  $effect(() => onFullscreenChange((on) => (fullscreen = on)));

  let name = $state(localStorage.getItem("sz-name") ?? "");
  let code = $state("");

  const modeLabel = $derived(
    data.mode === "keyboard" ? "keyboard + trackpad" : "keyboard + mouse",
  );

  function persistName(): string {
    const v = name.trim() || "Player";
    localStorage.setItem("sz-name", v);
    return v;
  }
  function create() {
    data.onCreate(persistName());
  }
  function join() {
    const c = code.trim().toUpperCase();
    if (c.length === 4) data.onJoin(persistName(), c);
  }
</script>

<div class="sz-screen menu">
  <!-- Touch players never see the gear, so fullscreen gets its own button. -->
  <div class="topbar">
    {#if canGoFullscreen}
      <button
        id="m-fullscreen"
        class="sz-iconbtn topbtn"
        aria-label={fullscreen ? "Exit fullscreen" : "Play fullscreen"}
        title={fullscreen ? "Exit fullscreen" : "Play fullscreen"}
        aria-pressed={fullscreen}
        onclick={() => void toggleFullscreen()}
      >
        <Icon name={fullscreen ? "shrink" : "expand"} size={21} />
      </button>
    {/if}
    {#if !data.touch}
      <button
        id="m-settings"
        class="sz-iconbtn topbtn"
        aria-label="Settings"
        title="Settings"
        onclick={data.onSettings}
      >
        <Icon name="gear" size={21} />
      </button>
    {/if}
  </div>

  <div class="brand">
    <div class="sz-eyebrow">ONLINE ARENA BRAWLER</div>
    <h1 class="sz-title">SMASHZONE</h1>
  </div>

  <div class="sz-panel card">
    <div class="error">{data.error}</div>
    <input
      id="m-name"
      class="sz-input"
      maxlength="16"
      placeholder="your name"
      bind:value={name}
      onkeydown={(e) => e.key === "Enter" && create()}
    />
    <button id="m-create" class="sz-btn primary" onclick={create}>CREATE PARTY</button>
    <div class="divider"><span></span><span>OR</span><span></span></div>
    <div class="join-row">
      <input
        id="m-code"
        class="sz-input codein"
        maxlength="4"
        placeholder="CODE"
        bind:value={code}
        onkeydown={(e) => e.key === "Enter" && join()}
      />
      <button id="m-join" class="sz-btn join" onclick={join}>JOIN</button>
    </div>
    {#if data.showReplays}
      <button id="m-replays" class="sz-btn replays" onclick={data.onReplays}>
        <Icon name="replays" size={17} /><span>REPLAYS</span>
      </button>
    {/if}
    <!-- Only ever appears when the browser says an install is possible; an
         installed launch is fullscreen with no browser chrome at all. -->
    {#if $canInstall}
      <button id="m-install" class="sz-btn replays" onclick={() => void promptInstall()}>
        <Icon name="install" size={17} /><span>INSTALL APP</span>
      </button>
    {/if}
  </div>

  <div class="footer">
    <ControlsHint mode={data.mode} context="menu" touch={data.touch} />
    {#if !data.touch}
      <div class="hint">
        controls: {modeLabel}
        <button id="m-mode" class="linklike" onclick={data.onSettings}>change</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .topbar {
    position: absolute;
    top: max(16px, env(safe-area-inset-top));
    right: max(16px, env(safe-area-inset-right));
    display: flex;
    gap: 8px;
  }
  .topbtn {
    width: 42px;
    height: 42px;
    border-radius: 11px;
    background: #171c38;
    color: var(--muted);
  }
  .topbtn[aria-pressed="true"] {
    color: var(--gold);
  }
  .topbtn :global(svg) {
    width: 21px;
    height: 21px;
  }
  .brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 11px;
    width: 330px;
    padding: 20px;
  }
  .card .error {
    color: var(--pink-soft);
    text-align: center;
  }
  .divider {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--dim);
    font: 600 11px var(--font-body);
    letter-spacing: 2px;
  }
  .divider span:first-child,
  .divider span:last-child {
    flex: 1;
    height: 1px;
    background: #232a4e;
  }
  .join-row {
    display: flex;
    gap: 9px;
  }
  .codein {
    flex: 1;
    min-width: 0;
    font: 700 18px var(--font-body);
    letter-spacing: 5px;
    text-transform: uppercase;
    padding: 12px 8px;
  }
  .join {
    font-size: 18px;
    padding: 0 22px;
  }
  .replays {
    font-size: 17px;
    padding: 12px 0 11px;
  }
  .footer {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 9px;
    margin-top: 2px;
  }
</style>

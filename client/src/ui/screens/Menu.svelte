<script lang="ts">
  import type { MenuState } from "../app/stores";
  import Icon from "../components/Icon.svelte";
  import ControlsHint from "../components/ControlsHint.svelte";

  let { data }: { data: MenuState } = $props();

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
  {#if !data.touch}
    <button
      id="m-settings"
      class="sz-iconbtn gear"
      aria-label="Settings"
      title="Settings"
      onclick={data.onSettings}
    >
      <Icon name="gear" size={21} />
    </button>
  {/if}

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
  .gear {
    position: absolute;
    top: 16px;
    right: 16px;
    width: 42px;
    height: 42px;
    border-radius: 11px;
    background: #171c38;
    color: var(--muted);
  }
  .gear :global(svg) {
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

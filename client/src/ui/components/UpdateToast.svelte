<script lang="ts">
  // Shown only when a new build finished installing while the player was busy
  // (mid-match, watching a replay). Doing nothing is a valid choice: the swap
  // happens by itself the moment they're back on the menu.
  import type { UpdateState } from "../app/stores";
  import Icon from "./Icon.svelte";

  let { data }: { data: UpdateState } = $props();

  let dismissed = $state(false);
</script>

{#if !dismissed}
  <div class="update-toast sz-panel" role="status">
    <div class="copy">
      <b>New version ready</b>
      <span>Applies when you're back on the menu.</span>
    </div>
    <button class="sz-btn primary" onclick={() => data.apply()}>RELOAD NOW</button>
    <button class="sz-iconbtn" aria-label="Dismiss" onclick={() => (dismissed = true)}>
      <Icon name="close" size={16} />
    </button>
  </div>
{/if}

<style>
  .update-toast {
    position: fixed;
    right: max(18px, env(safe-area-inset-right));
    bottom: max(18px, env(safe-area-inset-bottom));
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 12px 12px 18px;
    max-width: min(92vw, 460px);
    pointer-events: auto;
    animation: toast-in 0.28s ease-out both;
  }

  .copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .copy b {
    font: 400 19px/1 var(--font-display);
    letter-spacing: 1px;
    color: var(--gold);
  }
  .copy span {
    font: 400 13px var(--font-body);
    color: var(--muted);
  }

  .update-toast :global(.sz-btn) {
    font-size: 16px;
    padding: 10px 14px 9px;
    white-space: nowrap;
  }
  .update-toast :global(.sz-iconbtn) {
    width: 32px;
    height: 32px;
  }

  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(14px);
    }
  }

  @media (max-width: 560px) {
    .update-toast {
      left: max(18px, env(safe-area-inset-left));
    }
    .copy span {
      display: none;
    }
  }
</style>

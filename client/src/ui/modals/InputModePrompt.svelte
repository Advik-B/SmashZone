<script lang="ts">
  import type { InputPromptState } from "../app/stores";
  import type { InputMode } from "../../game/input";
  import { focusOnMount } from "../app/actions";

  let { data }: { data: InputPromptState } = $props();

  const modes: InputMode[] = ["pointer", "keyboard"];
  let cards = $state<HTMLButtonElement[]>([]);
  // The Enter press that opened this (e.g. in the name field) would otherwise
  // activate the freshly-focused card in the same keystroke.
  const openedAt = performance.now();

  function pick(m: InputMode) {
    if (performance.now() - openedAt < 250) return;
    data.onPick(m);
  }

  function onKey(e: KeyboardEvent) {
    const focused = cards.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Tab"].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      const back =
        e.key === "ArrowLeft" || e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey);
      const n = cards.length;
      cards[((focused < 0 ? 0 : focused) + (back ? n - 1 : 1)) % n]?.focus();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      data.onCancel();
    } else if (e.key === "Enter" || e.key === " ") {
      e.stopPropagation(); // let the focused button's native activation fire
    }
  }

  $effect(() => {
    cards[data.current === "keyboard" ? 1 : 0]?.focus();
  });
</script>

<div
  class="mode-modal"
  role="dialog"
  aria-modal="true"
  aria-label="How do you play?"
  tabindex="-1"
  use:focusOnMount
  onkeydown={onKey}
>
  <h2>HOW DO YOU PLAY?</h2>
  <div class="mode-cards">
    {#each modes as m, i}
      <button class="mode-card" data-mode={m} bind:this={cards[i]} onclick={() => pick(m)}>
        <b>{m === "keyboard" ? "Keyboard + Trackpad" : "Keyboard + Mouse"}</b>
        <span>
          {m === "keyboard"
            ? "keyboard-only controls — no mouse needed"
            : "aim with the mouse, pointer is captured"}
        </span>
      </button>
    {/each}
  </div>
  <div class="hint">← → to choose · Enter to confirm · Esc to cancel</div>
</div>

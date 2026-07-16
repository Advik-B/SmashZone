<script lang="ts">
  import Keycap from "./Keycap.svelte";
  import type { InputMode } from "../../game/input";

  let { mode, context, touch }: { mode: InputMode; context: "menu" | "hud"; touch: boolean } =
    $props();

  type Hint = { keys: string[]; label: string };

  const menuKeyboard: Hint[][] = [
    [
      { keys: ["W", "A", "S", "D"], label: "move" },
      { keys: ["Up", "Left", "Down", "Right"], label: "aim" },
      { keys: ["J"], label: "light" },
      { keys: ["K"], label: "heavy" },
      { keys: ["Space"], label: "jump" },
      { keys: ["Shift"], label: "dash" },
      { keys: ["C"], label: "center cam" },
    ],
  ];
  const menuPointer: Hint[][] = [
    [
      { keys: ["W", "A", "S", "D"], label: "move" },
      { keys: ["Mouse"], label: "aim" },
      { keys: ["MouseL"], label: "light" },
      { keys: ["MouseR"], label: "heavy" },
      { keys: ["Space"], label: "jump" },
      { keys: ["Shift"], label: "dash" },
    ],
  ];
  const hudKeyboard: Hint[][] = [
    [
      { keys: ["W", "A", "S", "D"], label: "move" },
      { keys: ["Space"], label: "jump ×2" },
      { keys: ["Shift"], label: "dash" },
    ],
    [
      { keys: ["J"], label: "light" },
      { keys: ["K"], label: "heavy / air-slam" },
    ],
  ];
  const hudPointer: Hint[][] = [
    [
      { keys: ["W", "A", "S", "D"], label: "move" },
      { keys: ["Space"], label: "jump ×2" },
      { keys: ["Shift"], label: "dash" },
    ],
    [
      { keys: ["MouseL"], label: "light" },
      { keys: ["MouseR"], label: "heavy / air-slam" },
    ],
  ];

  const rows = $derived(
    context === "menu"
      ? mode === "keyboard"
        ? menuKeyboard
        : menuPointer
      : mode === "keyboard"
        ? hudKeyboard
        : hudPointer,
  );
</script>

{#if touch}
  {#if context === "menu"}
    <div class="keys-row">
      <span class="key-hint"><span>left stick to move · drag to aim · tap buttons to fight</span></span>
    </div>
  {/if}
{:else}
  {#each rows as row}
    <div class="keys-row">
      {#each row as h}
        <span class="key-hint">
          {#if h.keys.length > 1}
            <span class="keys">{#each h.keys as k}<Keycap {k} />{/each}</span>
          {:else}
            <Keycap k={h.keys[0]} />
          {/if}
          <span>{h.label}</span>
        </span>
      {/each}
    </div>
  {/each}
{/if}

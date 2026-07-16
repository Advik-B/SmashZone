<script lang="ts">
  // The three HUD surfaces the live match AND replay playback both drive:
  // full-screen KO flash, kill-feed, and the center banner. Rendered from the
  // shared stores so ReplayViewerBar can reuse them exactly like the live HUD.
  import { flashBump, flashStrength, feed, centerTitle, centerBump, centerSub } from "../app/stores";
  import { retrigger } from "../app/actions";
</script>

<div
  id="h-flash"
  style="--flash:{$flashStrength}"
  use:retrigger={{ cls: "flash-out", dep: $flashBump }}
></div>

<div class="hud-feed" id="h-feed">
  {#each $feed as line (line.id)}
    <div class="feed-line">{@html line.html}</div>
  {/each}
</div>

<div class="hud-center" id="h-center">
  <div id="h-title" use:retrigger={{ cls: "center-pop", dep: $centerBump }}>{$centerTitle}</div>
  <div class="hud-sub" id="h-sub">{$centerSub}</div>
</div>

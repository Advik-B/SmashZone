<script lang="ts">
  import Icon from "./Icon.svelte";
  import { BOT_DIFF_NAMES } from "../../net/messages";
  let { difficulty, size = 13 }: { difficulty: number; size?: number } = $props();
</script>

<span class="bot-tag diff-{difficulty}">
  <Icon name="bot" {size} />
  <span>{BOT_DIFF_NAMES[difficulty] ?? "?"}</span>
</span>

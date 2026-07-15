<script lang="ts">
  // A single Xelu key-prompt image (see /assets/keys). `k` is the file stem,
  // e.g. "W", "Space", "MouseL", "Up".
  let { k, alt }: { k: string; alt?: string } = $props();
</script>

<img class="kc" src="/assets/keys/{k}.png" alt={alt ?? k} />

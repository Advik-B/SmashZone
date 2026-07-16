import { SLOT_COLORS } from "../game/players";

/** Slot index → "#rrggbb". Shared by the UI, eventfx and the replay UI. */
export function colorOf(slot: number): string {
  return "#" + SLOT_COLORS[slot % SLOT_COLORS.length].toString(16).padStart(6, "0");
}

/**
 * Escape untrusted text (player names, server errors) for the one place we
 * still build HTML by hand: kill-feed lines, assembled in eventfx.ts and
 * rendered with {@html}. Everything else flows through Svelte's auto-escaping.
 */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

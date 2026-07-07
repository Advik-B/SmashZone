/**
 * Inline SVG control "assets": keycaps and mouse-button icons used by the
 * menu and HUD control hints instead of plain "LMB/RMB" text.
 */

/** A keyboard keycap. `wide` stretches the cap for Space / Shift. */
export function keycap(label: string, wide = false): string {
  return `<span class="kbd${wide ? " kbd-wide" : ""}">${label}</span>`;
}

/** The WASD cluster rendered as one compact group. */
export function wasdCluster(): string {
  return `<span class="kbd-cluster">${keycap("W")}${keycap("A")}${keycap("S")}${keycap("D")}</span>`;
}

/** The arrow-key cluster, mirroring wasdCluster(). */
export function arrowCluster(): string {
  return `<span class="kbd-cluster">${keycap("↑")}${keycap("←")}${keycap("↓")}${keycap("→")}</span>`;
}

/** A settings gear, drawn as a stroke icon to match the other hint assets. */
export function gearIcon(): string {
  return `<svg class="icon-gear" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
}

/**
 * Mouse icon with the given button highlighted, or motion arrows for "move".
 * Drawn once here so every hint shares the same asset.
 */
export function mouseIcon(kind: "left" | "right" | "move"): string {
  // Mouse body: 24x34 rounded shell with a split top third for the buttons.
  const body = `
    <rect x="5" y="3" width="22" height="32" rx="11" fill="none" stroke="currentColor" stroke-width="2.4"/>
    <line x1="16" y1="3.5" x2="16" y2="14" stroke="currentColor" stroke-width="2"/>
    <line x1="5.5" y1="14" x2="26.5" y2="14" stroke="currentColor" stroke-width="2"/>`;
  const highlight =
    kind === "left"
      ? `<path d="M 16 4.4 A 9.6 9.6 0 0 0 6.4 14 L 16 14 Z" fill="currentColor" opacity="0.95"/>`
      : kind === "right"
        ? `<path d="M 16 4.4 A 9.6 9.6 0 0 1 25.6 14 L 16 14 Z" fill="currentColor" opacity="0.95"/>`
        : `<path d="M 16 20 l -4 5 h 8 Z M 16 32 l -4 -5 h 8 Z" fill="currentColor" opacity="0.8"/>`;
  return `<svg class="icon-mouse" viewBox="0 0 32 38" aria-hidden="true">${body}${highlight}</svg>`;
}

/** One `icon + word` group inside a hint row. */
export function hintItem(icon: string, label: string): string {
  return `<span class="hint-item">${icon}<span>${label}</span></span>`;
}

/** Compose hint items into a flex row with separators handled by CSS. */
export function hintRow(items: string[]): string {
  return `<span class="hint-row">${items.join("")}</span>`;
}

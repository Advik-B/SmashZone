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

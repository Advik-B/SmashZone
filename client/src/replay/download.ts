// Tiny, dependency-free download helpers shared by the replay UI and the game
// client (the match-end "save replay file" fallback). Kept in their own module
// so neither side has to import the other — that cross-import is what defeated
// code-splitting before.

/** Trigger a browser download of a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function replayFilename(meta: { code: string; createdAt: string }, ext: string): string {
  const stamp = meta.createdAt.slice(0, 19).replace(/[T:]/g, "-");
  return `smashzone-${meta.code}-${stamp}.${ext}`;
}

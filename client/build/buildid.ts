// Build identity, resolved without anyone editing a file.
//
//   BUILD_ID env var   → CI / `docker build --build-arg BUILD_ID=…`
//   else git           → local builds and `fly deploy` stamp the real commit
//   else "dev"         → dev server, or a source tree with no git available
//
// This is the *human-readable* stamp (shown in the replay library, written
// into .szr headers).  The service worker's cache version is a content hash of
// the built output instead — see build/pwa.ts — because a Docker build has no
// .git and must still change on every deploy.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function git(args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // No git binary, no .git dir, shallow checkout — never fail the build.
    return "";
  }
}

export function resolveBuildId(): string {
  const explicit = process.env.BUILD_ID?.trim();
  if (explicit) return explicit;

  const sha = git(["rev-parse", "--short", "HEAD"]);
  if (!sha) return "dev";
  return git(["status", "--porcelain"]) ? `${sha}-dirty` : sha;
}

// Vite plugin that turns the built client into a self-versioning PWA.
//
// The service worker (src/pwa/sw.ts) is compiled as a second rollup entry so it
// is typechecked like the rest of src/, but it ships with placeholders it can't
// know at author time: the list of files to precache, and the cache version.
// This plugin fills them in — reading the finished output directory, so what
// gets precached is exactly what shipped, whoever emitted it (rollup, the HTML
// plugin, or the verbatim copy of public/).
//
// The version is a content hash of everything in that directory.  That matters
// more than it looks: a git SHA is unavailable inside the Docker build (no .git
// is copied) and a hand-written constant is the classic stale-PWA bug.  A
// content hash changes if and only if the shipped bytes change, in every build
// path, with nothing to remember and nothing to edit.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import type { Plugin } from "vite";

/** Emitted name of the service-worker entry (rollup input key `sw`). */
export const SW_FILENAME = "sw.js";

/** The app shell; src/pwa/sw.ts answers every navigation with it. */
const SHELL = "/index.html";

/**
 * Files precached lazily, after install has already succeeded: the ffmpeg core
 * is ~32 MB and only the video exporter needs it.  Cached best-effort so a
 * storage-quota rejection can't take the whole install down with it.
 */
const HEAVY_BYTES = 4 * 1024 * 1024;

/** `name-a1b2c3d4.ext` — Vite's content-hashed output naming. */
const FINGERPRINTED = /-[0-9a-zA-Z_-]{8,}\.[a-z0-9]+$/;

interface Entry {
  /** Root-absolute URL, e.g. "/assets/audio/jump.ogg". */
  url: string;
  /** Content hash; only ever used to derive the cache version. */
  hash: string;
  bytes: number;
  heavy: boolean;
  /** Content-hashed filename, so its URL changes whenever its content does. */
  fingerprinted: boolean;
}

/** Never precached: source maps, and the worker itself (it must revalidate). */
function isExcluded(path: string): boolean {
  return path.endsWith(".map") || path === SW_FILENAME;
}

/** Every file under `dir`, relative to it, with forward slashes. */
function walk(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, root));
    else out.push(relative(root, abs).split(sep).join(posix.sep));
  }
  return out;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function pwa(): Plugin {
  let outDir = "";

  return {
    name: "smashzone:pwa",
    apply: "build",
    // After every other plugin has written its output — index.html included.
    enforce: "post",

    configResolved(config) {
      outDir = join(config.root, config.build.outDir);
    },

    closeBundle() {
      const entries: Entry[] = [];
      for (const rel of walk(outDir)) {
        if (isExcluded(rel)) continue;
        const bytes = readFileSync(join(outDir, rel));
        entries.push({
          url: "/" + rel,
          hash: sha256(bytes),
          bytes: bytes.byteLength,
          heavy: /ffmpeg/i.test(rel) || bytes.byteLength > HEAVY_BYTES,
          fingerprinted: FINGERPRINTED.test(rel),
        });
      }
      entries.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

      // Boot offline is the whole point, and it starts here.
      if (!entries.some((e) => e.url === SHELL)) {
        return this.error(`${SHELL} is missing from ${outDir} — nothing to precache`);
      }

      // The cache version: one hash over every shipped path *and* its content.
      const version = sha256(entries.map((e) => `${e.url}:${e.hash}`).join("\n")).slice(
        0,
        12,
      );

      const core = entries.filter((e) => !e.heavy);
      const heavy = entries.filter((e) => e.heavy);
      // Unhashed URLs may sit in the HTTP cache under a stale entry; the worker
      // refetches these with `cache: "reload"` so the precache can't be poisoned.
      const revalidate = entries.filter((e) => !e.fingerprinted);

      const swPath = join(outDir, SW_FILENAME);
      let code: string;
      try {
        code = readFileSync(swPath, "utf8");
      } catch {
        return this.error(
          `${SW_FILENAME} was not emitted — the service worker must stay a rollup ` +
            `input (see rollupOptions.input.sw in vite.config.ts)`,
        );
      }
      if (/^\s*(?:import|export)[\s{*]/m.test(code)) {
        return this.error(
          `${SW_FILENAME} contains import/export statements; it is registered as a ` +
            `classic worker, so src/pwa/sw.ts must stay self-contained`,
        );
      }

      code = fill(code, (msg) => this.error(msg), [
        // A bare string constant: keep the surrounding quotes.
        { token: "__SW_VERSION__", value: version, quoted: false },
        // Array literals written as ["__TOKEN__"]: the quotes are replaced too.
        { token: "__PRECACHE_CORE__", value: urls(core), quoted: true },
        { token: "__PRECACHE_HEAVY__", value: urls(heavy), quoted: true },
        { token: "__PRECACHE_REVALIDATE__", value: urls(revalidate), quoted: true },
      ]);
      writeFileSync(swPath, code);

      const mb = (es: Entry[]) =>
        (es.reduce((n, e) => n + e.bytes, 0) / 1024 / 1024).toFixed(1);
      this.info(
        `version ${version}: ${core.length} file(s) precached (${mb(core)} MB), ` +
          `${heavy.length} deferred (${mb(heavy)} MB)`,
      );
    },
  };
}

function urls(entries: Entry[]): string {
  return entries.map((e) => JSON.stringify(e.url)).join(",");
}

interface Placeholder {
  token: string;
  value: string;
  /** True when the token's quotes are part of what gets replaced. */
  quoted: boolean;
}

function fill(code: string, fail: (msg: string) => void, holes: Placeholder[]): string {
  for (const { token, value, quoted } of holes) {
    // The minifier picks its own quote style, so try both before giving up.
    const needle = quoted
      ? ([`"${token}"`, `'${token}'`].find((n) => code.includes(n)) ?? `"${token}"`)
      : token;
    if (!code.includes(needle)) {
      fail(
        `service-worker placeholder ${needle} is missing from the built ` +
          `${SW_FILENAME} — src/pwa/sw.ts and build/pwa.ts have drifted apart`,
      );
      return code;
    }
    code = code.split(needle).join(value);
  }
  return code;
}

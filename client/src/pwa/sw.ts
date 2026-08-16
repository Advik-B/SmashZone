/**
 * SmashZone service worker.
 *
 * Self-contained by design: it must not import anything, because the build
 * emits it as a standalone `/sw.js` registered as a classic worker (see
 * build/pwa.ts, which also fills in the four placeholders below from the
 * finished bundle).  The typed shims at the bottom stand in for the webworker
 * lib, which can't be pulled in next to the DOM lib the rest of src/ uses.
 *
 * Caching model: one immutable cache per build, named `sz-<content hash>`.
 * Nothing is ever revalidated inside a version — a new build means a new cache
 * and an atomic swap — so the client can never end up with a half-updated mix
 * of old and new chunks.
 */
export {};

/**
 * One cache per build, named for a content hash of everything that ships.
 * Written as a single literal so the version survives minification greppable —
 * `grep -o 'sz-[0-9a-f]\{12\}' dist/sw.js` is how you check a build changed.
 */
const CACHE = "sz-__SW_VERSION__";

/** Everything needed to boot the game offline. */
const CORE: string[] = ["__PRECACHE_CORE__"];
/** The ~32 MB ffmpeg core: cached after install, best-effort. */
const HEAVY: string[] = ["__PRECACHE_HEAVY__"];
/** URLs without a content hash in the name — must bypass the HTTP cache. */
const REVALIDATE = new Set<string>(["__PRECACHE_REVALIDATE__"]);

const sw = globalThis as unknown as ServiceWorkerGlobals;

/** The app shell every navigation resolves to (the server is an SPA host). */
const SHELL = "/index.html";

/**
 * Fill `cache` with `urls`, reusing bytes already held by a previous version.
 * Most URLs are content-hashed, so an update usually re-downloads only what
 * actually changed — including skipping the 32 MB ffmpeg core.
 */
async function addAll(cache: Cache, urls: string[]): Promise<void> {
  const previous = await sw.caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k.startsWith("sz-") && k !== CACHE).map((k) => sw.caches.open(k))),
  );

  await Promise.all(
    urls.map(async (url) => {
      if (!REVALIDATE.has(url)) {
        for (const old of previous) {
          const hit = await old.match(url);
          if (hit) {
            await cache.put(url, hit);
            return;
          }
        }
      }
      // Unhashed URLs are served `immutable`-free but may still sit in the HTTP
      // cache; `reload` guarantees the precache holds this build's bytes.
      const request = new Request(url, {
        cache: REVALIDATE.has(url) ? "reload" : "default",
        credentials: "same-origin",
      });
      const res = await fetch(request);
      if (!res.ok) throw new Error(`precache ${url}: ${res.status}`);
      await cache.put(url, res);
    }),
  );
}

// No skipWaiting() anywhere in here: an installed build waits until the page
// says go, so a live match is never interrupted (see src/pwa/register.ts).
sw.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await sw.caches.open(CACHE);
      // Core must succeed: a partial precache would break offline boot.
      await addAll(cache, CORE);
      // Heavy must not. Storage quota is finite and the exporter is optional,
      // so a rejection here costs offline video export, not the whole install.
      // Still awaited — an unwaited 32 MB download would be killed with the
      // worker as soon as install resolves.
      // Data Saver means "don't spend my bandwidth on things I didn't ask
      // for"; the fetch handler still caches the core the first time an export
      // pulls it in.
      if (!sw.navigator.connection?.saveData) {
        await addAll(cache, HEAVY).catch(() => {});
      }
    })(),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await sw.caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith("sz-") && k !== CACHE).map((k) => sw.caches.delete(k)),
      );
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") void sw.skipWaiting();
});

sw.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;
  // Room creation and the game socket always go to the network.
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  // Navigations resolve to the precached shell. The server answers any unknown
  // path with index.html anyway, so this only changes *where* it comes from.
  if (request.mode === "navigate") {
    event.respondWith(
      sw.caches
        .open(CACHE)
        .then((cache) => cache.match(SHELL))
        .then((hit) => hit ?? fetch(request)),
    );
    return;
  }

  event.respondWith(
    (async () => {
      // This version's cache only: a lingering older one may hold different
      // bytes behind the same unhashed URL.
      const cache = await sw.caches.open(CACHE);
      const hit = await cache.match(url.pathname);
      if (hit) return hit;
      const res = await fetch(request);
      // Lazily adopt anything precaching skipped (e.g. a deferred ffmpeg chunk
      // whose install-time fetch lost to a quota error), so the second attempt
      // at an offline export works.
      if (res.ok && HEAVY.includes(url.pathname)) {
        await cache.put(url.pathname, res.clone()).catch(() => {});
      }
      return res;
    })(),
  );
});

/* ------------------------------------------------------------------ shims --
   Minimal stand-ins for lib.webworker: referencing that lib alongside the DOM
   lib (which src/ needs everywhere else) collides on dozens of shared types,
   so the handful of worker globals this file touches are declared by hand. */

interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

interface MessageEventLike extends ExtendableEventLike {
  readonly data: unknown;
}

interface ServiceWorkerGlobals {
  readonly caches: CacheStorage;
  readonly clients: { claim(): Promise<void> };
  readonly location: Location;
  /** `connection` is the Network Information API, absent outside Chromium. */
  readonly navigator: { connection?: { saveData?: boolean } };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", fn: (event: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", fn: (event: FetchEventLike) => void): void;
  addEventListener(type: "message", fn: (event: MessageEventLike) => void): void;
}

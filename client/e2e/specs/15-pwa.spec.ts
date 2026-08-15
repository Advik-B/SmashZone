import { afterEach, describe, expect, test } from "bun:test";
import { api } from "../helpers/http";
import { closeGamePages, newGamePage } from "../helpers/game";

/**
 * The install surface (manifest + icons + worker) and the two properties that
 * make the PWA worth having: it boots with the network cut, and its cache
 * version is derived from the build rather than hand-written.
 */
describe("pwa", () => {
  afterEach(async () => {
    await closeGamePages();
  });

  test("manifest is served as a manifest, with icons that exist", async () => {
    const res = await api("/manifest.webmanifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/manifest+json");

    const manifest = (await res.json()) as {
      name: string;
      start_url: string;
      icons: { src: string; sizes: string; purpose?: string }[];
    };
    expect(manifest.name).toBe("SmashZone");
    expect(manifest.start_url).toBe("/");
    // Chrome installs only with a 192 and a 512, and Android needs a maskable.
    expect(manifest.icons.map((i) => i.sizes)).toContain("192x192");
    expect(manifest.icons.map((i) => i.sizes)).toContain("512x512");
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);

    for (const icon of manifest.icons) {
      const img = await api(icon.src);
      expect(img.status).toBe(200);
      expect(img.headers.get("content-type") ?? "").toContain("image/png");
    }
  });

  test("sw.js is served as revalidating javascript, not the SPA fallback", async () => {
    const res = await api("/sw.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("javascript");
    // A missing file would fall back to index.html with a 200, so check the body.
    const body = await res.text();
    expect(body).not.toContain("<canvas");
    // The worker's own bytes are how a browser detects a new build; if this
    // were cached hard, updates would never arrive.
    expect(res.headers.get("cache-control") ?? "").toContain("no-cache");
  });

  test("the cache version is generated from the build, not hand-written", async () => {
    const body = await (await api("/sw.js")).text();

    // build/pwa.ts stamps sz-<12 hex chars of a content hash over every shipped
    // file>. A literal left unsubstituted (or a human-edited "v3") fails here.
    const versions = [...body.matchAll(/sz-([0-9a-f]{12})/g)].map((m) => m[1]);
    expect(versions.length).toBeGreaterThan(0);
    expect(body).not.toContain("__SW_VERSION__");
    expect(body).not.toContain("__PRECACHE_");

    // And the precache really lists this build's content-hashed assets.
    const html = await (await api("/")).text();
    const entry = /src="([^"]+\.js)"/.exec(html)?.[1];
    expect(entry).toBeTruthy();
    expect(body).toContain(`"${entry}"`);
    expect(body).toContain('"/index.html"');
    // The worker must never precache itself — it has to stay revalidating.
    expect(body).not.toContain('"/sw.js"');
  });

  test("registers, takes control, and boots the menu with the network cut", async () => {
    const { page, ctx, errors } = await newGamePage({ name: "Offline", serviceWorker: true });

    // The worker claims the page as soon as it activates, so no reload needed.
    // Installing precaches the whole bundle (incl. the ~32 MB ffmpeg core).
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 90_000,
    });

    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const cache = await caches.open(names[0]!);
      return {
        names,
        entries: (await cache.keys()).length,
        // The app shell: without it there is no offline boot at all.
        shell: (await cache.match("/index.html")) !== undefined,
      };
    });
    expect(cached.names.length).toBe(1);
    expect(cached.names[0]).toMatch(/^sz-[0-9a-f]{12}$/);
    expect(cached.entries).toBeGreaterThan(10);
    expect(cached.shell).toBe(true);

    // The real test: no server, no network, still a playable menu.
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector("#m-create", { timeout: 60_000 });
    expect(await page.title()).toBe("SmashZone");
    expect(errors).toEqual([]);
  });
});

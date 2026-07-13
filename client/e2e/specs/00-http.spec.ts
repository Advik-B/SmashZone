import { describe, expect, test } from "bun:test";
import { api, baseUrl } from "../helpers/http";
import { getBrowser } from "../helpers/browser";

describe("http surface", () => {
  test("GET /api/health returns ok", async () => {
    const res = await api("/api/health");
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe("ok");
  });

  test("POST /api/rooms returns a 4-char code", async () => {
    const res = await api("/api/rooms", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string };
    expect(body.code).toMatch(/^[A-Z0-9]{4}$/);
  });

  test("SPA fallback serves the embedded client", async () => {
    // Any non-API path falls back to index.html (proves build.rs embedding).
    const res = await api("/some/deep/route");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(await res.text()).toContain('<canvas id="game">');
  });

  test("static JS asset is served with a JS mime type", async () => {
    const html = await (await api("/")).text();
    const src = /src="([^"]+\.js)"/.exec(html)?.[1];
    expect(src).toBeTruthy();
    const res = await api(src!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("javascript");
  });

  test("playwright drives a page under bun", async () => {
    // The Phase-2 spike, kept as a permanent smoke test of the browser stack.
    const browser = await getBrowser();
    const ctx = await browser.newContext({ baseURL: baseUrl() });
    const page = await ctx.newPage();
    await page.goto("/");
    await page.waitForSelector("#m-create", { timeout: 30_000 });
    expect(await page.title()).toBeTruthy();
    await ctx.close();
  });
});

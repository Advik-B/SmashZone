import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolveBuildId } from "./build/buildid";
import { pwa } from "./build/pwa";

export default defineConfig({
  // The DOM/HUD overlay is a Svelte app; the Three.js render loop stays plain TS.
  // `pwa()` versions the service worker from the finished bundle — no constant
  // to bump, in any build path.
  plugins: [svelte(), pwa()],
  // Build identity baked into replay files: postcard wire bytes are only
  // guaranteed decodable by the same build, so replays record who wrote them.
  // BUILD_ID wins (CI/Docker); otherwise the working tree's git SHA; else "dev".
  define: {
    __BUILD_ID__: JSON.stringify(resolveBuildId()),
  },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
  // @ffmpeg/ffmpeg spawns its worker via `new URL(..., import.meta.url)`;
  // esbuild pre-bundling breaks that resolution in dev, so serve it as-is.
  optimizeDeps: {
    exclude: ["@ffmpeg/ffmpeg"],
  },
  build: {
    target: "esnext",
    // three.js is ~600 kB on its own and unavoidable; give it a long-cached
    // vendor chunk and lift the warning threshold above it.
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      // The worker is a second entry so it typechecks with the rest of src/.
      // It imports nothing, so rollup leaves it a standalone classic script.
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        sw: fileURLToPath(new URL("src/pwa/sw.ts", import.meta.url)),
      },
      output: {
        // /sw.js must keep a stable, root-level URL: its scope is its path, and
        // browsers byte-compare it at that URL to detect a new build.
        entryFileNames: (chunk) =>
          chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
        manualChunks(id) {
          if (id.includes("node_modules/three")) return "three";
        },
      },
    },
  },
});

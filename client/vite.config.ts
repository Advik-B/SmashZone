import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  // The DOM/HUD overlay is a Svelte app; the Three.js render loop stays plain TS.
  plugins: [svelte()],
  // Build identity baked into replay files: postcard wire bytes are only
  // guaranteed decodable by the same build, so replays record who wrote them.
  // CI/Docker pass BUILD_ID (e.g. the git short SHA); dev builds say "dev".
  define: {
    __BUILD_ID__: JSON.stringify(process.env.BUILD_ID ?? "dev"),
  },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
  build: {
    target: "esnext",
  },
});

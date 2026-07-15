import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import("@sveltejs/vite-plugin-svelte").SvelteConfig} */
export default {
  // Lets <script lang="ts"> (and PostCSS-style <style>) work in components.
  preprocess: vitePreprocess(),
};

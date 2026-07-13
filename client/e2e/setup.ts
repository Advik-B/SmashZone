// Preloaded by `bun test` (see client/bunfig.toml). Guards against running
// the specs without a server and owns run-wide teardown of the shared browser.
import { afterAll } from "bun:test";
import { closeBrowser } from "./helpers/browser";

// Everything the suite talks to is localhost; keep any environment-level
// HTTP(S) proxy out of bun's fetch.
process.env.NO_PROXY = ["localhost,127.0.0.1", process.env.NO_PROXY]
  .filter(Boolean)
  .join(",");

if (!process.env.E2E_BASE_URL) {
  throw new Error(
    "E2E_BASE_URL is not set. Run the suite via `bun run test:e2e`, " +
      "or start a server yourself and export E2E_BASE_URL=http://localhost:8080.",
  );
}

afterAll(async () => {
  await closeBrowser();
});

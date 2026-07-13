// Integration-suite orchestrator (`bun run test:e2e`): builds the WASM sim,
// the client bundle, and the gameserver (which embeds client/dist at compile
// time), spawns the server on a test port, then runs `bun test` against it.
//
// Knobs:
//   SKIP_BUILD=1     reuse existing wasm/dist/server builds (server may be stale)
//   E2E_BASE_URL=…   skip building/spawning entirely and test that server
//   E2E_PORT=…       test-server port (default 8091)
//   extra argv       forwarded to `bun test` (e.g. a spec path or -t filter)
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

const clientDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(clientDir, "..");
const skipBuild = process.env.SKIP_BUILD === "1";
const externalUrl = process.env.E2E_BASE_URL;

// Everything is localhost; keep environment proxies out of fetch + chromium.
process.env.NO_PROXY = ["localhost,127.0.0.1", process.env.NO_PROXY]
  .filter(Boolean)
  .join(",");

function run(cmd: string[], cwd = repoRoot): void {
  console.log(`\n[e2e] $ ${cmd.join(" ")}`);
  const p = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) {
    console.error(`[e2e] command failed with exit code ${p.exitCode}`);
    process.exit(p.exitCode ?? 1);
  }
}

/** Build client/src/wasm/pkg if missing: wasm-pack, else cargo + wasm-bindgen. */
function ensureWasmPkg(): void {
  if (existsSync(join(clientDir, "src/wasm/pkg/sim_wasm.js"))) return;
  if (Bun.which("wasm-pack")) {
    run(["bun", "run", "wasm"], clientDir);
    return;
  }
  if (Bun.which("wasm-bindgen")) {
    run(["cargo", "build", "-p", "sim-wasm", "--target", "wasm32-unknown-unknown", "--release"]);
    run([
      "wasm-bindgen",
      "target/wasm32-unknown-unknown/release/sim_wasm.wasm",
      "--target",
      "web",
      "--out-dir",
      "client/src/wasm/pkg",
    ]);
    return;
  }
  console.error(
    "[e2e] client/src/wasm/pkg is missing and neither wasm-pack nor wasm-bindgen is installed.\n" +
      "      Install one of:\n" +
      "        cargo install wasm-pack\n" +
      "        cargo install wasm-bindgen-cli --version 0.2.126   # must match Cargo.lock\n" +
      "      (plus: rustup target add wasm32-unknown-unknown)",
  );
  process.exit(1);
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
      lastErr = `status ${res.status}`;
    } catch (e) {
      lastErr = e;
    }
    await Bun.sleep(250);
  }
  throw new Error(`server at ${url} never became healthy: ${lastErr}`);
}

let server: Subprocess | null = null;
let baseUrl = externalUrl;
let serverBin: string | null = null;

if (!externalUrl) {
  serverBin = join(repoRoot, "target", "debug", "gameserver");
  if (!skipBuild) {
    ensureWasmPkg();
    run(["bun", "run", "build"], clientDir);
    // build.rs watches client/dist, so this re-embeds the fresh bundle.
    run(["cargo", "build", "-p", "gameserver"]);
  } else if (!existsSync(serverBin)) {
    console.error("[e2e] SKIP_BUILD=1 but target/debug/gameserver does not exist — run once without it.");
    process.exit(1);
  }
  const port = process.env.E2E_PORT ?? "8091";
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`\n[e2e] starting gameserver on :${port}`);
  server = Bun.spawn([serverBin], {
    env: { ...process.env, PORT: port, RUST_LOG: process.env.RUST_LOG ?? "warn" },
    stdout: "inherit",
    stderr: "inherit",
  });
  try {
    await waitForHealth(baseUrl, 30_000);
  } catch (e) {
    console.error(`[e2e] ${e}`);
    server.kill();
    process.exit(1);
  }
  console.log(`[e2e] server healthy at ${baseUrl}`);
}

const testArgs = process.argv.slice(2);
const test = Bun.spawn(
  ["bun", "test", "--timeout", process.env.E2E_TIMEOUT ?? "120000", ...testArgs],
  {
    cwd: clientDir,
    env: {
      ...process.env,
      E2E_BASE_URL: baseUrl!,
      ...(serverBin && existsSync(serverBin) ? { E2E_SERVER_BIN: serverBin } : {}),
    },
    stdout: "inherit",
    stderr: "inherit",
  },
);
const code = await test.exited;
server?.kill();
process.exit(code);

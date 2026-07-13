# Verify SmashZone changes end-to-end

The end-to-end verification is a **committed** suite now — driven by `bun test` +
the Playwright library under `client/e2e/`. Prefer it over hand-writing a
throwaway driver in a scratch dir.

## One command

```bash
cd client && bun run test:e2e
```

The orchestrator (`client/e2e/run.ts`) does everything: builds the WASM sim (if
missing), builds the client bundle, rebuilds `gameserver` (which re-embeds
`client/dist` at compile time), spawns it on `:8091`, waits for `/api/health`,
runs every spec, then kills the server. Exit code is the test result.

## Fast loops

```bash
# reuse existing wasm/dist/server builds (skip the ~30 s rebuild)
cd client && SKIP_BUILD=1 bun run test:e2e

# run one spec against a server you already have running (e.g. on :8080 via
# `cargo run -p gameserver`, or the orchestrator's :8091):
E2E_BASE_URL=http://localhost:8080 bun test e2e/specs/05-combat.spec.ts --timeout 120000
```

`SKIP_BUILD=1` reuses `target/debug/gameserver` as-is — if you changed client
or sim code, run once **without** it so the new bundle gets embedded, or the
server will serve a stale client.

Other knobs: `E2E_PORT` (test-server port), `PW_CHROMIUM` (browser binary path;
defaults to `/opt/pw-browsers/chromium` when present, else Playwright's own).

## What it covers / doesn't

`client/e2e/specs/` maps one file per feature area: HTTP surface, menu, lobby,
match flow, movement, combat, arena+pickups, HUD/render, spectate, reconnect,
touch. Gameplay logic that's already covered deterministically by the ~67 Rust
tests (sim determinism, bot winrates, weapon physics, DI, hit-mask, protocol
round-trips, room lifecycle) is **not** re-tested through the browser — run
those with:

```bash
cargo test
```

## Ad-hoc driving (debugging a single interaction)

Don't rebuild Playwright boilerplate in the scratchpad — import the committed
helpers from a throwaway `bun run` script instead:

```ts
// scratch.ts — run: E2E_BASE_URL=http://localhost:8091 bun run scratch.ts
import { newGamePage, createRoom, addBot, startMatch } from "./client/e2e/helpers/game";
const { page } = await newGamePage({ name: "Me" });
const code = await createRoom(page, "Me");
// … poke window.__gc / window.__input, screenshot, etc.
```

`client/e2e/helpers/game.ts` already wraps the game's automation hooks:
`window.__gc` (`.phase`, `.myId`, `.aliveIds`, `.renderer.playerPos(id)`,
`.onEvent`) and `window.__input` (`.camYaw`), plus the stable DOM ids in
`client/src/ui/ui.ts`. Key helpers: `createRoom` / `joinRoom` / `addBot` /
`startMatch`, `waitPhase`, `recordEvents` + `waitEvent`, `approach` / `setYaw`,
`walkOffEdge`, `suicideRound`.

## Rebuilding the WASM sim by hand

Only needed after touching `crates/sim*` / `crates/protocol` if you're not
letting the orchestrator do it. If `wasm-pack` is missing, use `wasm-bindgen`
(version pinned in `Cargo.lock`, currently 0.2.126):

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126
cargo build -p sim-wasm --target wasm32-unknown-unknown --release
wasm-bindgen target/wasm32-unknown-unknown/release/sim_wasm.wasm --target web \
  --out-dir client/src/wasm/pkg
```

## Gotchas

- Driving controls: **stop walking** within ~1.4 u before pressing `j`, or you
  bulldoze the target off the arena (`helpers/game.ts` `approach` handles this).
  Combos need two hits < 2.5 s apart. Steer via `__input.camYaw` + holding `w`,
  never the mouse.
- Deterministic round control without combat RNG: `walkOffEdge` / `suicideRound`
  send a player off the edge to end a round on demand.
- `cargo run … | head` kills the server on SIGPIPE — redirect to a file.
- Headless fps (~27) is SwiftShader, not a perf signal. Chromium launches with
  `--enable-unsafe-swiftshader` so WebGL works without a GPU.
- One KO ends a round (last robot standing); streak/multi-KO feedback needs
  3+ players in a round.

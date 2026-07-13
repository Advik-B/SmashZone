# SmashZone

A 3D physics hack-and-slash party brawler that runs in the browser. 2–8 players
join with a room code, smack each other off a floating arena with
knockback-scaling melee, and the arena shrinks tile by tile until someone wins.
Four **sub-islands** float off the diagonals — jump or dash the gap to grab
weapon pickups (they outlast the main platform, but not forever).

## How to play

- **WASD** move (camera-relative) · **mouse** aim camera (click to lock)
- **Space** jump / double-jump · **Shift** dash
- **LMB / J** light attack · **RMB / K** heavy attack (in the air: ground slam)
- **Keyboard-only mode** (you're asked on first join whether you play with a
  mouse or a trackpad; change it anytime from the menu): **arrow keys** aim the
  camera, **J / K** attack, **C** snaps the camera behind you, and while you run
  the camera gently settles behind your movement — no pointer lock, no mouse
  needed anywhere (menus and lobby work with Tab/arrows + Enter)
- **Touch devices** get on-screen controls: a floating thumbstick (bottom-left)
  to move, drag anywhere else to aim, and jump / light / heavy / dash buttons
  (bottom-right)
- No health bars: every hit raises your **launch meter (%)** — knockback scales
  with it. Fall off the arena and you're out. Last robot standing wins the
  round; first to 3 rounds takes the match.
- Outer tile rings flash red and fall as the round goes on. Don't linger.
- **Weapon pickups** drop on the sub-islands every few seconds (timed ~8s buffs,
  grabbing a new one replaces the old):
  - **Hammer** (orange) — your melee hits ~2.5× harder
  - **Anchor** (teal) — incoming knockback reduced to ~35%
  - **Gun** (yellow) — light attack fires knockback bullets
  - **Bomb** (red) — light attack lobs an arcing AoE explosive (self-damage is real)

## Architecture

The core trick: **the gameplay simulation is written once, in Rust, and runs in
two places** — natively inside the authoritative server, and compiled to WASM
in every browser as the client's prediction engine. Physics is Rapier3D (with
`enhanced-determinism`), which ships first-class on both targets, so client
prediction actually matches server results.

```
 Browser (TypeScript + Three.js + sim.wasm)         Server (Rust: axum/tokio)
 ┌───────────────────────────────────┐              ┌───────────────────────────┐
 │ input @60Hz ──seq-numbered────────┼─WebSocket──▶ │ per-room tokio task       │
 │ local player: predicted via       │  (binary,    │  60 Hz authoritative sim  │
 │   sim.wasm, rewind+replay on      │  postcard)   │  (Rapier3D native)        │
 │   server correction               │ ◀────────────┼  20 Hz quantized snapshots│
 │ remote players: interpolated      │              │  + events                 │
 │   ~120ms behind, fed into the     │              │  hits/rounds all decided  │
 │   prediction world as kinematic   │              │  server-side              │
 │   proxies for collisions          │              │                           │
 └───────────────────────────────────┘              └───────────────────────────┘
```

| Piece | Language | Why |
|---|---|---|
| `crates/sim` | Rust | Single source of truth: character controller, combat, shrinking arena. Compiles natively **and** to wasm32. |
| `crates/protocol` | Rust | Wire types + quantization, postcard-encoded. Shared by server and (via WASM) the browser — TypeScript never touches byte layouts. |
| `crates/sim-wasm` | Rust→WASM | wasm-bindgen surface: prediction sim + message encode/decode for the client. |
| `crates/gameserver` | Rust | axum/tokio: room registry (DashMap), WebSocket plumbing, one 60 Hz task per room, serves the client build. |
| `client/` | TypeScript | Three.js rendering, glTF characters (CC0 RobotExpressive), interpolation/reconciliation glue, HTML/CSS UI, WebAudio-synthesized SFX. |

Netcode details:

- **Server-authoritative**: all hits, knockback and deaths are decided by the
  server; clients only predict their own movement.
- **Prediction + reconciliation**: the client keeps a ring buffer of inputs;
  each snapshot carries the last-applied input seq plus a precise local state.
  On divergence the client restores server state and replays pending inputs
  through the same Rust code the server ran.
- **Snapshots** are postcard-encoded and quantized (i16 fixed-point positions,
  byte yaw) at 20 Hz; remote players render ~120 ms in the past, interpolated.
- **Arena shrink is free**: the schedule is a pure function of the round tick,
  so both sides compute identical tile states with zero bytes on the wire.

## Development

```bash
# prerequisites: rust (+ wasm32 target), wasm-pack, bun 1.2+

# 1. build the wasm sim (rerun after touching crates/sim*, crates/protocol)
cd client && bun install && bun run wasm

# 2. build the client bundle (the server embeds client/dist at compile time
#    and re-embeds automatically when it changes)
cd client && bun run build

# 3. run the server — play at http://localhost:8080
cargo run -p gameserver

# or iterate on the client with hot reload at http://localhost:5173
# (proxies /api and /ws to :8080)
cd client && bun run dev
```

## Tests

Rust tests cover the deterministic sim, protocol round-trips, room/netcode
lifecycle, and bot AI (including tier winrate proofs):

```bash
cargo test
```

Browser integration tests drive the real game (compiled server + embedded
client) headlessly with Playwright, covering menu/lobby/match flow, movement,
combat, arena shrink, pickups, HUD, spectating, and reconnection:

```bash
cd client && bun run test:e2e     # builds wasm + client + server, runs the suite
```

Useful knobs: `SKIP_BUILD=1` reuses existing builds; `E2E_BASE_URL=http://localhost:8080`
runs the specs against an already-running server (e.g. a single spec via
`bun test e2e/specs/05-combat.spec.ts --timeout 120000`); `PW_CHROMIUM=/path/to/chrome`
overrides the browser binary (otherwise the suite uses Playwright's installed
Chromium — `bunx playwright install chromium` once if you have none).

## Deployment

**The release binary is the whole deployment.** `crates/gameserver/build.rs`
embeds `client/dist` (HTML, JS, CSS, WASM sim, character model) into the
executable at compile time, so shipping is: build, copy one file, run.

```bash
# build the frontend, then the self-contained server binary
cd client && bun install && bun run wasm && bun run build && cd ..
cargo build --release -p gameserver

# ship it — no other files needed on the server
scp target/release/gameserver you@host:
ssh you@host ./gameserver          # BIND_ADDR=0.0.0.0:8080 by default
```

(Release builds fail with instructions if `client/dist` is missing; debug
builds only warn, so `cargo test` works without a frontend build.)

Or as a container:

```bash
docker build -t smashzone .
docker run -p 8080:8080 smashzone
```

Tuning values (speeds, impulses, tick rates, shrink schedule) live in
[shared/constants.json](shared/constants.json), read by both Rust and
TypeScript at build time.

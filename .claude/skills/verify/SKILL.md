# Verify SmashZone changes end-to-end

How to build, launch, and drive the game headlessly to observe client changes.

## Build + launch

```bash
# WASM sim (only after touching crates/sim*, crates/protocol). If wasm-pack is
# missing and GitHub releases are blocked, use wasm-bindgen-cli from crates.io:
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version <wasm-bindgen version from Cargo.lock>
cargo build -p sim-wasm --target wasm32-unknown-unknown --release
wasm-bindgen target/wasm32-unknown-unknown/release/sim_wasm.wasm --target web \
  --out-dir client/src/wasm/pkg

cd client && npm install && npm run build   # tsc --noEmit + vite build
cargo run -p gameserver                      # serves client/dist at :8080
curl -s --noproxy localhost -X POST http://localhost:8080/api/rooms  # readiness
```

## Drive with Playwright

`npm i playwright` in a scratch dir; launch with
`executablePath: "/opt/pw-browsers/chromium"` (installed playwright version may
not match the preinstalled browser build).

- Skip the first-join input prompt: `addInitScript` →
  `localStorage.setItem("sz-input-mode", "keyboard")` (also `sz-quality` for
  presets).
- Menu: fill `#m-name`, click `#m-create` (or `#m-code` + `#m-join`); lobby:
  `#h-addbot` (adds a MEDIUM bot; the other tiers are
  `.bot-add[data-diff="0|2|3"]` for EASY/HARD/EXPERT), `#h-start`; room code
  parseable from `.hud-room` text.
- Dev hooks: `window.__gc` (GameClient) and `window.__input` (InputManager).
  TS-private fields are reachable: `__gc.phase.type`, `__gc.myId`,
  `__gc.metas`, `__gc.aliveIds`, `__gc.renderer.playerPos(id)`.
- Steer: set `__input.camYaw = Math.atan2(dx, dz)` toward a target, hold `w`
  (Playwright `keyboard.down`). Keys: j light, k heavy, Space jump, Shift dash.
- To land melee hits, STOP walking near the target (dist < ~1.4) before
  pressing j — holding w bulldozes opponents off the arena. For combos
  (< 2.5 s between hits), have a second client march into your attacks:
  join a second page and steer it toward you; chasing a launched target
  usually misses the window. Bots (`#h-addbot`) brawl on their own — good for
  passive observation, bad for controlled hits.
- Wrap events for assertions:
  `const o = gc.onEvent.bind(gc); gc.onEvent = (ev) => { o(ev); record(ev); }`.

## Gotchas

- `cargo run … | head` kills the server on SIGPIPE — redirect to a file.
- Headless fps (~27) is SwiftShader, not a perf signal.
- One KO ends a round (last robot standing); streak/multi-KO feedback needs
  3+ players in a round.

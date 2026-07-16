# Credits

## Audio (CC0 — public domain, no attribution required; credited here anyway)

Sound effects from **Kenney** (https://kenney.nl), CC0 1.0:

- Impact Sounds — hit / slam impacts (`hit_light`, `hit_heavy`, `slam`)
- Digital Audio — jump, dash, shoot, bomb throw, pickup, death (`jump`, `dash`,
  `shoot`, `throw_bomb`, `pickup`, `pickup_spawn`, `explosion`, `death`)
- Music Jingles — victory sting (`win`)

Background music (CC0 1.0, via https://opengameart.org):

- **8 Bit Battle Loop** by Sirkoto51 — in-match music (`music_battle`)
- **Chiptune: Exploration** — menu / lobby music (`music_menu`)

All audio files live in `client/public/assets/audio/` and are embedded into the
server binary at build time. The game also ships a procedural WebAudio fallback
(`client/src/game/audio.ts`) so it still sounds right if a sample is missing.

## 3D model

- **RobotExpressive** (three.js examples), CC0 — `client/public/assets/robot.glb`

## Fonts (SIL Open Font License 1.1)

- **Lilita One** (display) and **Rubik** (body), from Google Fonts — self-hosted
  as `.woff2` in `client/public/assets/fonts/` and embedded into the server
  binary at build time (no external / CDN font requests at runtime).

## UI key prompts (CC0 — public domain, no attribution required; credited here anyway)

- **Xelu's Free Controller & Key Prompts** by Nicolae "Xelu" Berbece
  (https://thoseawesomeguys.com/prompts/), CC0 1.0 — the keyboard/mouse key
  images in `client/public/assets/keys/` (the "Dark" set).

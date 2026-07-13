import init, { ClientSim } from "./wasm/pkg/sim_wasm";
import { GameClient } from "./net/gameclient";
import {
  INPUT_MODE_KEY,
  InputManager,
  hasSavedInputMode,
  isTouchDevice,
  savedInputMode,
  type InputMode,
} from "./game/input";
import { loadCharacterModel } from "./game/players";
import { Renderer } from "./game/renderer";
import { TouchControls } from "./game/touch";
import {
  getMusicVolume,
  getVolume,
  isMuted,
  isMusicMuted,
  loadAudio,
  playMusic,
  setMuted,
  setMusicMuted,
  setMusicVolume,
  setVolume,
} from "./game/audio";
import { savedQuality, saveQuality } from "./game/quality";
import * as replayStore from "./replay/store";
import { UI } from "./ui/ui";

async function createRoom(): Promise<string> {
  const res = await fetch("/api/rooms", { method: "POST" });
  if (!res.ok) {
    // Surface the server's reason (e.g. "server is full") when it sends one.
    const msg = await res
      .json()
      .then((b) => (b && typeof b.error === "string" ? b.error : null))
      .catch(() => null);
    throw new Error(msg ?? "failed to create room");
  }
  const { code } = await res.json();
  return code;
}

async function main() {
  await Promise.all([init(), loadCharacterModel(), loadAudio()]);

  const canvas = document.getElementById("game") as HTMLCanvasElement;
  const renderer = new Renderer(canvas);
  renderer.applyQuality(savedQuality());
  // Arena backdrop behind the menu.
  {
    const bg = new ClientSim(0);
    renderer.setTiles(bg.tile_centers());
    bg.free();
  }
  const input = new InputManager(canvas);
  input.attach();
  input.setMode(savedInputMode());
  const touch = isTouchDevice() ? new TouchControls(input) : null;
  const ui = new UI();

  // Whatever currently owns the frame loop: a live GameClient or (later) a
  // replay player. Both expose the same frame/destroy shape.
  let client: { frame(now: number): void; destroy(): void } | null = null;

  // Dev/test hook for the replay library (harmless in production).
  (window as unknown as Record<string, unknown>).__replayStore = replayStore;

  window.addEventListener("resize", () => renderer.resize());

  const pickMode = (m: InputMode) => {
    localStorage.setItem(INPUT_MODE_KEY, m);
    input.setMode(m);
  };

  /** First-join gate: ask how the player aims before connecting. */
  const ensureMode = (): Promise<boolean> => {
    if (touch || hasSavedInputMode()) return Promise.resolve(true);
    return new Promise((resolve) =>
      ui.showInputModePrompt(
        null,
        (m) => {
          pickMode(m);
          resolve(true);
        },
        () => resolve(false), // Esc: abort the join, ask again next time
      ),
    );
  };

  const showMenu = (error = "") => {
    document.exitPointerLock?.();
    touch?.hide();
    playMusic("menu");
    ui.showMenu(
      async (name) => {
        if (!(await ensureMode())) return;
        try {
          const code = await createRoom();
          start(name, code);
        } catch (e) {
          showMenu(String(e));
        }
      },
      async (name, code) => {
        if (!(await ensureMode())) return;
        start(name, code);
      },
      error,
      touch
        ? null
        : () =>
            ui.showSettings({
              onPickMode: (m) => {
                pickMode(m);
                showMenu(); // refresh hints + mode label
              },
              volume: getVolume(),
              muted: isMuted(),
              onVolume: (v) => setVolume(v),
              onMuted: (m) => setMuted(m),
              musicVolume: getMusicVolume(),
              musicMuted: isMusicMuted(),
              onMusicVolume: (v) => setMusicVolume(v),
              onMusicMuted: (m) => setMusicMuted(m),
              quality: savedQuality(),
              onQuality: (q) => {
                saveQuality(q);
                renderer.applyQuality(q);
              },
            }),
    );
  };

  const start = (name: string, code: string) => {
    ui.showConnecting();
    touch?.show();
    client?.destroy();
    client = new GameClient(code, name, renderer, input, ui, (reason) => {
      client = null;
      showMenu(reason);
    });
    // Dev/test hooks (harmless in production).
    (window as unknown as Record<string, unknown>).__input = input;
    (window as unknown as Record<string, unknown>).__gc = client;
  };

  const loop = (now: number) => {
    if (client) {
      client.frame(now);
    } else {
      renderer.render(1 / 60, [0, 1, 0], performance.now() / 4000, -0.5);
    }
    requestAnimationFrame(loop);
  };

  showMenu();
  requestAnimationFrame(loop);
}

main();

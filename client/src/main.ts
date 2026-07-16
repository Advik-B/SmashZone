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
import { ReplayDataset } from "./replay/dataset";
import { BUILD_ID } from "./replay/format";
import { recordingEnabled, setRecordingEnabled } from "./replay/recorder";
import { ReplayPlayer } from "./replay/player";
import {
  ReplayLibraryUI,
  ReplayViewerUI,
  downloadBlob,
  replayFilename,
} from "./replay/replayui";
import * as replayStore from "./replay/store";
import { UI } from "./ui/ui";
import { mount } from "svelte";
import App from "./ui/app/App.svelte";
import "./ui/theme.css";

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
  // The whole DOM overlay is a Svelte app mounted once into #ui; the controllers
  // above/below drive it through stores.
  mount(App, { target: document.getElementById("ui")! });

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

  const library = new ReplayLibraryUI(document.getElementById("ui")!);

  /** Replay library screen: list, watch, pin, delete, import, save-as-file. */
  const openLibrary = async (notice = "") => {
    document.exitPointerLock?.();
    touch?.hide();
    playMusic("menu");
    let items: replayStore.ReplayMeta[] = [];
    let storageLine = "";
    try {
      items = await replayStore.listReplays();
      const est = await replayStore.storageEstimate();
      if (est && est.quota > 0) {
        const used = items.reduce((n, m) => n + m.sizeBytes, 0);
        const size =
          used >= 1 << 20
            ? `${(used / (1 << 20)).toFixed(1)} MB`
            : `${Math.max(0, Math.round(used / 1024))} KB`;
        storageLine = `${items.length} replay${items.length === 1 ? "" : "s"} · ${size}`;
      }
    } catch (e) {
      notice = notice || `replay storage unavailable: ${e instanceof Error ? e.message : e}`;
    }
    library.show(
      items,
      {
        onWatch: (id) => void openReplay(id),
        onPin: async (id, pinned) => {
          await replayStore.setPinned(id, pinned).catch(() => {});
          void openLibrary();
        },
        onDelete: async (id) => {
          await replayStore.deleteReplay(id).catch(() => {});
          void openLibrary();
        },
        onSaveFile: async (id) => {
          const meta = items.find((m) => m.id === id);
          const blob = await replayStore.getReplayBlob(id).catch(() => null);
          if (blob && meta) {
            downloadBlob(blob, replayFilename(meta.header, "szr"));
          }
        },
        onImport: async (file) => {
          try {
            await replayStore.importReplayFile(file);
            void openLibrary();
          } catch (e) {
            void openLibrary(`import failed: ${e instanceof Error ? e.message : e}`);
          }
        },
        onBack: () => showMenu(),
      },
      { notice, storageLine, currentBuildId: BUILD_ID },
    );
  };

  /** Load a stored replay and hand the frame loop to a ReplayPlayer. */
  const openReplay = async (id: string) => {
    client?.destroy();
    client = null;
    try {
      const blob = await replayStore.getReplayBlob(id);
      if (!blob) throw new Error("replay not found");
      const dataset = await ReplayDataset.load(blob);
      const viewer = new ReplayViewerUI(document.getElementById("ui")!);
      const player = new ReplayPlayer(dataset, renderer, input, viewer, () => {
        client = null;
        void openLibrary();
      });
      client = player;
      (window as unknown as Record<string, unknown>).__replay = player;
    } catch (e) {
      void openLibrary(e instanceof Error ? e.message : String(e));
    }
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
              recordReplays: recordingEnabled(),
              onRecordReplays: (on) => setRecordingEnabled(on),
            }),
      () => void openLibrary(),
    );
  };

  const start = (name: string, code: string) => {
    ui.showConnecting();
    touch?.show();
    client?.destroy();
    client = new GameClient(
      code,
      name,
      renderer,
      input,
      ui,
      (reason) => {
        client = null;
        showMenu(reason);
      },
      (replayId) => void openReplay(replayId),
    );
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

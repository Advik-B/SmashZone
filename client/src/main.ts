import init, { ClientSim } from "./wasm/pkg/sim_wasm";
import { GameClient } from "./net/gameclient";
import { InputManager, isTouchDevice } from "./game/input";
import { loadCharacterModel } from "./game/players";
import { Renderer } from "./game/renderer";
import { TouchControls } from "./game/touch";
import { UI } from "./ui/ui";

async function createRoom(): Promise<string> {
  const res = await fetch("/api/rooms", { method: "POST" });
  if (!res.ok) throw new Error("failed to create room");
  const { code } = await res.json();
  return code;
}

async function main() {
  await Promise.all([init(), loadCharacterModel()]);

  const canvas = document.getElementById("game") as HTMLCanvasElement;
  const renderer = new Renderer(canvas);
  // Arena backdrop behind the menu.
  {
    const bg = new ClientSim(0);
    renderer.setTiles(bg.tile_centers());
    bg.free();
  }
  const input = new InputManager(canvas);
  input.attach();
  const touch = isTouchDevice() ? new TouchControls(input) : null;
  const ui = new UI();

  let client: GameClient | null = null;

  window.addEventListener("resize", () => renderer.resize());

  const showMenu = (error = "") => {
    document.exitPointerLock?.();
    touch?.hide();
    ui.showMenu(
      async (name) => {
        try {
          const code = await createRoom();
          start(name, code);
        } catch (e) {
          showMenu(String(e));
        }
      },
      (name, code) => start(name, code),
      error,
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

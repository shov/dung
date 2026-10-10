// SPIKE server: WebSocket endpoint for one local player.
import { resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMsg, ServerMsg } from "@dung/shared";
import { Game } from "./game.ts";
import { LimitError } from "./llm.ts";
import { FileStore } from "./store.ts";

const root = resolve(import.meta.dirname, "../..");
try {
  process.loadEnvFile(resolve(root, ".env"));
} catch {
  // .env is optional: the CLI uses the logged-in Claude subscription by default.
}

const PORT = Number(process.env.PORT ?? 8787);
const savesDir = resolve(root, "saves-PROTOTYPE-wipe-me");
process.env.LLM_DUMP_DIR ??= resolve(savesDir, "_llm");
const store = new FileStore(savesDir);
const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws: WebSocket) => {
  const send = (msg: ServerMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  let game: Game | null = null;
  /** What to re-run when the player presses "retry" on the blocking screen before a game exists. */
  let retryNewGame: (() => void) | null = null;

  const newGame = async (themeHint: string) => {
    retryNewGame = null;
    try {
      game = await Game.create(store, send, themeHint);
      game.start();
    } catch (e) {
      if (e instanceof LimitError) {
        retryNewGame = () => void newGame(themeHint);
        send({ t: "blocked", on: true, reason: e.reason, text: e.message });
      } else {
        console.error(e);
        send({ t: "error", text: `Не удалось создать мир: ${(e as Error).message.slice(0, 300)}` });
      }
    }
  };

  ws.on("message", async (raw) => {
    const msg = JSON.parse(String(raw)) as ClientMsg;
    try {
      switch (msg.t) {
        case "list_saves":
          return send({ t: "saves", saves: await store.list() });
        case "new_game":
          return newGame(msg.themeHint);
        case "load_game":
          game = await Game.load(store, send, msg.saveId);
          return game.start();
        case "retry":
          if (retryNewGame) {
            send({ t: "blocked", on: false });
            return retryNewGame();
          }
          return game?.retry();
        case "move":
          return game?.handleMove(msg.dir, msg.seq);
        case "action":
          return game?.handleAction(msg.key);
        case "cycle_item":
          return game?.handleCycleItem();
      }
    } catch (e) {
      console.error(e);
      send({ t: "error", text: (e as Error).message });
    }
  });
});

console.log(`[server] ws://localhost:${PORT}  (claude command: ${process.env.CLAUDE_CMD || "claude"}${process.env.CLAUDE_USE_SHELL === "1" ? " via shell" : ""})`);

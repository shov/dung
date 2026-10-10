import type { Bible, Chunk, Dir, Player } from "./world.ts";
import type { TriggerKey } from "./schemas.ts";

export type SaveInfo = { id: string; title: string; updatedAt: number };

export type Metric = {
  at: number;
  kind: "bible" | "chunk" | "improvise" | "sprite";
  model: string;
  ms: number;
  ok: boolean;
  retries: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  repairs?: number;
  fallback?: boolean;
  error?: string;
  key?: string;
};

export type ClientMsg =
  | { t: "list_saves" }
  | { t: "new_game"; themeHint: string }
  | { t: "load_game"; saveId: string }
  | { t: "move"; dir: Dir; seq: number }
  | { t: "action"; key: TriggerKey }
  | { t: "cycle_item" }
  | { t: "retry" };

export type ServerMsg =
  | { t: "saves"; saves: SaveInfo[] }
  | { t: "status"; text: string }
  | { t: "init"; saveId: string; bible: Bible; player: Player; chunks: Chunk[]; log: string[] }
  | { t: "chunk"; chunk: Chunk }
  | { t: "queue"; pending: string[]; inFlight: string[] }
  /** ack = seq of the move this answers, so the client can reconcile its prediction. */
  | { t: "player"; player: Player; ack?: number }
  | { t: "chunks"; chunks: Chunk[] }
  | { t: "bible"; bible: Bible }
  | { t: "log"; lines: string[] }
  | { t: "thinking"; on: boolean }
  | { t: "metric"; metric: Metric }
  | { t: "error"; text: string }
  /** Claude is unusable (limit reached / not logged in). The client blocks play until `blocked:false`. */
  | { t: "blocked"; on: boolean; reason?: "limit" | "auth"; text?: string };

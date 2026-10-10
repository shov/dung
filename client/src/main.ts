// SPIKE client: screens, input with local movement prediction, HUD and debug overlay.
import {
  DIRS,
  cellAt,
  chunkKey,
  isWalkable,
  type Bible,
  type Chunk,
  type ClientMsg,
  type Dir,
  type Metric,
  type Player,
  type ServerMsg,
  type TriggerKey,
} from "@dung/shared";
import { Renderer, spriteCanvas } from "./render.ts";

const STEP_MS = 120;
const WS_URL = import.meta.env.VITE_WS_URL ?? `ws://${location.hostname}:8787`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- state ----------
let bible: Bible | null = null;
let player: Player | null = null;
const chunks = new Map<string, Chunk>();
let log: string[] = [];
let thinking = false;
let blocked = false;
let queue = { pending: [] as string[], inFlight: [] as string[] };
const metrics: Metric[] = [];

/** Predicted position; the server confirms each move by seq. */
const pred = { x: 0, y: 0, facing: "down" as Dir };
let seq = 0;
let tween: { fromX: number; fromY: number; t: number } | null = null;
const held = new Set<Dir>();
const heldOrder: Dir[] = [];

const renderer = new Renderer();
await renderer.init($("stage"));

// ---------- network ----------
let ws: WebSocket;
let saveId: string | null = null;
const send = (msg: ClientMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

/** Reconnects forever; after a server restart it reloads the game that was open. */
function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => (saveId ? send({ t: "load_game", saveId }) : send({ t: "list_saves" }));
  ws.onclose = () => {
    showStatus("Нет связи с сервером, переподключаюсь… (запущен ли `npm run dev`?)");
    setTimeout(connect, 1000);
  };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data) as ServerMsg);
}
connect();

function handle(msg: ServerMsg) {
  switch (msg.t) {
    case "saves":
      return renderSaves(msg.saves);
    case "status":
      return showStatus(msg.text);
    case "init": {
      saveId = msg.saveId;
      bible = msg.bible;
      player = msg.player;
      chunks.clear();
      msg.chunks.forEach((c) => chunks.set(chunkKey(c.cx, c.cy), c));
      Object.assign(pred, { x: player.x, y: player.y, facing: player.facing });
      renderer.pos = { x: player.x, y: player.y };
      renderer.setBible(bible);
      renderer.redrawAll(chunks.values());
      log = msg.log;
      $("menu").hidden = true;
      $("status").hidden = true;
      $("hud").hidden = false;
      return renderHud();
    }
    case "chunk":
      chunks.set(chunkKey(msg.chunk.cx, msg.chunk.cy), msg.chunk);
      renderer.drawChunk(msg.chunk);
      return renderHud();
    case "chunks":
      for (const c of msg.chunks) {
        chunks.set(chunkKey(c.cx, c.cy), c);
        renderer.drawChunk(c);
      }
      return renderHud();
    case "bible":
      bible = msg.bible;
      renderer.setBible(bible);
      renderer.redrawAll(chunks.values());
      return renderHud();
    case "player": {
      player = msg.player;
      // Reconcile only when the server has caught up with every move we sent (or moved us itself).
      if (msg.ack === seq || (msg.ack === undefined && !tween)) {
        if (player.x !== pred.x || player.y !== pred.y) {
          Object.assign(pred, { x: player.x, y: player.y });
          renderer.pos = { x: player.x, y: player.y };
          tween = null;
        }
      }
      return renderHud();
    }
    case "log":
      log = [...log, ...msg.lines].slice(-4);
      return renderHud();
    case "thinking":
      thinking = msg.on;
      $("thinking").hidden = !msg.on;
      return;
    case "queue":
      queue = msg;
      renderer.setGenerating(msg.inFlight);
      return renderDebug();
    case "metric":
      metrics.push(msg.metric);
      return renderDebug();
    case "blocked":
      return showBlocked(msg);
    case "error":
      log = [...log, `⚠ ${msg.text}`].slice(-4);
      $("status").hidden = true;
      return renderHud();
  }
}

// ---------- screens ----------
function renderSaves(saves: { id: string; title: string; updatedAt: number }[]) {
  const box = $("saves");
  box.innerHTML = saves.length ? "<h2>Продолжить</h2>" : "";
  for (const s of saves) {
    const b = document.createElement("button");
    b.textContent = `${s.title} · ${new Date(s.updatedAt).toLocaleString()}`;
    b.onclick = () => {
      showStatus("Загружаю…");
      send({ t: "load_game", saveId: s.id });
    };
    box.appendChild(b);
  }
}

$("new-game").onclick = () => {
  showStatus("Claude придумывает мир…");
  send({ t: "new_game", themeHint: $<HTMLInputElement>("theme").value });
};
$("retry").onclick = () => {
  $("blocked").hidden = true;
  send({ t: "retry" });
};

function showStatus(text: string) {
  $("menu").hidden = true;
  $("status").hidden = false;
  $("status-text").textContent = text;
}

function showBlocked(msg: Extract<ServerMsg, { t: "blocked" }>) {
  blocked = msg.on;
  $("blocked").hidden = !msg.on;
  if (!msg.on) return;
  held.clear();
  if (msg.reason === "auth") {
    $("blocked-title").textContent = "Claude недоступен: нет авторизации";
    $("blocked-hint").textContent = "Войди в Claude Code в терминале или проверь CLAUDE_CMD в .env, затем нажми «Повторить».";
  } else {
    $("blocked-title").textContent = "Лимит Claude исчерпан";
    $("blocked-hint").textContent = "Мир не может расти дальше, игра на паузе. Когда лимит подписки восстановится, нажми «Повторить».";
  }
  $("blocked-text").textContent = msg.text ?? "";
}

// ---------- HUD ----------
function facedTarget() {
  if (!bible) return null;
  const [dx, dy] = DIRS[pred.facing];
  const cell = cellAt(chunks, pred.x + dx, pred.y + dy);
  if (!cell) return null;
  const top = cell.entities.at(-1);
  const id = top?.type ?? cell.tile;
  const name = top ? bible.entities[id]?.name : bible.tiles[id]?.name;
  return { id, name: name ?? id, isEntity: !!top };
}

function renderHud() {
  if (!bible || !player) return;
  $("title").textContent = bible.title;
  $("goal").textContent = `Цель: ${bible.goal}`;
  $("counters").innerHTML = Object.entries(player.counters).map(([k, v]) => `<span>${k}: ${v}</span>`).join("");
  const inv = $("inventory");
  inv.innerHTML = "";
  for (const [id, n] of Object.entries(player.inventory)) {
    const row = document.createElement("div");
    if (player.selected === id) row.className = "sel";
    const def = bible.entities[id];
    if (def) row.appendChild(spriteCanvas(def.sprite, bible.palette, `e:${id}`));
    row.append(`${def?.name ?? id}${n > 1 ? ` ×${n}` : ""}`);
    inv.appendChild(row);
  }
  if (!inv.childElementCount) inv.innerHTML = `<div style="color:var(--dim)">инвентарь пуст</div>`;
  $("log").innerHTML = log.map((l) => `<div>${escape(l)}</div>`).join("");
  renderHints();
  renderDebug();
}

/** Hints never reveal what works where: a fixed legend of world verbs plus a neutral Space action. */
function renderHints() {
  if (!bible || !player) return;
  const hints: [string, string][] = [["WASD", "идти"]];
  if (Object.keys(player.inventory).length) hints.push(["Tab", "сменить предмет"]);
  const t = facedTarget();
  const onFloor = !t || (!t.isEntity && t.id === bible.floorTile);
  if (!onFloor) {
    const item = player.selected;
    hints.push(["Space", item ? `применить: ${bible.entities[item]?.name ?? item}` : "осмотреть"]);
  }
  for (const a of bible.actions) hints.push([a.key, a.verb]);
  $("hints").innerHTML =
    (t && !onFloor ? `<span class="target">перед тобой: ${escape(t.name)}</span>` : "") +
    hints.map(([k, l]) => `<span><b>${k}</b>${escape(l)}</span>`).join("");
}

let debugOn = false;
function renderDebug() {
  if (!debugOn) return;
  const chunkMetrics = metrics.filter((m) => m.kind === "chunk");
  const avg = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length / 1000).toFixed(1) : "-");
  const sources = [...chunks.values()].reduce((acc, c) => ((acc[c.source] = (acc[c.source] ?? 0) + 1), acc), {} as Record<string, number>);
  const lines = [
    `pos ${pred.x},${pred.y}  chunks ${chunks.size} ${JSON.stringify(sources)}  rules ${bible?.rules.length ?? 0}`,
    `generating: ${queue.inFlight.join(" ") || "-"}`,
    `queued:     ${queue.pending.join(" ") || "-"}`,
    `chunk avg ${avg(chunkMetrics.map((m) => m.ms))}s  max ${avg([Math.max(0, ...chunkMetrics.map((m) => m.ms))])}s  n=${chunkMetrics.length}`,
    `fallbacks ${chunkMetrics.filter((m) => m.fallback).length}  retries ${metrics.reduce((a, m) => a + m.retries, 0)}  repairs ${chunkMetrics.reduce((a, m) => a + (m.repairs ?? 0), 0)}`,
    "",
    ...metrics.slice(-10).reverse().map(
      (m) => `${m.kind.padEnd(9)} ${(m.key ?? "").padEnd(6)} ${m.model.padEnd(6)} ${(m.ms / 1000).toFixed(1).padStart(5)}s ${m.ok ? "ok " : "ERR"} out=${m.outputTokens}${m.repairs ? ` rep=${m.repairs}` : ""}${m.fallback ? " FB" : ""}`,
    ),
  ];
  $("debug").textContent = lines.join("\n");
}

const escape = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

// ---------- input ----------
const MOVE_KEYS: Record<string, Dir> = {
  KeyW: "up", KeyS: "down", KeyA: "left", KeyD: "right",
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
};
const ACTION_CODES: Record<string, TriggerKey> = {
  KeyE: "E", KeyQ: "Q", KeyF: "F", KeyR: "R", Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4",
};
const canAct = () => !!bible && !blocked && !thinking && $("menu").hidden && $("status").hidden;

addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === "F3") {
    e.preventDefault();
    debugOn = !debugOn;
    $("debug").hidden = !debugOn;
    return renderDebug();
  }
  const dir = MOVE_KEYS[e.code];
  if (dir) {
    e.preventDefault();
    if (!held.has(dir)) heldOrder.push(dir);
    held.add(dir);
    // Act on keydown so a quick tap (released before the next frame) still moves.
    if (!e.repeat && !tween && canAct()) tryMove(dir);
    return;
  }
  if (!canAct() || e.repeat) return;
  if (e.code === "Tab") {
    e.preventDefault();
    return send({ t: "cycle_item" });
  }
  if (e.code === "Space") {
    e.preventDefault();
    if (!tween) send({ t: "action", key: "SPACE" });
    return;
  }
  const key = ACTION_CODES[e.code];
  if (key && bible!.actions.some((a) => a.key === key) && !tween) send({ t: "action", key });
});
addEventListener("keyup", (e) => {
  const dir = MOVE_KEYS[e.code];
  if (!dir) return;
  held.delete(dir);
  heldOrder.splice(heldOrder.indexOf(dir), 1);
});
addEventListener("blur", () => {
  held.clear();
  heldOrder.length = 0;
});

function tryMove(dir: Dir) {
  if (!bible) return;
  const turned = pred.facing !== dir;
  pred.facing = dir;
  const [dx, dy] = DIRS[dir];
  seq++;
  send({ t: "move", dir, seq });
  if (isWalkable(bible, chunks, pred.x + dx, pred.y + dy)) {
    tween = { fromX: pred.x, fromY: pred.y, t: 0 };
    pred.x += dx;
    pred.y += dy;
  } else if (turned) {
    // Turning in place: wait a beat so a tap turns without walking.
    tween = { fromX: pred.x, fromY: pred.y, t: STEP_MS / 2 };
  }
  renderHints();
}

renderer.onTick((dt) => {
  if (tween) {
    tween.t += dt;
    const k = Math.min(1, tween.t / STEP_MS);
    renderer.pos = { x: tween.fromX + (pred.x - tween.fromX) * k, y: tween.fromY + (pred.y - tween.fromY) * k };
    if (k >= 1) tween = null;
  }
  if (!tween && canAct() && heldOrder.length) tryMove(heldOrder[heldOrder.length - 1]);
  renderer.update(pred.facing, performance.now());
});

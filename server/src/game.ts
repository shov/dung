// One running game: owns the state, the chunk generation queue and the Claude calls.
import {
  BibleGenSchema,
  CHUNK,
  ChunkGenSchema,
  DIRS,
  ImproviseSchema,
  SpriteBatchSchema,
  chunkKey,
  chunkOf,
  matchRules,
  propsOf,
  isWalkable,
  localOf,
  type Bible,
  type Chunk,
  type ChunkGen,
  type Dir,
  type Metric,
  type Player,
  type Rule,
  type ServerMsg,
  type TriggerKey,
} from "@dung/shared";
import { applySprites, buildBible, merge, missingSprites } from "./bible.ts";
import { repairConnectivity, type NeighbourEdges, type Side } from "./connectivity.ts";
import { applyRule, blankEffect, describe, interact, move, newEntityId, type GameState, type Outcome } from "./engine.ts";
import { LimitError, llm } from "./llm.ts";
import { bibleSystem, bibleUser, chunkUser, improviseUser, spriteSystem, spriteUser, worldSystem } from "./prompts.ts";
import type { JournalEntry, Store } from "./store.ts";

const MAX_IN_FLIGHT = Number(process.env.GEN_CONCURRENCY ?? 3);
const PREFETCH_RADIUS = 1;
// Through the CLI Haiku 5.5 always thinks (10x the tokens), so Sonnet at low effort is faster.
const CHUNK_MODEL = (process.env.CHUNK_MODEL ?? "sonnet") as "haiku" | "sonnet";
const SPRITE_MODEL = (process.env.SPRITE_MODEL ?? "sonnet") as "haiku" | "sonnet";
const BIBLE_MODEL = (process.env.BIBLE_MODEL ?? "sonnet") as "haiku" | "sonnet";
const SPRITE_BATCH = 6;
const SPRITE_CONCURRENCY = 2;

type Send = (msg: ServerMsg) => void;

export class Game {
  private pending = new Set<string>();
  private inFlight = new Set<string>();
  private busy = false;
  private blocked: { reason: "limit" | "auth"; text: string } | null = null;
  private lastDir: Dir = "down";
  private playerSaveTimer: NodeJS.Timeout | null = null;
  /** Sprite ids being drawn right now, and ids that failed (left as placeholders). */
  private spriteBusy = new Set<string>();
  private spriteFailed = new Set<string>();
  private spriteInFlight = 0;

  private constructor(
    readonly id: string,
    private state: GameState,
    private journal: JournalEntry[],
    private store: Store,
    private send: Send,
  ) {}

  /** Generates the bible. Rethrows LimitError so the caller can block and retry. */
  static async create(store: Store, send: Send, themeHint: string): Promise<Game> {
    const id = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    send({ t: "status", text: "Claude придумывает мир…" });
    let res;
    try {
      res = await llm({ kind: "bible", model: BIBLE_MODEL, effort: "medium", system: bibleSystem(), user: bibleUser(themeHint), schema: BibleGenSchema });
    } catch (e) {
      const metric = (e as { metric?: Metric }).metric;
      if (metric) logMetric(metric);
      throw e;
    }
    const bible = buildBible(res.data);
    const player: Player = {
      x: CHUNK >> 1,
      y: CHUNK >> 1,
      facing: "down",
      inventory: {},
      selected: null,
      flags: {},
      counters: Object.fromEntries(res.data.counters.map((c) => [c.name, c.value])),
    };
    const game = new Game(id, { bible, player, chunks: new Map() }, [], store, send);
    await store.saveBible(id, bible);
    await store.savePlayer(id, player);
    await store.appendMetric(id, res.metric);
    logMetric(res.metric);
    send({ t: "metric", metric: res.metric });
    return game;
  }

  static async load(store: Store, send: Send, id: string): Promise<Game> {
    const data = await store.load(id);
    upgradeBible(data.bible);
    const chunks = new Map(data.chunks.map((c) => [chunkKey(c.cx, c.cy), c]));
    return new Game(id, { bible: data.bible, player: data.player, chunks }, data.journal, store, send);
  }

  start() {
    const s = this.state;
    this.send({
      t: "init",
      saveId: this.id,
      bible: s.bible,
      player: s.player,
      chunks: [...s.chunks.values()],
      log: this.journal.filter((j) => j.kind === "action").slice(-4).map((j) => j.text),
    });
    this.ensureAround();
    this.queueSprites();
  }

  // ---------- input ----------

  async handleMove(dir: Dir, seq: number) {
    if (this.busy || this.blocked) return this.send({ t: "player", player: this.state.player, ack: seq });
    const before = chunkOf(this.state.player.x, this.state.player.y);
    const out = move(this.state, dir);
    this.lastDir = dir;
    if (out.moved) this.record("move", `шаг ${dir} → (${this.state.player.x},${this.state.player.y})`);
    await this.publish(out, out.moved && out.messages.length ? `шагнул на (${this.state.player.x},${this.state.player.y})` : null, seq);
    const after = chunkOf(this.state.player.x, this.state.player.y);
    if (before[0] !== after[0] || before[1] !== after[1]) this.ensureAround();
  }

  async handleAction(key: TriggerKey) {
    if (this.busy || this.blocked) return;
    const out = interact(this.state, key);
    if (!out.improvise) {
      const target = out.firedRule ? ` (правило ${out.firedRule})` : "";
      return this.publish(out, out.messages.length || out.firedRule ? `нажал ${key}${target}` : null);
    }
    await this.improvise(out.improvise);
  }

  handleCycleItem() {
    const p = this.state.player;
    const items = Object.keys(p.inventory);
    if (!items.length) return;
    p.selected = p.selected === null ? items[0] : (items[items.indexOf(p.selected) + 1] ?? null);
    this.send({ t: "player", player: p });
    this.send({ t: "log", lines: [p.selected ? `В руке: ${describe(this.state, p.selected)}` : "Руки пусты."] });
    this.schedulePlayerSave();
  }

  retry() {
    if (!this.blocked) return;
    this.blocked = null;
    this.send({ t: "blocked", on: false });
    this.ensureAround();
    this.queueSprites();
  }

  // ---------- sprites ----------

  private queueSprites() {
    const jobs = missingSprites(this.state.bible).filter((j) => !this.spriteBusy.has(j.id) && !this.spriteFailed.has(j.id));
    while (!this.blocked && jobs.length && this.spriteInFlight < SPRITE_CONCURRENCY) {
      const batch = jobs.splice(0, SPRITE_BATCH);
      batch.forEach((j) => this.spriteBusy.add(j.id));
      this.spriteInFlight++;
      void this.drawSprites(batch).finally(() => {
        this.spriteInFlight--;
        batch.forEach((j) => this.spriteBusy.delete(j.id));
        this.queueSprites();
      });
    }
  }

  private async drawSprites(batch: ReturnType<typeof missingSprites>) {
    const s = this.state;
    try {
      const res = await llm({
        kind: "sprite",
        key: batch.map((j) => j.id).join(",").slice(0, 40),
        model: SPRITE_MODEL,
        effort: "low",
        system: spriteSystem(s.bible.palette),
        user: spriteUser(batch),
        schema: SpriteBatchSchema,
      });
      this.metric(res.metric);
      if (applySprites(s.bible, res.data)) {
        await this.store.saveBible(this.id, s.bible);
        this.send({ t: "bible", bible: s.bible });
      }
      // Ids Claude skipped stay placeholders instead of being re-requested forever.
      for (const j of missingSprites(s.bible)) if (batch.some((b) => b.id === j.id)) this.spriteFailed.add(j.id);
    } catch (e) {
      if (!this.handleLimit(e)) {
        this.metricFromError(e);
        batch.forEach((j) => this.spriteFailed.add(j.id));
      }
    }
  }

  // ---------- improvisation ----------

  private async improvise(req: NonNullable<Outcome["improvise"]>) {
    const s = this.state;
    this.busy = true;
    this.send({ t: "thinking", on: true });
    try {
      const res = await llm({
        kind: "improvise",
        model: CHUNK_MODEL,
        effort: "low",
        system: worldSystem(s.bible),
        user: improviseUser({
          item: req.item,
          itemProps: propsOf(s.bible, req.item),
          key: req.key,
          target: req.target.id,
          targetProps: propsOf(s.bible, req.target.id),
          player: s.player,
          journal: this.recentJournal(),
        }),
        schema: ImproviseSchema,
      });
      this.metric(res.metric);
      const { data } = res;
      const added = merge(s.bible, { tiles: data.newTiles, entities: data.newEntities });
      const rule = this.learnRule(req, data.rule, data.message);
      if (added.tiles || added.entities || rule) {
        await this.store.saveBible(this.id, s.bible);
        this.send({ t: "bible", bible: s.bible });
        this.queueSprites();
      }
      const out = rule && !rule.noop ? applyRule(s, rule.rule, req.target) : emptyOutcome();
      out.messages = [data.message, ...out.messages.filter((m) => m !== data.message)];
      const what = req.item ? `применил ${req.item} к ${req.target.id}` : `нажал ${req.key} на ${req.target.id}`;
      await this.publish(out, `${what}: ${data.message}${rule ? ` (${rule.noop ? "ничего, запомнено" : `новое правило ${rule.rule.id}`})` : ""}`);
    } catch (e) {
      if (!this.handleLimit(e)) {
        this.metricFromError(e);
        this.send({ t: "log", lines: ["(Мир задумался и ничего не ответил.)"] });
      }
    } finally {
      this.busy = false;
      this.send({ t: "thinking", on: false });
    }
  }

  /**
   * Store what Claude decided so the same situation never needs Claude again.
   * A property rule must actually cover the situation that asked for it; otherwise it is
   * narrowed to the exact item/target ids. "Nothing happens" is remembered the same way.
   */
  private learnRule(req: NonNullable<Outcome["improvise"]>, proposed: Rule | null, message: string) {
    const s = this.state;
    const situation = {
      trigger: req.item ? ("use_item" as const) : ("interact" as const),
      key: req.item ? null : req.key,
    };
    const exact = { item: req.item, itemProps: [], target: req.target.id, targetProps: [] };
    const covers = (r: Rule) =>
      matchRules(s.bible, situation.trigger, req.target.id, { key: req.key, item: req.item }).some((m) => m.id === r.id);

    if (!proposed) {
      const noop: Rule = {
        id: `noop_${req.item ?? req.key}_${req.target.id}`.toLowerCase(),
        ...situation,
        ...exact,
        conditions: [],
        effects: [{ ...blankEffect, type: "message", text: message }],
        failText: null,
      };
      const [rule] = merge(s.bible, { rules: [noop] }).rules;
      return rule ? { rule, noop: true } : null;
    }
    const [general] = merge(s.bible, { rules: [{ ...proposed, ...situation }] }).rules;
    if (general && covers(general)) return { rule: general, noop: false };
    if (general) s.bible.rules = s.bible.rules.filter((r) => r !== general);
    const [narrow] = merge(s.bible, { rules: [{ ...proposed, ...situation, ...exact }] }).rules;
    return narrow ? { rule: narrow, noop: false } : null;
  }

  // ---------- chunk generation ----------

  private ensureAround() {
    const [pcx, pcy] = chunkOf(this.state.player.x, this.state.player.y);
    for (const k of this.pending) {
      const [cx, cy] = k.split(",").map(Number);
      if (Math.max(Math.abs(cx - pcx), Math.abs(cy - pcy)) > PREFETCH_RADIUS + 1) this.pending.delete(k);
    }
    for (let dy = -PREFETCH_RADIUS; dy <= PREFETCH_RADIUS; dy++)
      for (let dx = -PREFETCH_RADIUS; dx <= PREFETCH_RADIUS; dx++) {
        const k = chunkKey(pcx + dx, pcy + dy);
        if (!this.state.chunks.has(k) && !this.inFlight.has(k)) this.pending.add(k);
      }
    this.pump();
  }

  /** Lower is sooner: distance from the player's chunk, minus a bonus for lying ahead of the player. */
  private priority(key: string) {
    const [pcx, pcy] = chunkOf(this.state.player.x, this.state.player.y);
    const [cx, cy] = key.split(",").map(Number);
    const [dx, dy] = [cx - pcx, cy - pcy];
    const [fx, fy] = DIRS[this.lastDir];
    const len = Math.hypot(dx, dy) || 1;
    return Math.max(Math.abs(dx), Math.abs(dy)) - 0.5 * ((dx * fx + dy * fy) / len);
  }

  private pump() {
    while (!this.blocked && this.inFlight.size < MAX_IN_FLIGHT && this.pending.size) {
      const key = [...this.pending].sort((a, b) => this.priority(a) - this.priority(b))[0];
      this.pending.delete(key);
      this.inFlight.add(key);
      const [cx, cy] = key.split(",").map(Number);
      this.generateChunk(cx, cy).finally(() => {
        this.inFlight.delete(key);
        this.sendQueue();
        this.pump();
      });
    }
    this.sendQueue();
  }

  private sendQueue() {
    this.send({ t: "queue", pending: [...this.pending], inFlight: [...this.inFlight] });
  }

  private neighbourInfo(cx: number, cy: number) {
    const get = (x: number, y: number) => this.state.chunks.get(chunkKey(x, y));
    const pass = (c: Chunk, x: number, y: number) => !!this.state.bible.tiles[c.tiles[y * CHUNK + x]]?.passable;
    const range = Array.from({ length: CHUNK }, (_, i) => i);
    const sides: Record<Side, [Chunk | undefined, (c: Chunk) => boolean[]]> = {
      n: [get(cx, cy - 1), (c) => range.map((i) => pass(c, i, CHUNK - 1))],
      s: [get(cx, cy + 1), (c) => range.map((i) => pass(c, i, 0))],
      w: [get(cx - 1, cy), (c) => range.map((i) => pass(c, CHUNK - 1, i))],
      e: [get(cx + 1, cy), (c) => range.map((i) => pass(c, 0, i))],
    };
    const edges: NeighbourEdges = {};
    const summaries: Partial<Record<Side, string>> = {};
    for (const [side, [chunk, edge]] of Object.entries(sides) as [Side, (typeof sides)[Side]][]) {
      if (!chunk) continue;
      edges[side] = edge(chunk);
      summaries[side] = chunk.summary;
    }
    return { edges, summaries };
  }

  private async generateChunk(cx: number, cy: number) {
    const s = this.state;
    const key = chunkKey(cx, cy);
    const { edges, summaries } = this.neighbourInfo(cx, cy);
    let gen: ChunkGen | null = null;
    let metric: Metric | undefined;
    try {
      const res = await llm({
        kind: "chunk",
        key,
        model: CHUNK_MODEL,
        effort: "low",
        system: worldSystem(s.bible),
        user: chunkUser({
          cx,
          cy,
          edges: Object.fromEntries(Object.entries(edges).map(([k, v]) => [k, v.map((p) => (p ? "." : "#")).join("")])),
          summaries,
          player: s.player,
          journal: this.recentJournal(),
          common: entityCounts(s.chunks.values()),
        }),
        schema: ChunkGenSchema,
      });
      gen = res.data;
      metric = res.metric;
    } catch (e) {
      if (this.handleLimit(e)) {
        this.pending.add(key); // try again once unblocked
        return;
      }
      metric = (e as { metric?: Metric }).metric;
      console.error(`[chunk ${key}] fallback:`, (e as Error).message.slice(0, 300));
    }

    if (this.state !== s || s.chunks.has(key)) return;
    let bibleChanged = false;
    if (gen) {
      const added = merge(s.bible, { tiles: gen.newTiles, entities: gen.newEntities, rules: gen.newRules });
      bibleChanged = added.tiles + added.entities + added.rules.length > 0;
    }
    const chunk = gen ? buildChunk(s, cx, cy, gen) : fallbackChunk(s, cx, cy);
    // Neighbours may have appeared while Claude was busy: repair against the current world.
    const passable = chunk.tiles.map((t) => !!s.bible.tiles[t]?.passable);
    const carved = repairConnectivity(passable, this.neighbourInfo(cx, cy).edges);
    for (const i of carved) chunk.tiles[i] = s.bible.floorTile;
    s.chunks.set(key, chunk);
    this.fixSpawn(chunk);

    if (bibleChanged) {
      await this.store.saveBible(this.id, s.bible);
      this.send({ t: "bible", bible: s.bible });
      this.queueSprites();
    }
    await this.store.saveChunk(this.id, chunk);
    this.send({ t: "chunk", chunk });
    this.record("chunk", `открыт участок ${key}: ${chunk.summary}`);
    if (metric) this.metric({ ...metric, repairs: carved.length, fallback: !gen });
  }

  /** The player must never stand inside a wall or a solid entity. */
  private fixSpawn(chunk: Chunk) {
    const { player, bible } = this.state;
    const [pcx, pcy] = chunkOf(player.x, player.y);
    if (pcx !== chunk.cx || pcy !== chunk.cy || isWalkable(bible, this.state.chunks, player.x, player.y)) return;
    const [lx, ly] = localOf(player.x, player.y);
    chunk.tiles[ly * CHUNK + lx] = bible.floorTile;
    chunk.entities = chunk.entities.filter((e) => e.x !== lx || e.y !== ly);
  }

  // ---------- helpers ----------

  private handleLimit(e: unknown): boolean {
    if (!(e instanceof LimitError)) return false;
    if (e.metric) this.metric(e.metric);
    if (!this.blocked) {
      this.blocked = { reason: e.reason, text: e.message };
      this.send({ t: "blocked", on: true, reason: e.reason, text: e.message });
    }
    return true;
  }

  private metricFromError(e: unknown) {
    const metric = (e as { metric?: Metric }).metric;
    if (metric) this.metric(metric);
  }

  private metric(metric: Metric) {
    logMetric(metric);
    this.send({ t: "metric", metric });
    void this.store.appendMetric(this.id, metric);
  }

  private async publish(out: Outcome, journalText: string | null, ack?: number) {
    const s = this.state;
    if (out.changedChunks.size) {
      const chunks = [...out.changedChunks].map((k) => s.chunks.get(k)!).filter(Boolean);
      this.send({ t: "chunks", chunks });
      await Promise.all(chunks.map((c) => this.store.saveChunk(this.id, c)));
    }
    this.send({ t: "player", player: s.player, ack });
    if (out.messages.length) this.send({ t: "log", lines: out.messages });
    if (journalText) this.record("action", [journalText, ...out.messages].join(" — "));
    this.schedulePlayerSave();
  }

  private record(kind: string, text: string) {
    const entry = { at: Date.now(), kind, text };
    this.journal.push(entry);
    void this.store.appendJournal(this.id, entry);
  }

  private recentJournal() {
    return this.journal.filter((j) => j.kind === "action").slice(-8).map((j) => j.text);
  }

  private schedulePlayerSave() {
    if (this.playerSaveTimer) return;
    this.playerSaveTimer = setTimeout(() => {
      this.playerSaveTimer = null;
      void this.store.savePlayer(this.id, this.state.player);
    }, 500);
  }
}

/** Saves from before the property system: fill in the new fields so they still load. */
function upgradeBible(bible: Bible) {
  for (const def of [...Object.values(bible.tiles), ...Object.values(bible.entities)]) {
    def.props ??= [];
    def.description ??= "";
  }
  bible.rules = bible.rules.map((r) => ({ ...r, itemProps: r.itemProps ?? [], targetProps: r.targetProps ?? [] }));
}

function entityCounts(chunks: Iterable<Chunk>) {
  const counts: Record<string, number> = {};
  for (const c of chunks) for (const e of c.entities) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}

const emptyOutcome = (): Outcome => ({ messages: [], changedChunks: new Set(), playerChanged: false });

export function logMetric(m: Metric) {
  const tokens = `in=${m.inputTokens} out=${m.outputTokens} cacheR=${m.cacheRead} cacheW=${m.cacheWrite}`;
  const extra = [m.retries ? `retries=${m.retries}` : "", m.repairs ? `repairs=${m.repairs}` : "", m.fallback ? "FALLBACK" : "", m.error ? `error=${m.error.slice(0, 120)}` : ""]
    .filter(Boolean)
    .join(" ");
  console.log(`[metric] ${m.kind}${m.key ? ` ${m.key}` : ""} ${m.model} ${m.ok ? "ok" : "FAIL"} ${(m.ms / 1000).toFixed(1)}s ${tokens} ${extra}`);
}

function buildChunk(s: GameState, cx: number, cy: number, gen: ChunkGen): Chunk {
  const { bible } = s;
  const legend = new Map(gen.legend.map((l) => [l.char[0], bible.tiles[l.tile] ? l.tile : bible.floorTile]));
  const tiles: string[] = [];
  for (let y = 0; y < CHUNK; y++)
    for (let x = 0; x < CHUNK; x++) tiles.push(legend.get(gen.rows[y]?.[x] ?? "") ?? bible.floorTile);
  const taken = new Set<number>();
  const entities = gen.entities
    .map((e) => ({ ...e, x: Math.round(e.x), y: Math.round(e.y) }))
    .filter((e) => {
      const i = e.y * CHUNK + e.x;
      const ok = bible.entities[e.type] && e.x >= 0 && e.x < CHUNK && e.y >= 0 && e.y < CHUNK && bible.tiles[tiles[i]]?.passable && !taken.has(i);
      if (ok) taken.add(i);
      return ok;
    })
    .slice(0, 8)
    .map((e) => ({ id: newEntityId(), type: e.type, x: e.x, y: e.y }));
  return { cx, cy, tiles, entities, summary: gen.summary, source: "claude" };
}

function fallbackChunk(s: GameState, cx: number, cy: number): Chunk {
  const wall = Object.values(s.bible.tiles).find((t) => !t.passable)?.id;
  const tiles = Array.from({ length: CHUNK * CHUNK }, () => (wall && Math.random() < 0.12 ? wall : s.bible.floorTile));
  return { cx, cy, tiles, entities: [], summary: "Пустынный участок, о котором мир ещё не успел ничего придумать.", source: "fallback" };
}

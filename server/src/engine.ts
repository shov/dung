// Deterministic rule engine. Mutates the passed state in place and reports what changed.
import {
  CHUNK,
  DIRS,
  cellAt,
  chunkKey,
  isWalkable,
  matchRules,
  type Bible,
  type Chunk,
  type Condition,
  type Dir,
  type Effect,
  type Player,
  type Rule,
  type TriggerKey,
} from "@dung/shared";

export type GameState = { bible: Bible; chunks: Map<string, Chunk>; player: Player };

/** A world cell an action is aimed at; entityId is the top entity there, if any. */
export type Target = { x: number; y: number; entityId: string | null; id: string };

export type Outcome = {
  messages: string[];
  changedChunks: Set<string>;
  playerChanged: boolean;
  firedRule?: string;
  /** No rule covers this; the caller may ask Claude to improvise one. */
  improvise?: { target: Target; item: string | null; key: TriggerKey };
};

const newOutcome = (): Outcome => ({ messages: [], changedChunks: new Set(), playerChanged: false });

let idSeq = 0;
export const newEntityId = () => `e${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export function checkCondition(p: Player, c: Condition): boolean {
  switch (c.type) {
    case "has_item":
      return (p.inventory[c.item ?? ""] ?? 0) >= Math.max(1, c.amount ?? 1);
    case "flag":
      return (p.flags[c.flag ?? ""] ?? false) === (c.value ?? true);
    case "counter_cmp": {
      const v = p.counters[c.counter ?? ""] ?? 0;
      const a = c.amount ?? 0;
      return c.op === "lte" ? v <= a : c.op === "eq" ? v === a : v >= a;
    }
  }
}

export const checkConditions = (p: Player, cs: Condition[]) => cs.every((c) => checkCondition(p, c));

function touch(out: Outcome, s: GameState, x: number, y: number) {
  const cell = cellAt(s.chunks, x, y);
  if (cell) out.changedChunks.add(chunkKey(cell.chunk.cx, cell.chunk.cy));
  return cell;
}

export function applyEffects(s: GameState, effects: Effect[], target: Target, out: Outcome) {
  const p = s.player;
  for (const e of effects) {
    switch (e.type) {
      case "give_item": {
        if (!e.item) break;
        p.inventory[e.item] = (p.inventory[e.item] ?? 0) + Math.max(1, e.amount ?? 1);
        p.selected ??= e.item;
        out.playerChanged = true;
        break;
      }
      case "take_item": {
        if (!e.item) break;
        const left = (p.inventory[e.item] ?? 0) - Math.max(1, e.amount ?? 1);
        if (left > 0) p.inventory[e.item] = left;
        else {
          delete p.inventory[e.item];
          if (p.selected === e.item) p.selected = Object.keys(p.inventory)[0] ?? null;
        }
        out.playerChanged = true;
        break;
      }
      case "remove_entity": {
        const cell = touch(out, s, target.x, target.y);
        if (cell && target.entityId) cell.chunk.entities = cell.chunk.entities.filter((en) => en.id !== target.entityId);
        break;
      }
      case "replace_entity": {
        if (!e.entity || !s.bible.entities[e.entity]) break;
        const cell = touch(out, s, target.x, target.y);
        if (!cell) break;
        const inst = target.entityId && cell.chunk.entities.find((en) => en.id === target.entityId);
        if (inst) inst.type = e.entity;
        else cell.chunk.entities.push({ id: newEntityId(), type: e.entity, x: cell.lx, y: cell.ly });
        break;
      }
      case "set_tile": {
        if (!e.tile || !s.bible.tiles[e.tile]) break;
        const cell = touch(out, s, target.x, target.y);
        if (cell) cell.chunk.tiles[cell.ly * CHUNK + cell.lx] = e.tile;
        break;
      }
      case "set_flag": {
        if (!e.flag) break;
        p.flags[e.flag] = e.value ?? true;
        out.playerChanged = true;
        break;
      }
      case "counter_add": {
        if (!e.counter) break;
        p.counters[e.counter] = (p.counters[e.counter] ?? 0) + (e.amount ?? 1);
        out.playerChanged = true;
        break;
      }
      case "spawn": {
        if (!e.entity || !s.bible.entities[e.entity]) break;
        const cell = touch(out, s, target.x + (e.dx ?? 0), target.y + (e.dy ?? 0));
        if (cell) cell.chunk.entities.push({ id: newEntityId(), type: e.entity, x: cell.lx, y: cell.ly });
        break;
      }
      case "teleport": {
        const nx = p.x + (e.dx ?? 0);
        const ny = p.y + (e.dy ?? 0);
        if (isWalkable(s.bible, s.chunks, nx, ny)) {
          p.x = nx;
          p.y = ny;
          out.playerChanged = true;
        } else out.messages.push("…но путь туда закрыт.");
        break;
      }
      case "message": {
        if (e.text) out.messages.push(e.text);
        break;
      }
    }
  }
}

/** Fire the first rule whose conditions hold; otherwise report the first failText. */
function fireRules(s: GameState, rules: Rule[], target: Target, out: Outcome): boolean {
  const ok = rules.find((r) => checkConditions(s.player, r.conditions));
  if (ok) {
    applyEffects(s, ok.effects, target, out);
    out.firedRule = ok.id;
    return true;
  }
  out.messages.push(rules.find((r) => r.failText)?.failText ?? "Ничего не происходит.");
  return false;
}

export function facedTarget(s: GameState): Target | null {
  const [dx, dy] = DIRS[s.player.facing];
  return targetAt(s, s.player.x + dx, s.player.y + dy);
}

export function targetAt(s: GameState, x: number, y: number): Target | null {
  const cell = cellAt(s.chunks, x, y);
  if (!cell) return null;
  const top = cell.entities.at(-1);
  return { x, y, entityId: top?.id ?? null, id: top?.type ?? cell.tile };
}

/** Name + sensory description: what examining something shows. */
export function describe(s: GameState, id: string) {
  const def = s.bible.entities[id] ?? s.bible.tiles[id];
  return def ? `${def.name}. ${def.description}` : "Ничего особенного.";
}

/**
 * SPACE with an item uses it on the faced target; SPACE empty-handed examines; world verbs
 * (E, Q, ...) act on the target. When no rule covers a use or a verb, Claude is asked.
 * Bare floor never triggers improvisation, so idle key presses stay free.
 */
export function interact(s: GameState, key: TriggerKey): Outcome {
  const out = newOutcome();
  const target = facedTarget(s);
  if (!target) return out;
  const item = s.player.selected;
  const isFloor = !target.entityId && target.id === s.bible.floorTile;

  if (key === "SPACE" && item) {
    const rules = matchRules(s.bible, "use_item", target.id, { item });
    if (rules.length) fireRules(s, rules, target, out);
    else if (!isFloor) out.improvise = { target, item, key };
    return out;
  }
  const rules = matchRules(s.bible, "interact", target.id, { key });
  if (rules.length) fireRules(s, rules, target, out);
  else if (key === "SPACE") {
    if (!isFloor) out.messages.push(describe(s, target.id));
  } else if (!isFloor) out.improvise = { target, item: null, key };
  return out;
}

/** Step onto (x,y): auto-pickup items, then step rules for the tile and non-solid entities. */
export function step(s: GameState, x: number, y: number, out: Outcome) {
  const cell = cellAt(s.chunks, x, y);
  if (!cell) return;
  for (const inst of cell.entities) {
    const def = s.bible.entities[inst.type];
    if (def?.kind !== "item") continue;
    const target: Target = { x, y, entityId: inst.id, id: inst.type };
    const custom = matchRules(s.bible, "step", inst.type);
    if (custom.length) fireRules(s, custom, target, out);
    else {
      applyEffects(s, [{ ...blankEffect, type: "give_item", item: inst.type }, { ...blankEffect, type: "remove_entity" }], target, out);
      out.messages.push(`Подобрано: ${def.name}. ${def.description}`);
    }
  }
  const tileRules = matchRules(s.bible, "step", cell.tile);
  if (tileRules.length) fireRules(s, tileRules, { x, y, entityId: null, id: cell.tile }, out);
  for (const inst of cellAt(s.chunks, x, y)?.entities ?? []) {
    if (s.bible.entities[inst.type]?.kind === "item") continue;
    const rules = matchRules(s.bible, "step", inst.type);
    if (rules.length) fireRules(s, rules, { x, y, entityId: inst.id, id: inst.type }, out);
  }
}

export function move(s: GameState, dir: Dir): Outcome & { moved: boolean } {
  const out = newOutcome();
  const p = s.player;
  p.facing = dir;
  out.playerChanged = true;
  const [dx, dy] = DIRS[dir];
  if (!isWalkable(s.bible, s.chunks, p.x + dx, p.y + dy)) return { ...out, moved: false };
  p.x += dx;
  p.y += dy;
  step(s, p.x, p.y, out);
  return { ...out, moved: true };
}

/** Apply a freshly improvised rule to the target that prompted it. */
export function applyRule(s: GameState, rule: Rule, target: Target): Outcome {
  const out = newOutcome();
  fireRules(s, [rule], target, out);
  return out;
}

export const blankEffect: Effect = {
  type: "message",
  item: null,
  entity: null,
  tile: null,
  flag: null,
  value: null,
  counter: null,
  amount: null,
  text: null,
  dx: null,
  dy: null,
};

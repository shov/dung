// Prompt text. Stable parts go into the system prompt so the CLI's prompt cache can reuse them.
import { CHUNK, type Bible, type Player } from "@dung/shared";
import { digest } from "./bible.ts";

const ENGINE = `You design content for a tiny top-down pixel adventure. The world is generated piece by piece
while someone is playing, so answers must be small, fast and self-consistent.

ENGINE FACTS (you cannot change these):
- Grid world, ${CHUNK}x${CHUNK} tile chunks, infinite in every direction. The player moves one tile at a time with WASD.
- Tiles are either passable or walls. Entities stand on tiles.
- Entity kinds: "item" (picked up automatically when the player walks onto it; it then lives in the inventory),
  "obstacle" (always solid; stays until a rule removes or replaces it), "feature" (props, signs, altars; solid or not).
- The player has an inventory (item id -> count), one selected item (Tab cycles), boolean flags and numeric counters.
  There is no death and no real-time enemies: bad outcomes are messages, lost items or lower counters.
- Interaction happens on the tile the player faces. SPACE = generic interact. With an item selected, SPACE uses
  that item on the faced target. A few extra keys (E, Q, F, R, 1-4) are bound to world-specific verbs.
- Rules: trigger (interact with key | step onto target | use_item item on target) + conditions + effects, all from a
  closed set. Effects act on the target cell: remove_entity / replace_entity (the faced entity), set_tile (that cell),
  spawn (target cell + dx,dy), teleport (player + dx,dy). give_item/take_item/counter_add use amount (default 1).
- Every field of a condition/effect object must be present; use null for fields that do not apply.

VISUALS: you never draw. Give every tile/entity a short "look" (shape, colours) for a separate pixel artist.

STYLE:
- Items are stereotypical and instantly recognisable (key, torch, rope, pickaxe, coin, potion, map, bone...).
- Obstacles are classic and readable (locked door, rubble, chasm, thorny bush, sleeping guard...), each solvable with
  something that exists in the world.
- Keep complexity low: few rules, short chains. Player-facing text (names, descriptions, labels, messages,
  failText, summary, goal) is in Russian. Ids are English snake_case.`;

export function bibleSystem() {
  return `${ENGINE}

TASK: invent a whole small world bible in one go: setting, palette (8-16 colours, index 0 darkest), player look,
5-8 tiles (including one default passable floor), 8-14 entities (mix of items, obstacles, features),
2-4 situational action keys with verbs that fit the setting, 0-3 counters and a loose goal.

The "rules" array is REQUIRED and must hold 6-14 rules that make the items and obstacles meaningful: every obstacle
needs at least one rule that clears it (e.g. use_item key on locked_door -> replace_entity open_door), and every
action key needs at least one interact rule using it. Rules may reference only ids you define.`;
}

export function bibleUser(themeHint: string) {
  return themeHint.trim()
    ? `Theme hint from the player: "${themeHint.trim()}". Build the world around it.`
    : "No theme hint: pick a surprising but simple setting yourself.";
}

/** The bible digest changes rarely, so it lives in the cached system prompt. */
export function worldSystem(bible: Bible) {
  return `${ENGINE}

WORLD BIBLE (authoritative; reuse these ids):
${digest(bible)}`;
}

export type ChunkContext = {
  cx: number;
  cy: number;
  edges: Partial<Record<"n" | "s" | "w" | "e", string>>;
  summaries: Partial<Record<"n" | "s" | "w" | "e", string>>;
  player: Player;
  journal: string[];
  /** entity type -> count across already generated chunks, to fight repetition */
  common: Record<string, number>;
};

export function chunkUser(c: ChunkContext) {
  const dist = Math.max(Math.abs(c.cx), Math.abs(c.cy));
  const side = { n: "north", s: "south", w: "west", e: "east" } as const;
  const neighbours = (Object.keys(side) as (keyof typeof side)[])
    .map((k) =>
      c.edges[k]
        ? `- ${side[k]}: already exists. ${c.summaries[k] ?? ""}\n  its border cells touching us ('.' open, '#' wall): ${c.edges[k]}`
        : `- ${side[k]}: not generated yet; leave at least one opening on that side.`,
    )
    .join("\n");
  return `Generate chunk (${c.cx}, ${c.cy}), ${dist} chunks from the start. ${dist === 0 ? "This is the starting area: keep the centre open and gentle." : ""}

NEIGHBOURS:
${neighbours}

PLAYER: inventory ${JSON.stringify(c.player.inventory)}, flags ${JSON.stringify(c.player.flags)}, counters ${JSON.stringify(c.player.counters)}

RECENT EVENTS:
${c.journal.length ? c.journal.map((j) => `- ${j}`).join("\n") : "- (none yet)"}

ALREADY PLACED IN THE WORLD (type: count): ${Object.entries(c.common).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(", ") || "nothing yet"}
Avoid the most frequent ones; make this area feel different from its neighbours.

REQUIREMENTS:
- legend: one char per tile id; rows: exactly ${CHUNK} rows of exactly ${CHUNK} chars. Line up open cells with the
  neighbours' open border cells so paths continue. Every open part of the chunk should be reachable.
- entities: 1-4 items and 0-3 obstacles/features on passable tiles, x and y in 0..${CHUNK - 1}. Do not block every
  path with obstacles unless the item that clears it can be found in this chunk or is already in the inventory.
- Prefer existing ids. You may add at most 2 newEntities and 1 newTile (with sprites) and the newRules that give them
  meaning; leave the arrays empty when nothing new is needed. Difficulty and novelty may grow slowly with distance.
- Occasionally place something that advances the goal.`;
}

export function improviseUser(o: {
  item: string | null;
  key: string;
  target: string;
  player: Player;
  journal: string[];
}) {
  const action = o.item
    ? `uses the item "${o.item}" on "${o.target}" (trigger use_item, item "${o.item}", target "${o.target}")`
    : `presses ${o.key} on "${o.target}" (trigger interact, key "${o.key}", target "${o.target}")`;
  return `No rule covers this yet: the player ${action}.
PLAYER: inventory ${JSON.stringify(o.player.inventory)}, flags ${JSON.stringify(o.player.flags)}, counters ${JSON.stringify(o.player.counters)}
RECENT EVENTS:
${o.journal.map((j) => `- ${j}`).join("\n") || "- (none)"}

Decide what plausibly happens in this world. Return a reusable rule with exactly that trigger/key/item/target
(conditions may be empty), or rule = null if nothing happens. Keep it simple and fair; a small reward for curiosity is
good, permanently soft-locking the player is not. message is what the player sees right now.
Add newEntities/newTiles only if an effect needs a type that does not exist yet.`;
}

export function spriteSystem(palette: string[]) {
  return `You are a pixel artist for a tiny top-down game. Draw 16x16 sprites.

FORMAT: each sprite is 16 strings of exactly 16 chars. Each char is a palette index in hex or "." for transparent.
PALETTE (index: hex): ${palette.map((c, i) => `${i.toString(16)}:${c}`).join(" ")}

STYLE: bold readable silhouette, 2-5 colours, dark outline, 3/4 top-down view, no text. Tiles are fully opaque and
tile seamlessly with themselves. Items, features and the player are centred with a transparent margin.
Return one sprite per requested id, ids unchanged.`;
}

export function spriteUser(jobs: { id: string; what: string; look: string }[]) {
  return `Draw these sprites:\n${jobs.map((j) => `- id "${j.id}": ${j.what}. Look: ${j.look}`).join("\n")}`;
}

// SPIKE smoke check: bible + chunk + one sprite batch through the real CLI.
// `npx tsx server/src/smoke.ts "theme hint"`
import { BibleGenSchema, ChunkGenSchema, SpriteBatchSchema } from "@dung/shared";
import { applySprites, buildBible, missingSprites } from "./bible.ts";
import { logMetric } from "./game.ts";
import { llm } from "./llm.ts";
import { bibleSystem, bibleUser, chunkUser, spriteSystem, spriteUser, worldSystem } from "./prompts.ts";

const b = await llm({ kind: "bible", model: "sonnet", effort: "medium", system: bibleSystem(), user: bibleUser(process.argv[2] ?? ""), schema: BibleGenSchema });
logMetric(b.metric);
const bible = buildBible(b.data);
console.log(bible.title, "|", Object.keys(bible.tiles).join(","), "|", Object.keys(bible.entities).join(","), "| rules", bible.rules.length, "/", b.data.rules.length);
const player = { x: 8, y: 8, facing: "down" as const, inventory: {}, selected: null, flags: {}, counters: {} };
const [c, sp] = await Promise.all([
  llm({ kind: "chunk", model: "haiku", effort: "low", system: worldSystem(bible), user: chunkUser({ cx: 0, cy: 0, edges: {}, summaries: {}, player, journal: [], common: {} }), schema: ChunkGenSchema }),
  llm({ kind: "sprite", model: "haiku", effort: "low", system: spriteSystem(bible.palette), user: spriteUser(missingSprites(bible).slice(0, 6)), schema: SpriteBatchSchema }),
]);
logMetric(c.metric);
logMetric(sp.metric);
console.log(c.data.summary);
console.log(c.data.rows.join("\n"));
console.log("sprites applied:", applySprites(bible, sp.data));
console.log(sp.data.sprites[0]?.id, "\n" + (sp.data.sprites[0]?.rows ?? []).join("\n"));

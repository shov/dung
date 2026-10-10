// Save storage. Files for the spike; the interface is what a Redis store would implement later.
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bible, Chunk, Metric, Player, SaveInfo } from "@dung/shared";

export type JournalEntry = { at: number; kind: string; text: string; data?: unknown };

export type SaveData = { bible: Bible; player: Player; chunks: Chunk[]; journal: JournalEntry[] };

export interface Store {
  list(): Promise<SaveInfo[]>;
  load(id: string): Promise<SaveData>;
  saveBible(id: string, bible: Bible): Promise<void>;
  saveChunk(id: string, chunk: Chunk): Promise<void>;
  savePlayer(id: string, player: Player): Promise<void>;
  appendJournal(id: string, entry: JournalEntry): Promise<void>;
  appendMetric(id: string, metric: Metric): Promise<void>;
}

export class FileStore implements Store {
  constructor(private root: string) {}

  private dir(id: string) {
    return join(this.root, id);
  }

  async list(): Promise<SaveInfo[]> {
    await mkdir(this.root, { recursive: true });
    const ids = (await readdir(this.root)).filter((id) => !id.startsWith("_"));
    const saves = await Promise.all(
      ids.map(async (id) => {
        try {
          const bible: Bible = JSON.parse(await readFile(join(this.dir(id), "bible.json"), "utf8"));
          const { mtimeMs } = await stat(join(this.dir(id), "player.json"));
          return { id, title: bible.title, updatedAt: mtimeMs };
        } catch {
          return null;
        }
      }),
    );
    return saves.filter((s): s is SaveInfo => !!s).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(id: string): Promise<SaveData> {
    const dir = this.dir(id);
    const bible = JSON.parse(await readFile(join(dir, "bible.json"), "utf8"));
    const player = JSON.parse(await readFile(join(dir, "player.json"), "utf8"));
    const chunkFiles = await readdir(join(dir, "chunks")).catch(() => [] as string[]);
    const chunks = await Promise.all(chunkFiles.map(async (f) => JSON.parse(await readFile(join(dir, "chunks", f), "utf8"))));
    const journal = (await readFile(join(dir, "journal.jsonl"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return { bible, player, chunks, journal };
  }

  async saveBible(id: string, bible: Bible) {
    await mkdir(join(this.dir(id), "chunks"), { recursive: true });
    await writeFile(join(this.dir(id), "bible.json"), JSON.stringify(bible, null, 1));
  }

  async saveChunk(id: string, chunk: Chunk) {
    await writeFile(join(this.dir(id), "chunks", `${chunk.cx}_${chunk.cy}.json`), JSON.stringify(chunk));
  }

  async savePlayer(id: string, player: Player) {
    await writeFile(join(this.dir(id), "player.json"), JSON.stringify(player, null, 1));
  }

  async appendJournal(id: string, entry: JournalEntry) {
    await appendFile(join(this.dir(id), "journal.jsonl"), JSON.stringify(entry) + "\n");
  }

  async appendMetric(id: string, metric: Metric) {
    await appendFile(join(this.dir(id), "metrics.jsonl"), JSON.stringify(metric) + "\n");
  }
}

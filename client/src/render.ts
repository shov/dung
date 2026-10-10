// PixiJS renderer: chunks, entities, player, faced-cell marker and generation placeholders.
import { Application, Container, Graphics, Sprite, Texture } from "pixi.js";
import { CHUNK, DIRS, chunkKey, type Bible, type Chunk, type Dir } from "@dung/shared";

const TILE = 16;
const SCALE = 4;

type Shape = "floor" | "wall" | "thing";

/** Draws a sprite, or a coloured placeholder while its sprite is still being generated. */
export function spriteCanvas(rows: string[] | null | undefined, palette: string[], id = "", shape: Shape = "thing") {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = TILE;
  const ctx = canvas.getContext("2d")!;
  if (!rows) {
    const hash = [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    ctx.fillStyle = palette[1 + (hash % (palette.length - 1))] ?? "#888";
    if (shape === "thing") {
      ctx.fillRect(4, 4, 8, 8);
      ctx.strokeStyle = palette[0] ?? "#000";
      ctx.strokeRect(3.5, 3.5, 9, 9);
    } else {
      ctx.fillRect(0, 0, TILE, TILE);
      ctx.fillStyle = shape === "wall" ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.12)";
      if (shape === "wall") ctx.fillRect(0, TILE - 4, TILE, 4);
      else ctx.fillRect(0, 0, 1, TILE), ctx.fillRect(0, 0, TILE, 1);
    }
    return canvas;
  }
  rows.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c === ".") return;
      ctx.fillStyle = palette[parseInt(c, 16)] ?? "#f0f";
      ctx.fillRect(x, y, 1, 1);
    }),
  );
  return canvas;
}

export class Renderer {
  private app = new Application();
  private world = new Container();
  private chunkLayer = new Container();
  private pendingLayer = new Container();
  private marker = new Graphics();
  private player = new Sprite();
  private chunkViews = new Map<string, Container>();
  private textures = new Map<string, Texture>();
  private bible: Bible | null = null;
  /** Rendered (tweened) player position in tiles. */
  pos = { x: 0, y: 0 };

  async init(el: HTMLElement) {
    await this.app.init({ resizeTo: window, background: "#000000", antialias: false });
    el.appendChild(this.app.canvas);
    this.world.scale.set(SCALE);
    this.world.addChild(this.chunkLayer, this.pendingLayer, this.marker, this.player);
    this.app.stage.addChild(this.world);
  }

  onTick(fn: (dtMs: number) => void) {
    this.app.ticker.add((t) => fn(t.deltaMS));
  }

  setBible(bible: Bible) {
    // New types may replace placeholders drawn before they were defined: start textures fresh.
    this.bible = bible;
    this.textures.forEach((t) => t.destroy(true));
    this.textures.clear();
    this.player.texture = this.texture("player", bible.playerSprite, "thing");
    this.player.anchor.set(0.5);
  }

  private texture(key: string, rows: string[] | null | undefined, shape: Shape) {
    let tex = this.textures.get(key);
    if (!tex) {
      tex = Texture.from(spriteCanvas(rows, this.bible!.palette, key, shape));
      tex.source.scaleMode = "nearest";
      this.textures.set(key, tex);
    }
    return tex;
  }

  /** Rebuild every chunk view, e.g. after the bible gained new types. */
  redrawAll(chunks: Iterable<Chunk>) {
    for (const c of chunks) this.drawChunk(c);
  }

  drawChunk(chunk: Chunk) {
    const bible = this.bible!;
    const key = chunkKey(chunk.cx, chunk.cy);
    this.chunkViews.get(key)?.destroy({ children: true });
    const view = new Container();
    view.position.set(chunk.cx * CHUNK * TILE, chunk.cy * CHUNK * TILE);
    chunk.tiles.forEach((id, i) => {
      const def = bible.tiles[id];
      const s = new Sprite(this.texture(`t:${id}`, def?.sprite, def?.passable === false ? "wall" : "floor"));
      s.position.set((i % CHUNK) * TILE, Math.floor(i / CHUNK) * TILE);
      view.addChild(s);
    });
    for (const e of chunk.entities) {
      const s = new Sprite(this.texture(`e:${e.type}`, bible.entities[e.type]?.sprite, "thing"));
      s.position.set(e.x * TILE, e.y * TILE);
      view.addChild(s);
    }
    if (chunk.source === "fallback") {
      view.addChild(new Graphics().rect(0, 0, CHUNK * TILE, CHUNK * TILE).fill({ color: 0x3355ff, alpha: 0.08 }));
    }
    this.chunkViews.set(key, view);
    this.chunkLayer.addChild(view);
  }

  /** Placeholders for chunks that are being generated right now. */
  setGenerating(keys: string[]) {
    this.pendingLayer.removeChildren().forEach((c) => c.destroy());
    for (const k of keys) {
      const [cx, cy] = k.split(",").map(Number);
      const g = new Graphics()
        .rect(cx * CHUNK * TILE + 2, cy * CHUNK * TILE + 2, CHUNK * TILE - 4, CHUNK * TILE - 4)
        .stroke({ color: 0xffcd75, width: 1, alpha: 0.5 });
      this.pendingLayer.addChild(g);
    }
  }

  update(facing: Dir, timeMs: number) {
    const { x, y } = this.pos;
    this.player.position.set(x * TILE + TILE / 2, y * TILE + TILE / 2);
    this.player.scale.x = facing === "left" ? -1 : 1;
    const [dx, dy] = DIRS[facing];
    const fx = Math.round(x) + dx;
    const fy = Math.round(y) + dy;
    this.marker.clear().rect(fx * TILE + 0.5, fy * TILE + 0.5, TILE - 1, TILE - 1).stroke({ color: 0xffffff, width: 1, alpha: 0.35 + 0.25 * Math.sin(timeMs / 200) });
    this.pendingLayer.alpha = 0.5 + 0.5 * Math.sin(timeMs / 300);
    this.world.position.set(
      Math.round(this.app.screen.width / 2 - (x * TILE + TILE / 2) * SCALE),
      Math.round(this.app.screen.height / 2 - (y * TILE + TILE / 2) * SCALE),
    );
  }
}

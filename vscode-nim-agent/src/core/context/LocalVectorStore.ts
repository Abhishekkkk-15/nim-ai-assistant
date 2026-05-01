import * as fs from "fs";
import * as path from "path";

export interface VectorChunkEntry {
  id: string;
  path: string;
  chunk: string;
  embedding: number[];
  lastModified: number;
  startLine: number;
  endLine: number;
  language: string;
}

interface VectorStorePayload {
  version: number;
  entries: VectorChunkEntry[];
  updatedAt: number;
}

export class LocalVectorStore {
  private entries: VectorChunkEntry[] = [];
  private readonly filePath: string;
  private lastUpdated = 0;
  private embeddingDimension?: number;

  constructor(baseDir: string, filename = "vector_index_store.json") {
    this.filePath = path.join(baseDir, filename);
    this.load();
  }

  all(): VectorChunkEntry[] {
    return this.entries;
  }

  size(): number {
    return this.entries.length;
  }

  updatedAt(): number {
    return this.lastUpdated;
  }

  clear(): void {
    this.entries = [];
    this.embeddingDimension = undefined;
    this.lastUpdated = Date.now();
  }

  removeByPath(filePath: string): void {
    this.entries = this.entries.filter((e) => e.path !== filePath);
    this.lastUpdated = Date.now();
  }

  addMany(nextEntries: VectorChunkEntry[]): void {
    if (nextEntries.length === 0) return;
    const firstDimension = nextEntries[0].embedding.length;
    if (firstDimension === 0) return;
    if (this.embeddingDimension === undefined) {
      this.embeddingDimension = firstDimension;
    }
    if (this.embeddingDimension !== firstDimension) {
      throw new Error(
        `Embedding dimension mismatch. Expected ${this.embeddingDimension}, got ${firstDimension}.`
      );
    }
    for (const entry of nextEntries) {
      if (entry.embedding.length !== this.embeddingDimension) {
        throw new Error(
          `Embedding dimension mismatch for ${entry.path}. Expected ${this.embeddingDimension}, got ${entry.embedding.length}.`
        );
      }
    }
    this.entries.push(...nextEntries);
    this.lastUpdated = Date.now();
  }

  save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const payload: VectorStorePayload = {
      version: 1,
      entries: this.entries,
      updatedAt: this.lastUpdated || Date.now(),
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload), "utf8");
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as VectorStorePayload | VectorChunkEntry[];
      if (Array.isArray(parsed)) {
        this.entries = parsed;
        this.lastUpdated = Date.now();
      } else {
        this.entries = parsed.entries || [];
        this.lastUpdated = parsed.updatedAt || Date.now();
      }
      if (this.entries.length > 0) {
        this.embeddingDimension = this.entries[0].embedding.length;
      }
    } catch {
      this.entries = [];
      this.embeddingDimension = undefined;
      this.lastUpdated = 0;
    }
  }
}

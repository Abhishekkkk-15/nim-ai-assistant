import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { ExtensionContextStore } from "../../utils/context";

interface IndexEntry {
  path: string;
  chunk: string;
  embedding: number[];
  lastModified: number;
}

export class VectorIndexService {
  private index: IndexEntry[] = [];
  private indexPath: string;
  private isIndexing = false;
  private readonly EMBEDDING_MODEL = "nvidia/nv-embedqa-e5-v5"; // Standard NIM embedding model

  constructor(private readonly store: ExtensionContextStore) {
    this.indexPath = path.join(store.context.globalStorageUri.fsPath, "vector_index.json");
    this.loadIndex();
  }

  private loadIndex() {
    if (fs.existsSync(this.indexPath)) {
      try {
        this.index = JSON.parse(fs.readFileSync(this.indexPath, "utf8"));
      } catch (err) {
        this.store.logger.error("Failed to load vector index", err);
        this.index = [];
      }
    }
  }

  private saveIndex() {
    try {
      const dir = path.dirname(this.indexPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.indexPath, JSON.stringify(this.index), "utf8");
    } catch (err) {
      this.store.logger.error("Failed to save vector index", err);
    }
  }

  async startIndexing() {
    if (this.isIndexing) return;
    this.isIndexing = true;
    this.store.logger.info("Starting background workspace indexing...");

    try {
      const files = await vscode.workspace.findFiles("**/*.{ts,js,py,go,java,c,cpp,h,md}", "**/node_modules/**");
      for (const file of files) {
        await this.indexFile(file);
      }
      this.saveIndex();
      this.store.logger.info(`Indexing complete. ${this.index.length} chunks indexed.`);
    } catch (err) {
      this.store.logger.error("Indexing failed", err);
    } finally {
      this.isIndexing = false;
    }
  }

  private async indexFile(uri: vscode.Uri) {
    const relPath = vscode.workspace.asRelativePath(uri);
    const stats = await vscode.workspace.fs.stat(uri);
    
    // Check if already indexed and up to date
    const existing = this.index.filter(e => e.path === relPath);
    if (existing.length > 0 && existing[0].lastModified >= stats.mtime) {
      return;
    }

    // Remove old entries
    this.index = this.index.filter(e => e.path !== relPath);

    const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    const chunks = this.chunkText(content, 1000); // 1000 chars per chunk
    
    if (chunks.length === 0) return;

    try {
      const provider = this.store.providerRegistry.active();
      const embeddings = await provider.embeddings(this.EMBEDDING_MODEL, chunks);
      
      for (let i = 0; i < chunks.length; i++) {
        this.index.push({
          path: relPath,
          chunk: chunks[i],
          embedding: embeddings[i],
          lastModified: stats.mtime
        });
      }
    } catch (err) {
      this.store.logger.error(`Failed to index ${relPath}`, err);
    }
  }

  private chunkText(text: string, size: number): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      chunks.push(text.slice(start, start + size));
      start += size - (size / 5); // 20% overlap
    }
    return chunks;
  }

  async search(query: string, limit = 5): Promise<{ path: string, chunk: string, score: number }[]> {
    const provider = this.store.providerRegistry.active();
    const [queryEmbedding] = await provider.embeddings(this.EMBEDDING_MODEL, [query]);

    const results = this.index.map(entry => ({
      path: entry.path,
      chunk: entry.chunk,
      score: this.cosineSimilarity(queryEmbedding, entry.embedding)
    }));

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private cosineSimilarity(v1: number[], v2: number[]): number {
    let dot = 0, n1 = 0, n2 = 0;
    for (let i = 0; i < v1.length; i++) {
      dot += v1[i] * v2[i];
      n1 += v1[i] * v1[i];
      n2 += v2[i] * v2[i];
    }
    return dot / (Math.sqrt(n1) * Math.sqrt(n2));
  }
}

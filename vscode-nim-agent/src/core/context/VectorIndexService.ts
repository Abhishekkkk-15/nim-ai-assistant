import * as vscode from "vscode";
import * as path from "path";
import type { ExtensionContextStore } from "../../utils/context";
import { LocalVectorStore, type VectorChunkEntry } from "./LocalVectorStore";

const SUPPORTED_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,java,c,cpp,h,md,rs,rb,php,cs}";
const EXCLUDED_GLOB = "**/{node_modules,dist,.git,.next,.cache,build,out,coverage}/**";
const CHUNK_LINES = 200;
const CHUNK_OVERLAP = 20;

export class VectorIndexService {
  private readonly vectorStore: LocalVectorStore;
  private isIndexing = false;
  private ready = false;
  private indexedFiles = 0;
  private failedFiles = 0;
  private readonly EMBEDDING_MODEL = "nvidia/nv-embedqa-e5-v5"; // Standard NIM embedding model

  constructor(private readonly store: ExtensionContextStore) {
    this.vectorStore = new LocalVectorStore(store.context.globalStorageUri.fsPath);
    this.ready = this.vectorStore.size() > 0;
  }

  async startIndexing() {
    if (this.isIndexing) return;
    this.isIndexing = true;
    this.indexedFiles = 0;
    this.failedFiles = 0;
    this.store.logger.info("Starting background workspace indexing...");

    try {
      const files = await vscode.workspace.findFiles(SUPPORTED_GLOB, EXCLUDED_GLOB);
      for (const file of files) {
        await this.indexFile(file);
      }
      this.vectorStore.save();
      this.ready = true;
      this.store.logger.info(
        `Indexing complete. ${this.vectorStore.size()} chunks indexed across ${this.indexedFiles} files.`
      );
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
    const existing = this.vectorStore.all().filter((e) => e.path === relPath);
    if (existing.length > 0 && existing[0].lastModified >= stats.mtime) {
      return;
    }

    // Remove old entries
    this.vectorStore.removeByPath(relPath);

    const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    const chunks = this.chunkText(relPath, content);

    if (chunks.length === 0) return;

    try {
      const provider = this.store.providerRegistry.active();
      const chunkTexts = chunks.map((chunk) => chunk.chunk);
      const embeddings = await provider.embeddings(this.EMBEDDING_MODEL, chunkTexts);
      const entries: VectorChunkEntry[] = [];

      for (let i = 0; i < chunkTexts.length; i++) {
        if (!embeddings[i]) continue;
        entries.push({
          id: `${relPath}:${chunks[i].startLine}-${chunks[i].endLine}`,
          path: relPath,
          chunk: chunkTexts[i],
          embedding: embeddings[i],
          lastModified: stats.mtime,
          startLine: chunks[i].startLine,
          endLine: chunks[i].endLine,
          language: this.inferLanguage(relPath),
        });
      }
      this.vectorStore.addMany(entries);
      this.indexedFiles += 1;
    } catch (err) {
      this.failedFiles += 1;
      this.store.logger.error(`Failed to index ${relPath}`, err);
    }
  }

  private chunkText(filePath: string, text: string): Array<{ chunk: string; startLine: number; endLine: number }> {
    const lines = text.split(/\r?\n/);
    const chunks: Array<{ chunk: string; startLine: number; endLine: number }> = [];
    if (lines.length === 0) return chunks;
    const step = Math.max(1, CHUNK_LINES - CHUNK_OVERLAP);

    for (let start = 0; start < lines.length; start += step) {
      const endExclusive = Math.min(lines.length, start + CHUNK_LINES);
      const body = lines.slice(start, endExclusive).join("\n").trim();
      if (!body) continue;
      const withHeader = `File: ${filePath}\nLines: ${start + 1}-${endExclusive}\n\n${body}`;
      chunks.push({ chunk: withHeader, startLine: start + 1, endLine: endExclusive });
      if (endExclusive >= lines.length) break;
    }

    return chunks;
  }

  async search(
    query: string,
    limit = 5
  ): Promise<{ path: string; chunk: string; score: number; startLine: number; endLine: number }[]> {
    if (this.vectorStore.size() === 0) return [];
    const provider = this.store.providerRegistry.active();
    const [queryEmbedding] = await provider.embeddings(this.EMBEDDING_MODEL, [query]);

    const results = this.vectorStore.all().map((entry) => ({
      path: entry.path,
      chunk: entry.chunk,
      startLine: entry.startLine,
      endLine: entry.endLine,
      score: this.cosineSimilarity(queryEmbedding, entry.embedding),
    }));

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  status(): { isReady: boolean; isIndexing: boolean; indexedChunks: number; indexedFiles: number; failedFiles: number; lastUpdated: number } {
    return {
      isReady: this.ready,
      isIndexing: this.isIndexing,
      indexedChunks: this.vectorStore.size(),
      indexedFiles: this.indexedFiles,
      failedFiles: this.failedFiles,
      lastUpdated: this.vectorStore.updatedAt(),
    };
  }

  isReady(): boolean {
    return this.ready;
  }

  private inferLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case ".ts":
      case ".tsx":
        return "typescript";
      case ".js":
      case ".jsx":
      case ".mjs":
      case ".cjs":
        return "javascript";
      case ".py":
        return "python";
      default:
        return ext.replace(".", "") || "text";
    }
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

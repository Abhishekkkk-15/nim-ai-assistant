import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

export interface EditRecord {
  /** Workspace-relative path. */
  path: string;
  /** Pre-edit content (empty string for newly created files). */
  before: string;
  /** Post-edit content. */
  after: string;
  /** True when the file did not exist before this run. */
  created: boolean;
  /** Convenience line-level stats. */
  added: number;
  removed: number;
}

/**
 * Captures before/after snapshots of every file edited by tools during a
 * single agent run (or a chain of handed-off runs).
 *
 * Hooked into the agent loop via the existing synchronous `onStep` callback:
 *   - On `tool_call` for a write tool we read the file BEFORE the edit so we
 *     can show a diff later.
 *   - On `tool_result` we re-read it to capture the post-edit state and
 *     compute line stats.
 *
 * I/O is intentionally synchronous (fs.readFileSync) so it can be invoked
 * from the sync `onStep` hook without races.
 */
const WRITE_TOOLS = new Set([
  "write_file",
  "replace_file_content",
  "multi_replace_file_content",
  "replace_in_file",
]);

export class EditTracker {
  private snapshots = new Map<string, EditRecord>();
  private pendingByTool = new Map<string, string>();

  static isWriteTool(name: string | undefined): boolean {
    return !!name && WRITE_TOOLS.has(name);
  }

  /** Called BEFORE a write tool executes. */
  onToolCall(toolName: string, payload: string): void {
    if (!EditTracker.isWriteTool(toolName)) return;
    const rel = parsePath(payload);
    if (!rel) return;
    this.pendingByTool.set(toolName, rel);
    if (this.snapshots.has(rel)) return;
    const abs = toAbs(rel);
    if (!abs) return;
    const { content, existed } = readSafeSync(abs);
    this.snapshots.set(rel, {
      path: rel,
      before: existed ? content : "",
      after: existed ? content : "",
      created: !existed,
      added: 0,
      removed: 0,
    });
  }

  /** Called AFTER a write tool completes. */
  onToolResult(toolName: string): void {
    if (!EditTracker.isWriteTool(toolName)) return;
    const rel = this.pendingByTool.get(toolName);
    if (!rel) return;
    this.pendingByTool.delete(toolName);
    const record = this.snapshots.get(rel);
    if (!record) return;
    const abs = toAbs(rel);
    if (!abs) return;
    const { content } = readSafeSync(abs);
    record.after = content;
    const stats = diffLineStats(record.before, record.after);
    record.added = stats.added;
    record.removed = stats.removed;
  }

  /** Returns only files whose contents actually differ between before and after. */
  list(): EditRecord[] {
    return [...this.snapshots.values()].filter(r => r.before !== r.after || r.created);
  }

  clear(): void {
    this.snapshots.clear();
    this.pendingByTool.clear();
  }

  /** Restore a single file to its captured "before" state. */
  async revert(relPath: string): Promise<boolean> {
    const record = this.snapshots.get(relPath);
    if (!record) return false;
    const abs = toAbs(relPath);
    if (!abs) return false;
    const uri = vscode.Uri.file(abs);
    if (record.created) {
      try { await vscode.workspace.fs.delete(uri); } catch { /* ignore */ }
    } else {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(record.before, "utf8"));
    }
    this.snapshots.delete(relPath);
    return true;
  }

  /** Open a side-by-side diff for the given file. */
  async showDiff(relPath: string): Promise<boolean> {
    const record = this.snapshots.get(relPath);
    if (!record) return false;
    const abs = toAbs(relPath);
    if (!abs) return false;
    const beforeFile = path.join(os.tmpdir(), `nim_before_${Date.now()}_${path.basename(relPath)}`);
    fs.writeFileSync(beforeFile, record.before);
    const beforeUri = vscode.Uri.file(beforeFile);
    const afterUri = vscode.Uri.file(abs);
    await vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri, `Review: ${relPath}`);
    return true;
  }
}

function toAbs(rel: string): string | undefined {
  if (path.isAbsolute(rel)) return rel;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return path.join(folders[0].uri.fsPath, rel);
}

function readSafeSync(abs: string): { content: string; existed: boolean } {
  try {
    const content = fs.readFileSync(abs, "utf8");
    return { content, existed: true };
  } catch {
    return { content: "", existed: false };
  }
}

function parsePath(payload: string): string | undefined {
  if (!payload) return undefined;
  try {
    const obj = JSON.parse(payload);
    const candidate = obj?.path ?? obj?.filePath ?? obj?.target;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  } catch { /* ignore */ }
  return undefined;
}

function diffLineStats(before: string, after: string): { added: number; removed: number } {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const setA = new Map<string, number>();
  for (const line of a) setA.set(line, (setA.get(line) ?? 0) + 1);
  let removed = 0, added = 0;
  for (const line of b) {
    const c = setA.get(line) ?? 0;
    if (c > 0) setA.set(line, c - 1); else added++;
  }
  for (const [, c] of setA) removed += c;
  return { added, removed };
}

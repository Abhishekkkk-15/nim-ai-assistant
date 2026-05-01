import * as vscode from "vscode";

/**
 * Loads workspace-level "rules" files (AGENTS.md / .nimrules) and exposes
 * their concatenated text for injection into every agent's system prompt.
 *
 * Files are read on demand and cached; a FileSystemWatcher invalidates the
 * cache whenever any rules file changes, is created, or is deleted.
 */
const RULE_FILE_NAMES = ["AGENTS.md", ".nimrules", ".cursorrules"] as const;
const MAX_RULES_BYTES = 40_000;

export class RulesLoader implements vscode.Disposable {
  private cached: string | undefined;
  private dirty = true;
  private watcher?: vscode.FileSystemWatcher;
  private folderListener?: vscode.Disposable;

  constructor() {
    this.attachWatchers();
    this.folderListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.invalidate();
      this.attachWatchers();
    });
  }

  /** Returns formatted rules text ready to embed in a prompt. Empty string when none. */
  async getPromptBlock(): Promise<string> {
    if (!this.dirty && this.cached !== undefined) return this.cached;
    const sections: string[] = [];
    const folders = vscode.workspace.workspaceFolders ?? [];

    for (const folder of folders) {
      for (const name of RULE_FILE_NAMES) {
        const uri = vscode.Uri.joinPath(folder.uri, name);
        try {
          const data = await vscode.workspace.fs.readFile(uri);
          let text = Buffer.from(data).toString("utf8").trim();
          if (!text) continue;
          if (text.length > MAX_RULES_BYTES) {
            text = text.slice(0, MAX_RULES_BYTES) + "\n[...truncated]";
          }
          sections.push(`# ${name} (${folder.name})\n${text}`);
        } catch { /* file not present */ }
      }
    }

    this.cached = sections.length === 0
      ? ""
      : "\n--- WORKSPACE RULES (auto-loaded; obey these) ---\n" + sections.join("\n\n") + "\n--- END WORKSPACE RULES ---\n";
    this.dirty = false;
    return this.cached;
  }

  /** List the rules files that were actually present at the last load. */
  async listLoaded(): Promise<string[]> {
    const out: string[] = [];
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      for (const name of RULE_FILE_NAMES) {
        const uri = vscode.Uri.joinPath(folder.uri, name);
        try {
          await vscode.workspace.fs.stat(uri);
          out.push(name);
        } catch { /* skip */ }
      }
    }
    return out;
  }

  private attachWatchers(): void {
    this.watcher?.dispose();
    const pattern = `{${RULE_FILE_NAMES.join(",")}}`;
    this.watcher = vscode.workspace.createFileSystemWatcher(`**/${pattern}`);
    this.watcher.onDidChange(() => this.invalidate());
    this.watcher.onDidCreate(() => this.invalidate());
    this.watcher.onDidDelete(() => this.invalidate());
  }

  private invalidate(): void {
    this.cached = undefined;
    this.dirty = true;
  }

  dispose(): void {
    this.watcher?.dispose();
    this.folderListener?.dispose();
  }
}

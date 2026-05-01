import * as vscode from "vscode";
import type { ExtensionContextStore } from "../utils/context";
import type { AgentRole } from "../core/agent/BaseAgent";

export function registerCommands(
  context: vscode.ExtensionContext,
  store: ExtensionContextStore
): void {
  const sub = (cmd: string, handler: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(cmd, handler));

  sub("nimAgent.openChat", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.nimAgent");
    await vscode.commands.executeCommand("nimAgent.chatView.focus");
  });

  sub("nimAgent.ask", async () => {
    const prompt = await vscode.window.showInputBox({
      prompt: "Ask NIM Agent",
      placeHolder: "What do you want to do?"
    });
    if (!prompt) {
      return;
    }
    await store.chatProvider.openWithPrompt(prompt);
  });

  sub("nimAgent.refactor", async () => {
    const prompt = await buildEditorActionPrompt(
      "Refactor the selected code for clarity and maintainability while preserving behavior. Show the full updated file via write_file."
    );
    if (!prompt) {
      return;
    }
    await store.chatProvider.openWithPrompt(prompt, "refactor");
  });

  sub("nimAgent.fix", async () => {
    const prompt = await buildEditorActionPrompt(
      "Find and fix the bug(s) in the selected code (or the active file if no selection). Use write_file to apply the fix and explain the root cause."
    );
    if (!prompt) {
      return;
    }
    await store.chatProvider.openWithPrompt(prompt, "debugger");
  });

  sub("nimAgent.explain", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("Open a file first.");
      return;
    }
    const path = vscode.workspace.asRelativePath(editor.document.uri);
    await store.chatProvider.openWithPrompt(
      `Explain the file ${path}. Cover: purpose, key entry points, important functions, and any notable patterns or risks.`,
      "chat"
    );
  });

  sub("nimAgent.addApiKey", async () => {
    const key = await vscode.window.showInputBox({
      prompt: "Paste your NVIDIA NIM API key",
      password: true,
      ignoreFocusOut: true
    });
    if (!key) {
      return;
    }
    try {
      await store.apiKeyManager.addKey(key);
      store.chatProvider.refreshState();
      vscode.window.showInformationMessage(
        `API key added. Total keys: ${store.apiKeyManager.count()}.`
      );
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  sub("nimAgent.removeApiKey", async () => {
    const items = store.apiKeyManager.list().map((k) => ({
      label: k.masked,
      description: `failures: ${k.failures}${k.cooldownMs > 0 ? `, cooldown ${Math.round(k.cooldownMs / 1000)}s` : ""}`
    }));
    if (items.length === 0) {
      vscode.window.showInformationMessage("No API keys to remove.");
      return;
    }
    const choice = await vscode.window.showQuickPick(items, { placeHolder: "Select a key to remove" });
    if (!choice) {
      return;
    }
    try {
      await store.apiKeyManager.removeKey(choice.label);
      store.chatProvider.refreshState();
      vscode.window.showInformationMessage("Key removed.");
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  sub("nimAgent.selectModel", async () => {
    const models = store.modelManager.enabled();
    if (models.length === 0) {
      vscode.window.showWarningMessage(
        "No enabled models. Add one under nimAgent.models in settings."
      );
      return;
    }
    const choice = await vscode.window.showQuickPick(
      models.map((m) => ({ label: m.name })),
      { placeHolder: "Select active model" }
    );
    if (!choice) {
      return;
    }
    try {
      store.modelManager.setActive(choice.label);
      await vscode.workspace
        .getConfiguration("nimAgent")
        .update("defaultModel", choice.label, vscode.ConfigurationTarget.Global);
      store.chatProvider.refreshState();
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  sub("nimAgent.selectAgent", async () => {
    const agents = store.agentRegistry.list();
    const choice = await vscode.window.showQuickPick(
      agents.map((a) => ({ label: a.label, description: a.role })),
      { placeHolder: "Select active agent" }
    );
    if (!choice) {
      return;
    }
    const role = choice.description as AgentRole;
    await vscode.workspace
      .getConfiguration("nimAgent")
      .update("defaultAgent", role, vscode.ConfigurationTarget.Global);
    store.chatProvider.refreshState();
  });

  sub("nimAgent.clearMemory", () => {
    store.memory.clear();
    vscode.window.showInformationMessage("NIM Agent conversation memory cleared.");
  });
}

async function buildEditorActionPrompt(instruction: string): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Open a file first.");
    return undefined;
  }
  const path = vscode.workspace.asRelativePath(editor.document.uri);
  const selection = editor.selection.isEmpty ? "" : editor.document.getText(editor.selection);
  const range = editor.selection.isEmpty
    ? "(no selection — operate on the whole file)"
    : `lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`;
  const snippet = selection
    ? `\n\nSelected code (${range}):\n\`\`\`\n${selection}\n\`\`\``
    : "";
  return `${instruction}\n\nFile: ${path} ${range}${snippet}`;
}

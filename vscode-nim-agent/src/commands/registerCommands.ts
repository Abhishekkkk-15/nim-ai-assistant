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
    const providers = [
      { label: "NVIDIA NIM", id: "nvidia-nim" },
      { label: "Groq", id: "groq" },
      { label: "OpenRouter", id: "openrouter" },
      { label: "Other (OpenAI Compatible)", id: "custom" }
    ];

    const providerChoice = await vscode.window.showQuickPick(providers, {
      placeHolder: "Select the provider for this API key"
    });

    if (!providerChoice) return;

    let providerId = providerChoice.id;
    if (providerId === "custom") {
      providerId = await vscode.window.showInputBox({
        prompt: "Enter the custom Provider ID",
        placeHolder: "e.g. ollama, deepseek, etc."
      }) || "";
      if (!providerId) return;
    }

    const key = await vscode.window.showInputBox({
      prompt: `Paste your API key for ${providerChoice.label}`,
      password: true,
      ignoreFocusOut: true
    });
    if (!key) {
      return;
    }
    try {
      await store.apiKeyManager.addKey(providerId, key);
      store.chatProvider.refreshState();
      vscode.window.showInformationMessage(
        `API key added for ${providerId}. Total keys for this provider: ${store.apiKeyManager.count(providerId)}.`
      );
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  sub("nimAgent.removeApiKey", async () => {
    // First ask which provider
    const providers = vscode.workspace.getConfiguration("nimAgent").get<any[]>("providers", [])
      .map(p => ({ label: p.label || p.id, id: p.id }));
    
    // Add defaults if missing
    if (!providers.some(p => p.id === "nvidia-nim")) providers.push({ label: "NVIDIA NIM", id: "nvidia-nim" });
    if (!providers.some(p => p.id === "groq")) providers.push({ label: "Groq", id: "groq" });
    if (!providers.some(p => p.id === "openrouter")) providers.push({ label: "OpenRouter", id: "openrouter" });

    const providerChoice = await vscode.window.showQuickPick(providers, {
      placeHolder: "Select provider to manage keys"
    });
    if (!providerChoice) return;

    const items = store.apiKeyManager.list(providerChoice.id).map((k) => ({
      label: k.masked,
      description: `failures: ${k.failures}${k.cooldownMs > 0 ? `, cooldown ${Math.round(k.cooldownMs / 1000)}s` : ""}`
    }));
    if (items.length === 0) {
      vscode.window.showInformationMessage(`No API keys found for ${providerChoice.label}.`);
      return;
    }
    const choice = await vscode.window.showQuickPick(items, { placeHolder: `Select a ${providerChoice.label} key to remove` });
    if (!choice) {
      return;
    }
    try {
      await store.apiKeyManager.removeKey(providerChoice.id, choice.label);
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

  sub("nimAgent.addModel", async () => {
    const providers = [
      { label: "NVIDIA NIM", id: "nvidia-nim" },
      { label: "Groq", id: "groq" },
      { label: "OpenRouter", id: "openrouter" },
      { label: "Other", id: "custom" }
    ];

    const providerChoice = await vscode.window.showQuickPick(providers, {
      placeHolder: "Select provider for the new model"
    });
    if (!providerChoice) return;

    let providerId = providerChoice.id;
    if (providerId === "custom") {
      providerId = await vscode.window.showInputBox({
        prompt: "Enter Custom Provider ID",
        placeHolder: "e.g. ollama, deepseek"
      }) || "";
      if (!providerId) return;
    }

    const modelName = await vscode.window.showInputBox({
      prompt: `Enter the model string for ${providerId}`,
      placeHolder: "e.g. meta-llama/llama-3.1-405b-instruct"
    });
    if (!modelName) return;

    try {
      await store.modelManager.addModel(modelName, providerId);
      store.chatProvider.refreshState();
      vscode.window.showInformationMessage(`Model ${modelName} added for ${providerId}.`);
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

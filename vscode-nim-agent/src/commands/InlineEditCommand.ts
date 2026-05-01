import * as vscode from "vscode";
import * as path from "path";
import { Logger } from "../utils/logger";
import { tokenToSignal } from "../utils/signal";
import type { ExtensionContextStore } from "../utils/context";

export function registerInlineEditCommand(context: vscode.ExtensionContext, store: ExtensionContextStore) {
  const disposable = vscode.commands.registerCommand("nimAgent.inlineEdit", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("No active editor.");
      return;
    }

    const selection = editor.selection;
    const document = editor.document;
    const textToEdit = document.getText(selection);

    if (!textToEdit) {
      vscode.window.showInformationMessage("Please select some code to edit first.");
      return;
    }

    const instruction = await vscode.window.showInputBox({
      prompt: "What should NIM Agent do with this code?",
      placeHolder: "e.g., Refactor to use async/await, add error handling, etc."
    });

    if (!instruction) {
      return; // user cancelled
    }

    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "NIM Agent is editing...",
        cancellable: true
      },
      async (progress, token) => {
        try {
          const provider = store.providerRegistry.active();
          const model = store.modelManager.getActive();

          const systemPrompt = `You are an expert coding assistant. The user wants to modify a specific snippet of code from a file named '${path.basename(document.fileName)}'.
Language: ${document.languageId}

INSTRUCTIONS:
1. Apply the user's requested changes to the provided code.
2. Return ONLY the final replacement code.
3. DO NOT include any markdown formatting like \`\`\`typescript or \`\`\`.
4. DO NOT include any explanations or conversational text. Just the raw code.`;

          const result = await provider.chatComplete(
            {
              model,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Code to edit:\n\n${textToEdit}\n\nRequested Change: ${instruction}` }
              ],
              temperature: 0.2
            },
            { signal: tokenToSignal(token) }
          );

          if (token.isCancellationRequested) {
            return;
          }

          let replacement = result.content.trim();
          
          // Cleanup markdown block if the model accidentally included it
          if (replacement.startsWith("\`\`\`")) {
            const lines = replacement.split("\n");
            if (lines.length > 2) {
              lines.shift(); // remove opening ```lang
              if (lines[lines.length - 1].startsWith("\`\`\`")) {
                lines.pop(); // remove closing ```
              }
              replacement = lines.join("\n");
            }
          }

          const success = await editor.edit((editBuilder) => {
            editBuilder.replace(selection, replacement);
          });

          if (success) {
            vscode.window.showInformationMessage("Inline edit applied. Press Ctrl+Z to undo.");
          } else {
            vscode.window.showErrorMessage("Failed to apply the edit.");
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Inline edit failed: ${(err as Error).message}`);
        }
      }
    );
  });

  context.subscriptions.push(disposable);
}

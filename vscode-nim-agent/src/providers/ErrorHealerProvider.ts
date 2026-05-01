import * as vscode from "vscode";
import * as path from "path";
import { ExtensionContextStore } from "../utils/context";
import { tokenToSignal } from "../utils/signal";

export class ErrorHealerProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    // Filter to only errors or warnings
    const issues = context.diagnostics.filter(
      (d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning
    );

    if (issues.length === 0) {
      return actions;
    }

    // Create a Quick Fix action for the first major issue
    const issue = issues[0];
    const action = new vscode.CodeAction("✨ Fix with NIM Agent", vscode.CodeActionKind.QuickFix);
    action.isPreferred = true;
    
    // Command to execute the fix
    action.command = {
      command: "nimAgent.healError",
      title: "Fix with NIM Agent",
      arguments: [document, issue]
    };

    actions.push(action);
    return actions;
  }
}

export function registerErrorHealer(context: vscode.ExtensionContext, store: ExtensionContextStore) {
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider("*", new ErrorHealerProvider(), {
      providedCodeActionKinds: ErrorHealerProvider.providedCodeActionKinds
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nimAgent.healError", async (document: vscode.TextDocument, diagnostic: vscode.Diagnostic) => {
      // Get the range with a few lines of surrounding context
      const startLine = Math.max(0, diagnostic.range.start.line - 5);
      const endLine = Math.min(document.lineCount - 1, diagnostic.range.end.line + 5);
      const replaceRange = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
      const textToEdit = document.getText(replaceRange);

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "NIM Agent is healing the error...",
          cancellable: true
        },
        async (progress, token) => {
          try {
            const agent = store.agentRegistry.get("coder");
            if (!agent) throw new Error("Coder agent not found");
            const fileName = path.basename(document.fileName);

            const result = await agent.run({
              prompt: `You are an expert compiler and syntax error healer. 
The user has an error in their code: "${diagnostic.message}"

Language: ${document.languageId}
File: ${fileName}

INSTRUCTIONS:
1. Fix the error in the provided code block.
2. Return ONLY the final, complete replacement code block that should substitute the original.
3. DO NOT include markdown formatting (\`\`\`). DO NOT include explanations.

Code to fix:
${textToEdit}

Error: ${diagnostic.message}`,
              signal: tokenToSignal(token)
            });

            if (token.isCancellationRequested) return;

            let replacement = result.content.trim();
            if (replacement.startsWith("\`\`\`")) {
              const lines = replacement.split("\n");
              if (lines.length > 2) {
                lines.shift(); 
                if (lines[lines.length - 1].startsWith("\`\`\`")) lines.pop();
                replacement = lines.join("\n");
              }
            }

            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, replaceRange, replacement);
            const success = await vscode.workspace.applyEdit(edit);

            if (success) {
              vscode.window.showInformationMessage("Error healed. Press Ctrl+Z to undo if incorrect.");
            } else {
              vscode.window.showErrorMessage("Failed to apply the fix.");
            }
          } catch (err) {
            vscode.window.showErrorMessage(`Healing failed: ${(err as Error).message}`);
          }
        }
      );
    })
  );
}

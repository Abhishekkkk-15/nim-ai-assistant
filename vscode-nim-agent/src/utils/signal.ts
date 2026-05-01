import * as vscode from "vscode";

/**
 * Converts a VS Code CancellationToken to a standard AbortSignal.
 */
export function tokenToSignal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  }
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

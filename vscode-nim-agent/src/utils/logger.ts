import * as vscode from "vscode";

export type LogLevel = "debug" | "info" | "warn" | "error";

export class Logger {
  private readonly channel: vscode.OutputChannel;

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name);
  }

  debug(msg: string, ...rest: unknown[]): void {
    this.write("debug", msg, rest);
  }
  info(msg: string, ...rest: unknown[]): void {
    this.write("info", msg, rest);
  }
  warn(msg: string, ...rest: unknown[]): void {
    this.write("warn", msg, rest);
  }
  error(msg: string, ...rest: unknown[]): void {
    this.write("error", msg, rest);
  }

  show(): void {
    this.channel.show(true);
  }

  private write(level: LogLevel, msg: string, rest: unknown[]): void {
    const ts = new Date().toISOString();
    const extras = rest.length
      ? " " +
        rest
          .map((r) => {
            if (r instanceof Error) {
              return `${r.message}\n${r.stack ?? ""}`;
            }
            try {
              return typeof r === "string" ? r : JSON.stringify(r);
            } catch {
              return String(r);
            }
          })
          .join(" ")
      : "";
    this.channel.appendLine(`[${ts}] [${level.toUpperCase()}] ${msg}${extras}`);
  }
}

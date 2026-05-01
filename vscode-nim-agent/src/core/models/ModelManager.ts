import * as vscode from "vscode";
import type { Logger } from "../../utils/logger";

export interface ModelConfig {
  name: string;
  providerId: string;
  enabled: boolean;
}

/**
 * Tracks the list of NIM models the user has configured plus the active one.
 * Backed by VS Code settings (`nimAgent.models`, `nimAgent.defaultModel`).
 */
export class ModelManager {
  private models: ModelConfig[] = [];
  private active: string | undefined;

  constructor(private readonly logger: Logger) {}

  loadFromConfig(): void {
    const config = vscode.workspace.getConfiguration("nimAgent");
    const raw = config.get<ModelConfig[]>("models", []) ?? [];
    this.models = raw
      .filter((m) => m && typeof m.name === "string" && m.name.length > 0)
      .map((m) => ({ 
        name: m.name, 
        providerId: m.providerId || "nvidia-nim", // Default to NIM for migration
        enabled: m.enabled !== false 
      }));

    const def = config.get<string>("defaultModel", "");
    if (def && this.models.some((m) => m.name === def && m.enabled)) {
      this.active = def;
    } else {
      this.active = this.models.find((m) => m.enabled)?.name;
    }
    this.logger.info(
      `Loaded ${this.models.length} model(s); active=${this.active ?? "(none)"}`
    );
  }

  list(): ModelConfig[] {
    return [...this.models];
  }

  enabled(): ModelConfig[] {
    return this.models.filter((m) => m.enabled);
  }

  getActive(): string {
    if (!this.active) {
      throw new Error(
        "No active model selected. Add a model under nimAgent.models or run \"NIM Agent: Select Active Model\"."
      );
    }
    return this.active;
  }

  getProviderForModel(modelName: string): string {
    const m = this.models.find(m => m.name === modelName);
    return m?.providerId || "nvidia-nim";
  }

  setActive(name: string): void {
    if (!this.models.some((m) => m.name === name)) {
      throw new Error(`Model "${name}" is not in nimAgent.models.`);
    }
    this.active = name;
  }

  async addModel(name: string, providerId: string = "nvidia-nim"): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Model name cannot be empty.");
    }
    if (this.models.some((m) => m.name === trimmed)) {
      throw new Error("Model already exists.");
    }
    this.models.push({ name: trimmed, providerId, enabled: true });
    await this.persist();
  }

  async removeModel(name: string): Promise<void> {
    const before = this.models.length;
    this.models = this.models.filter((m) => m.name !== name);
    if (this.models.length === before) {
      throw new Error("Model not found.");
    }
    if (this.active === name) {
      this.active = this.models.find((m) => m.enabled)?.name;
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    const config = vscode.workspace.getConfiguration("nimAgent");
    await config.update("models", this.models, vscode.ConfigurationTarget.Global);
    if (this.active) {
      await config.update("defaultModel", this.active, vscode.ConfigurationTarget.Global);
    }
  }
}

import * as vscode from "vscode";
import type { Logger } from "../utils/logger";
import { BaseProvider, ProviderConfig } from "./BaseProvider";
import { NimClient } from "./NimClient";
import type { ApiKeyManager } from "./ApiKeyManager";

/**
 * Registry that maps provider IDs to instances.
 * Designed to be extended (OpenAI, Anthropic, local, etc.).
 */
export class ProviderRegistry {
  private providers = new Map<string, BaseProvider>();
  private activeId: string | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly keys: ApiKeyManager
  ) {}

  loadFromConfig(): void {
    const config = vscode.workspace.getConfiguration("nimAgent");
    const apiBaseUrl = config.get<string>("apiBaseUrl", "https://integrate.api.nvidia.com/v1");
    const providers = config.get<ProviderConfig[]>("providers", []);

    this.providers.clear();
    this.activeId = undefined;

    if (providers.length === 0) {
      // Fallback to a default NIM provider built from apiBaseUrl
      this.register(
        new NimClient(
          { id: "nvidia-nim", label: "NVIDIA NIM", baseUrl: apiBaseUrl, active: true },
          this.keys,
          this.logger
        )
      );
      this.activeId = "nvidia-nim";
      return;
    }

    for (const cfg of providers) {
      // Currently the only provider implementation is the NIM/OpenAI-compatible one.
      // Adding e.g. an Anthropic adapter is a matter of switching on cfg.id here.
      const baseUrl = cfg.baseUrl || apiBaseUrl;
      this.register(new NimClient({ ...cfg, baseUrl }, this.keys, this.logger));
      if (cfg.active && !this.activeId) {
        this.activeId = cfg.id;
      }
    }
    if (!this.activeId && providers[0]) {
      this.activeId = providers[0].id;
    }
  }

  register(provider: BaseProvider): void {
    this.providers.set(provider.id, provider);
  }

  list(): BaseProvider[] {
    return [...this.providers.values()];
  }

  active(): BaseProvider {
    if (!this.activeId) {
      throw new Error("No active LLM provider configured.");
    }
    const provider = this.providers.get(this.activeId);
    if (!provider) {
      throw new Error(`Active provider "${this.activeId}" not found in registry.`);
    }
    return provider;
  }

  setActive(id: string): void {
    if (!this.providers.has(id)) {
      throw new Error(`Unknown provider: ${id}`);
    }
    this.activeId = id;
  }
}

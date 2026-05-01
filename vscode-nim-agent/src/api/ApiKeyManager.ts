import * as vscode from "vscode";
import type { Logger } from "../utils/logger";

const SECRET_KEY = "nimAgent.apiKeys";
const MAX_KEYS = 3;

interface KeyEntry {
  key: string;
  failures: number;
  lastUsedAt: number;
  cooldownUntil: number;
}

/**
 * Manages up to 3 API keys with round-robin rotation.
 * On 429 / failure the active key is penalized and the next healthy key is used.
 * Storage prefers VS Code SecretStorage but falls back to settings.json.
 */
export class ApiKeyManager {
  private entries: KeyEntry[] = [];
  private cursor = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger
  ) {}

  async load(): Promise<void> {
    const useSecret = this.useSecretStorage();
    let keys: string[] = [];

    if (useSecret) {
      const raw = await this.context.secrets.get(SECRET_KEY);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            keys = parsed.filter((k) => typeof k === "string" && k.length > 0);
          }
        } catch (err) {
          this.logger.warn("Could not parse secret-stored API keys; ignoring.", err);
        }
      }
    }

    // Always merge in any keys that the user put in settings.json so we don't lose them
    const config = vscode.workspace.getConfiguration("nimAgent");
    const fromSettings = config.get<string[]>("apiKeys", []) ?? [];
    for (const k of fromSettings) {
      if (typeof k === "string" && k.length > 0 && !keys.includes(k)) {
        keys.push(k);
      }
    }

    keys = keys.slice(0, MAX_KEYS);
    this.entries = keys.map((key) => ({ key, failures: 0, lastUsedAt: 0, cooldownUntil: 0 }));
    this.cursor = 0;
    this.logger.info(`Loaded ${this.entries.length} API key(s).`);
  }

  hasKeys(): boolean {
    return this.entries.length > 0;
  }

  count(): number {
    return this.entries.length;
  }

  /**
   * Pick the next healthy key in round-robin order.
   * Skips keys whose cooldown has not yet expired.
   */
  next(): string | undefined {
    if (this.entries.length === 0) {
      return undefined;
    }
    const now = Date.now();
    for (let i = 0; i < this.entries.length; i++) {
      const idx = (this.cursor + i) % this.entries.length;
      const entry = this.entries[idx];
      if (entry.cooldownUntil <= now) {
        this.cursor = (idx + 1) % this.entries.length;
        entry.lastUsedAt = now;
        return entry.key;
      }
    }
    // All keys are cooling down — return the soonest-available one anyway.
    const fallback = this.entries.reduce((a, b) => (a.cooldownUntil < b.cooldownUntil ? a : b));
    fallback.lastUsedAt = now;
    return fallback.key;
  }

  /**
   * Mark a key as failing. 429 responses trigger a longer cooldown.
   */
  reportFailure(key: string, status?: number): void {
    const entry = this.entries.find((e) => e.key === key);
    if (!entry) {
      return;
    }
    entry.failures += 1;
    const baseCooldown = status === 429 ? 30_000 : 5_000;
    entry.cooldownUntil = Date.now() + baseCooldown * Math.min(entry.failures, 6);
    this.logger.warn(
      `API key ${this.maskKey(key)} penalized (status=${status ?? "n/a"}, failures=${entry.failures}).`
    );
  }

  reportSuccess(key: string): void {
    const entry = this.entries.find((e) => e.key === key);
    if (!entry) {
      return;
    }
    entry.failures = 0;
    entry.cooldownUntil = 0;
  }

  async addKey(key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) {
      throw new Error("API key cannot be empty.");
    }
    if (this.entries.some((e) => e.key === trimmed)) {
      throw new Error("This API key is already registered.");
    }
    if (this.entries.length >= MAX_KEYS) {
      throw new Error(`Cannot register more than ${MAX_KEYS} API keys.`);
    }
    this.entries.push({ key: trimmed, failures: 0, lastUsedAt: 0, cooldownUntil: 0 });
    await this.persist();
  }

  async removeKey(maskedOrFull: string): Promise<void> {
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (e) => e.key !== maskedOrFull && this.maskKey(e.key) !== maskedOrFull
    );
    if (this.entries.length === before) {
      throw new Error("Key not found.");
    }
    await this.persist();
  }

  list(): { masked: string; failures: number; cooldownMs: number }[] {
    const now = Date.now();
    return this.entries.map((e) => ({
      masked: this.maskKey(e.key),
      failures: e.failures,
      cooldownMs: Math.max(0, e.cooldownUntil - now)
    }));
  }

  private async persist(): Promise<void> {
    if (this.useSecretStorage()) {
      await this.context.secrets.store(SECRET_KEY, JSON.stringify(this.entries.map((e) => e.key)));
      // Also clear settings.json copies so we don't leave keys in plaintext.
      const config = vscode.workspace.getConfiguration("nimAgent");
      if ((config.get<string[]>("apiKeys", []) ?? []).length > 0) {
        await config.update("apiKeys", [], vscode.ConfigurationTarget.Global);
      }
    } else {
      const config = vscode.workspace.getConfiguration("nimAgent");
      await config.update(
        "apiKeys",
        this.entries.map((e) => e.key),
        vscode.ConfigurationTarget.Global
      );
    }
  }

  private useSecretStorage(): boolean {
    return vscode.workspace.getConfiguration("nimAgent").get<boolean>("useSecretStorage", true);
  }

  private maskKey(key: string): string {
    if (key.length <= 8) {
      return "***";
    }
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
  }
}

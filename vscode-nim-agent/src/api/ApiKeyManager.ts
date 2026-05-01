import * as vscode from "vscode";
import type { Logger } from "../utils/logger";

const SECRET_KEY = "nimAgent.providerKeys";
const OLD_SECRET_KEY = "nimAgent.apiKeys"; // For backward compatibility
const MAX_KEYS_PER_PROVIDER = 3;

interface KeyEntry {
  key: string;
  failures: number;
  lastUsedAt: number;
  cooldownUntil: number;
}

/**
 * Manages API keys per provider (e.g., 'nvidia-nim', 'groq', 'openrouter').
 * Supports round-robin rotation per provider and cooldowns on 429 errors.
 */
export class ApiKeyManager {
  // Map of providerId -> array of KeyEntries
  private providerEntries = new Map<string, KeyEntry[]>();
  private cursors = new Map<string, number>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger
  ) {}

  async load(): Promise<void> {
    const useSecret = this.useSecretStorage();
    let keysMap: Record<string, string[]> = {};

    if (useSecret) {
      // 1. Try to load the new multi-provider format
      let raw = await this.context.secrets.get(SECRET_KEY);
      if (raw) {
        try {
          keysMap = JSON.parse(raw);
        } catch (err) {
          this.logger.warn("Could not parse secret-stored provider keys; ignoring.", err);
        }
      } else {
        // 2. Backward compatibility: check if the old flat array exists
        const oldRaw = await this.context.secrets.get(OLD_SECRET_KEY);
        if (oldRaw) {
          try {
            const parsed = JSON.parse(oldRaw);
            if (Array.isArray(parsed)) {
              keysMap["nvidia-nim"] = parsed.filter((k) => typeof k === "string" && k.length > 0);
              // Migrate and clean up old key
              await this.persistMap(keysMap);
              await this.context.secrets.delete(OLD_SECRET_KEY);
            }
          } catch (err) {
            // ignore
          }
        }
      }
    }

    // Merge in any keys from settings.json (fallback)
    const config = vscode.workspace.getConfiguration("nimAgent");
    
    // Check old config format
    const oldConfigKeys = config.get<string[]>("apiKeys", []);
    if (oldConfigKeys.length > 0) {
      if (!keysMap["nvidia-nim"]) keysMap["nvidia-nim"] = [];
      for (const k of oldConfigKeys) {
        if (!keysMap["nvidia-nim"].includes(k)) keysMap["nvidia-nim"].push(k);
      }
    }

    // Check new config format (if we decide to add it later, for now we just use secret storage)
    const newConfigKeys = config.get<Record<string, string[]>>("providerKeys", {});
    for (const [providerId, keys] of Object.entries(newConfigKeys)) {
      if (!keysMap[providerId]) keysMap[providerId] = [];
      for (const k of keys) {
        if (!keysMap[providerId].includes(k)) keysMap[providerId].push(k);
      }
    }

    this.providerEntries.clear();
    this.cursors.clear();

    let totalKeys = 0;
    for (const [providerId, keys] of Object.entries(keysMap)) {
      const validKeys = keys.slice(0, MAX_KEYS_PER_PROVIDER);
      this.providerEntries.set(providerId, validKeys.map(key => ({ key, failures: 0, lastUsedAt: 0, cooldownUntil: 0 })));
      this.cursors.set(providerId, 0);
      totalKeys += validKeys.length;
    }

    this.logger.info(`Loaded ${totalKeys} API key(s) across ${this.providerEntries.size} provider(s).`);
  }

  hasKeys(providerId?: string): boolean {
    if (providerId) {
      const entries = this.providerEntries.get(providerId);
      return !!entries && entries.length > 0;
    }
    return Array.from(this.providerEntries.values()).some(entries => entries.length > 0);
  }

  count(providerId?: string): number {
    if (providerId) {
      return this.providerEntries.get(providerId)?.length || 0;
    }
    let total = 0;
    for (const entries of this.providerEntries.values()) {
      total += entries.length;
    }
    return total;
  }

  next(providerId: string): string | undefined {
    const entries = this.providerEntries.get(providerId);
    if (!entries || entries.length === 0) {
      return undefined;
    }
    
    const cursor = this.cursors.get(providerId) || 0;
    const now = Date.now();
    
    for (let i = 0; i < entries.length; i++) {
      const idx = (cursor + i) % entries.length;
      const entry = entries[idx];
      if (entry.cooldownUntil <= now) {
        this.cursors.set(providerId, (idx + 1) % entries.length);
        entry.lastUsedAt = now;
        return entry.key;
      }
    }
    
    // All keys are cooling down — return the soonest-available one anyway.
    const fallback = entries.reduce((a, b) => (a.cooldownUntil < b.cooldownUntil ? a : b));
    fallback.lastUsedAt = now;
    return fallback.key;
  }

  reportFailure(providerId: string, key: string, status?: number): void {
    const entries = this.providerEntries.get(providerId);
    if (!entries) return;
    
    const entry = entries.find((e) => e.key === key);
    if (!entry) return;
    
    entry.failures += 1;
    const baseCooldown = status === 429 ? 30_000 : 5_000;
    entry.cooldownUntil = Date.now() + baseCooldown * Math.min(entry.failures, 6);
    this.logger.warn(`API key for ${providerId} (${this.maskKey(key)}) penalized (status=${status ?? "n/a"}, failures=${entry.failures}).`);
  }

  reportSuccess(providerId: string, key: string): void {
    const entries = this.providerEntries.get(providerId);
    if (!entries) return;

    const entry = entries.find((e) => e.key === key);
    if (!entry) return;
    
    entry.failures = 0;
    entry.cooldownUntil = 0;
  }

  async addKey(providerId: string, key: string): Promise<void> {
    if (!key || typeof key.trim !== "function") {
      throw new Error("Invalid API key provided.");
    }
    const trimmed = key.trim();
    if (!trimmed) throw new Error("API key cannot be empty.");
    
    let entries = this.providerEntries.get(providerId);
    if (!entries) {
      entries = [];
      this.providerEntries.set(providerId, entries);
    }

    if (entries.some((e) => e.key === trimmed)) {
      throw new Error(`This API key is already registered for ${providerId}.`);
    }
    if (entries.length >= MAX_KEYS_PER_PROVIDER) {
      throw new Error(`Cannot register more than ${MAX_KEYS_PER_PROVIDER} keys for ${providerId}.`);
    }
    
    entries.push({ key: trimmed, failures: 0, lastUsedAt: 0, cooldownUntil: 0 });
    await this.persist();
  }

  async removeKey(providerId: string, maskedOrFull: string): Promise<void> {
    const entries = this.providerEntries.get(providerId);
    if (!entries) throw new Error("No keys found for this provider.");

    const before = entries.length;
    const updated = entries.filter((e) => e.key !== maskedOrFull && this.maskKey(e.key) !== maskedOrFull);
    
    if (updated.length === before) {
      throw new Error("Key not found.");
    }
    
    if (updated.length === 0) {
      this.providerEntries.delete(providerId);
    } else {
      this.providerEntries.set(providerId, updated);
    }
    
    await this.persist();
  }

  list(providerId: string): { masked: string; failures: number; cooldownMs: number }[] {
    const entries = this.providerEntries.get(providerId) || [];
    const now = Date.now();
    return entries.map((e) => ({
      masked: this.maskKey(e.key),
      failures: e.failures,
      cooldownMs: Math.max(0, e.cooldownUntil - now)
    }));
  }

  private async persist(): Promise<void> {
    const mapToSave: Record<string, string[]> = {};
    for (const [providerId, entries] of this.providerEntries.entries()) {
      mapToSave[providerId] = entries.map(e => e.key);
    }
    await this.persistMap(mapToSave);
  }

  private async persistMap(keysMap: Record<string, string[]>): Promise<void> {
    if (this.useSecretStorage()) {
      await this.context.secrets.store(SECRET_KEY, JSON.stringify(keysMap));
      // Clear legacy
      const config = vscode.workspace.getConfiguration("nimAgent");
      if ((config.get<string[]>("apiKeys", []) ?? []).length > 0) {
        await config.update("apiKeys", [], vscode.ConfigurationTarget.Global);
      }
    } else {
      const config = vscode.workspace.getConfiguration("nimAgent");
      await config.update("providerKeys", keysMap, vscode.ConfigurationTarget.Global);
    }
  }

  private useSecretStorage(): boolean {
    return vscode.workspace.getConfiguration("nimAgent").get<boolean>("useSecretStorage", true);
  }

  private maskKey(key: string): string {
    if (key.length <= 8) return "***";
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
  }
}

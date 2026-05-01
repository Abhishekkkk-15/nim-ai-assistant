/**
 * Tiny LRU cache for prompt -> response pairs.
 * Optional optimization to skip a network call when an identical request was
 * just answered.
 */
export class LocalCache {
  private map = new Map<string, string>();

  constructor(private readonly maxEntries: number) {}

  get(key: string): string | undefined {
    const value = this.map.get(key);
    if (value === undefined) {
      return undefined;
    }
    // Re-insert to make it the most-recently-used.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: string): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

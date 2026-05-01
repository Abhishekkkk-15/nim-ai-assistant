import type { ChatMessage } from "../../api/BaseProvider";

export interface ConversationTurn {
  id: string;
  agent: string;
  model: string;
  messages: ChatMessage[];
  createdAt: number;
}

/**
 * Bounded short-term memory of recent chat turns.
 * Used to give agents conversational continuity within a session.
 */
export class ConversationMemory {
  private turns: ConversationTurn[] = [];
  private summary = "";
  private readonly summaryThreshold = 10;
  private readonly retainRecentTurns = 6;

  constructor(private readonly maxTurns: number) {}

  add(turn: ConversationTurn): void {
    this.turns.push(turn);
    this.maybeSummarize();
    if (this.turns.length > this.maxTurns) {
      this.turns.splice(0, this.turns.length - this.maxTurns);
    }
  }

  recent(count = 10): ConversationTurn[] {
    return this.turns.slice(-count);
  }

  /**
   * Flatten the last `count` turns into a single chat-message array suitable
   * for use as context in the next request. System messages are dropped.
   */
  asMessages(count = 10): ChatMessage[] {
    const out: ChatMessage[] = [];
    if (this.summary) {
      out.push({ role: "assistant", content: `[Conversation Summary]\n${this.summary}` });
    }
    for (const turn of this.recent(count)) {
      for (const msg of turn.messages) {
        if (msg.role === "user" || msg.role === "assistant") {
          out.push(msg);
        }
      }
    }
    return out;
  }

  clear(): void {
    this.turns = [];
    this.summary = "";
  }

  /**
   * Seeds the memory with a list of messages (useful for loading history).
   * It wraps the messages into a single legacy turn.
   */
  seed(messages: ChatMessage[]): void {
    this.clear();
    if (messages.length === 0) return;
    for (let i = 0; i < messages.length; i += 2) {
      const chunk = messages.slice(i, i + 2);
      this.turns.push({
        id: `seed_${i}`,
        agent: "history",
        model: "unknown",
        messages: chunk,
        createdAt: Date.now() + i,
      });
    }
    this.maybeSummarize();
  }

  size(): number {
    return this.turns.length;
  }

  private maybeSummarize(): void {
    if (this.turns.length <= this.summaryThreshold) return;
    const toCompress = this.turns.slice(0, this.turns.length - this.retainRecentTurns);
    if (toCompress.length === 0) return;
    const compressed = this.buildStructuredSummary(toCompress);
    this.summary = this.summary
      ? `${this.summary}\n\n${compressed}`
      : compressed;
    this.turns = this.turns.slice(-this.retainRecentTurns);
  }

  private buildStructuredSummary(turns: ConversationTurn[]): string {
    const userGoals: string[] = [];
    const assistantOutcomes: string[] = [];
    for (const turn of turns) {
      const userMsg = turn.messages.find((msg) => msg.role === "user");
      const assistantMsg = turn.messages.find((msg) => msg.role === "assistant");
      if (userMsg && typeof userMsg.content === "string") {
        userGoals.push(userMsg.content.slice(0, 160));
      }
      if (assistantMsg && typeof assistantMsg.content === "string") {
        assistantOutcomes.push(assistantMsg.content.slice(0, 160));
      }
    }
    const uniqGoals = [...new Set(userGoals)].slice(-8);
    const uniqOutcomes = [...new Set(assistantOutcomes)].slice(-8);
    return [
      "User objective:",
      uniqGoals.length > 0 ? `- ${uniqGoals.join("\n- ")}` : "- (none captured)",
      "Agent outcomes:",
      uniqOutcomes.length > 0 ? `- ${uniqOutcomes.join("\n- ")}` : "- (none captured)",
      "Decisions made:",
      "- Continue with previously selected architecture and tools unless user overrides.",
      "Unresolved tasks:",
      "- Refer to the most recent live turns for next actions.",
    ].join("\n");
  }
}

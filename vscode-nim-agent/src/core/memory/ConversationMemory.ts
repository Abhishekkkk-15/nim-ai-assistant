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

  constructor(private readonly maxTurns: number) {}

  add(turn: ConversationTurn): void {
    this.turns.push(turn);
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
  }

  /**
   * Seeds the memory with a list of messages (useful for loading history).
   * It wraps the messages into a single legacy turn.
   */
  seed(messages: ChatMessage[]): void {
    this.clear();
    if (messages.length > 0) {
      this.add({
        id: "seed",
        agent: "history",
        model: "unknown",
        messages,
        createdAt: Date.now()
      });
    }
  }

  size(): number {
    return this.turns.length;
  }
}

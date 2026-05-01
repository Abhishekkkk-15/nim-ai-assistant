/**
 * A single part of a multimodal user message. Mirrors the OpenAI / NVIDIA NIM
 * vision content schema so the request body can be passed through unchanged.
 */
export type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** Plain string for text-only messages, or an array of parts for multimodal input. */
  content: string | MessageContentPart[];
  name?: string;
  tool_call_id?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface StreamHandlers {
  onToken: (token: string) => void;
  onDone?: (full: string) => void;
  onError?: (err: Error) => void;
}

export interface CompletionResult {
  content: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface ProviderConfig {
  id: string;
  label: string;
  baseUrl: string;
  active?: boolean;
}

export abstract class BaseProvider {
  abstract readonly id: string;
  abstract readonly label: string;

  abstract chatComplete(req: ChatRequest, signal?: AbortSignal): Promise<CompletionResult>;

  abstract chatStream(
    req: ChatRequest,
    handlers: StreamHandlers,
    signal?: AbortSignal
  ): Promise<CompletionResult>;
}

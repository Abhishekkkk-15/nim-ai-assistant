export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
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

import axios, { AxiosError, AxiosInstance } from "axios";
import {
  BaseProvider,
  ChatRequest,
  CompletionResult,
  StreamHandlers,
  ProviderConfig
} from "./BaseProvider";
import type { ApiKeyManager } from "./ApiKeyManager";
import type { Logger } from "../utils/logger";
import type { AnalyticsManager } from "../core/memory/AnalyticsManager";

const MAX_ROTATIONS = 3;

/**
 * Generic OpenAI-compatible client. 
 * Supports Groq, OpenRouter, DeepSeek, Ollama, etc.
 */
export class GenericClient extends BaseProvider {
  readonly id: string;
  readonly label: string;
  private readonly http: AxiosInstance;

  constructor(
    config: ProviderConfig,
    private readonly keys: ApiKeyManager,
    private readonly logger: Logger,
    private readonly analytics?: AnalyticsManager
  ) {
    super();
    this.id = config.id;
    this.label = config.label;
    
    const headers: Record<string, string> = { 
      "Content-Type": "application/json" 
    };

    // Special headers for OpenRouter
    if (this.id === "openrouter") {
      headers["HTTP-Referer"] = "https://github.com/nim-agent/nim-agent-ide";
      headers["X-Title"] = "NIM Agent IDE";
    }

    this.http = axios.create({
      baseURL: config.baseUrl.replace(/\/+$/, ""),
      timeout: 120_000,
      headers
    });
  }

  async chatComplete(req: ChatRequest, signal?: AbortSignal): Promise<CompletionResult> {
    return this.withRotation(async (apiKey) => {
      const res = await this.http.post(
        "/chat/completions",
        this.toRequestBody(req, false),
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: signal as AbortSignal | undefined
        }
      );
      const data = res.data;
      const choice = data?.choices?.[0]?.message?.content ?? "";
      return {
        content: typeof choice === "string" ? choice : JSON.stringify(choice),
        model: data?.model ?? req.model,
        promptTokens: data?.usage?.prompt_tokens,
        completionTokens: data?.usage?.completion_tokens
      };
    }, req);
  }

  async chatStream(
    req: ChatRequest,
    handlers: StreamHandlers,
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    return this.withRotation(async (apiKey) => {
      try {
        const res = await this.http.post(
          "/chat/completions",
          this.toRequestBody(req, true),
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              Accept: "text/event-stream"
            },
            responseType: "stream",
            signal: signal as AbortSignal | undefined
          }
        );

        let buffer = "";
        let full = "";
        let resolvedModel = req.model;

        const stream = res.data as NodeJS.ReadableStream;
        await new Promise<void>((resolve, reject) => {
          stream.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            let idx: number;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, idx).trim();
              buffer = buffer.slice(idx + 2);
              if (!frame) continue;
              for (const line of frame.split("\n")) {
                const dataPrefix = "data:";
                if (!line.startsWith(dataPrefix)) continue;
                const payload = line.slice(dataPrefix.length).trim();
                if (!payload || payload === "[DONE]") continue;
                try {
                  const json = JSON.parse(payload);
                  resolvedModel = json.model ?? resolvedModel;
                  const delta = json?.choices?.[0]?.delta?.content;
                  if (typeof delta === "string" && delta.length > 0) {
                    full += delta;
                    handlers.onToken(delta);
                  }
                } catch (err) {
                  this.logger.debug("Failed to parse SSE frame", err);
                }
              }
            }
          });
          stream.on("end", () => resolve());
          stream.on("error", (err) => reject(err));
        });

        handlers.onDone?.(full);
        return { content: full, model: resolvedModel };
      } catch (err) {
        if (axios.isAxiosError(err) && err.response?.data?.readable) {
          const errorBody = await this.readStream(err.response.data);
          try {
            const json = JSON.parse(errorBody);
            throw new Error(json.error?.message || json.message || errorBody);
          } catch {
            throw new Error(errorBody);
          }
        }
        throw err;
      }
    }, req);
  }

  async embeddings(model: string, input: string[], signal?: AbortSignal): Promise<number[][]> {
    return this.withRotation(async (apiKey) => {
      const res = await this.http.post(
        "/embeddings",
        { model, input, encoding_format: "float" },
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: signal as AbortSignal | undefined
        }
      );
      const data = res.data;
      return data.data.map((item: any) => item.embedding);
    });
  }

  private async readStream(stream: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve) => {
      let data = "";
      stream.on("data", (chunk) => data += chunk);
      stream.on("end", () => resolve(data));
      stream.on("error", () => resolve("Unknown stream error"));
    });
  }

  private toRequestBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    return {
      model: req.model,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {})
      })),
      temperature: req.temperature ?? 0.4,
      max_tokens: req.maxTokens ?? 2048,
      stream
    };
  }

  private async withRotation<T>(op: (apiKey: string) => Promise<T>, req?: ChatRequest): Promise<T> {
    if (!this.keys.hasKeys(this.id)) {
      throw new Error(`No API key configured for provider ${this.label}.`);
    }
    let lastErr: unknown;
    const startTime = Date.now();
    for (let attempt = 0; attempt < Math.min(MAX_ROTATIONS, this.keys.count(this.id)); attempt++) {
      const apiKey = this.keys.next(this.id);
      if (!apiKey) break;
      
      try {
        const result = await op(apiKey);
        this.keys.reportSuccess(this.id, apiKey);
        
        if (this.analytics && result && typeof result === 'object') {
          const res = result as any;
          this.analytics.logEvent({
            model: res.model || req?.model || "unknown",
            agent: "agent",
            tokensIn: res.promptTokens || 0,
            tokensOut: res.completionTokens || 0,
            status: 'success',
            retries: attempt,
            duration: Date.now() - startTime,
            apiKeyName: apiKey.substring(0, 8) + "..."
          });
        }
        
        return result;
      } catch (err) {
        lastErr = err;
        const status = (err as AxiosError)?.response?.status;
        const transient = status === 429 || status === 500 || status === 502 || status === 503;
        if (status) {
          this.keys.reportFailure(this.id, apiKey, status);
        } else {
          this.keys.reportFailure(this.id, apiKey);
        }
        
        if (!transient && status) {
          this.analytics?.logEvent({
            model: req?.model || "unknown",
            agent: "agent",
            tokensIn: 0,
            tokensOut: 0,
            status: 'error',
            errorMessage: String(err),
            retries: attempt,
            duration: Date.now() - startTime,
            apiKeyName: apiKey.substring(0, 8) + "..."
          });
          throw err;
        }
      }
    }
    
    this.analytics?.logEvent({
      model: req?.model || "unknown",
      agent: "agent",
      tokensIn: 0,
      tokensOut: 0,
      status: 'error',
      errorMessage: String(lastErr),
      retries: Math.min(MAX_ROTATIONS, this.keys.count(this.id)) - 1,
      duration: Date.now() - startTime,
      apiKeyName: "all-failed"
    });
    
    throw lastErr;
  }
}

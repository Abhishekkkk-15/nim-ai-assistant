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
 * NVIDIA NIM client. Uses the OpenAI-compatible Chat Completions interface
 * exposed by `https://integrate.api.nvidia.com/v1/chat/completions`.
 */
export class NimClient extends BaseProvider {
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
    this.http = axios.create({
      baseURL: config.baseUrl.replace(/\/+$/, ""),
      timeout: 120_000,
      headers: { "Content-Type": "application/json" }
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
                if (!line.startsWith("data:")) continue;
                const payload = line.slice(5).trim();
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

  /**
   * Run an operation with the next available API key. On 429 / network
   * failure rotate to the next key and retry up to MAX_ROTATIONS times.
   */
  private async withRotation<T>(op: (apiKey: string) => Promise<T>, req?: ChatRequest): Promise<T> {
    if (!this.keys.hasKeys(this.id)) {
      throw new Error(
        `No API key configured for provider ${this.label}. Run "NIM Agent: Add API Key" from the Command Palette.`
      );
    }
    let lastErr: unknown;
    const startTime = Date.now();
    for (let attempt = 0; attempt < Math.min(MAX_ROTATIONS, this.keys.count(this.id)); attempt++) {
      const apiKey = this.keys.next(this.id);
      if (!apiKey) {
        break;
      }
      try {
        const result = await op(apiKey);
        this.keys.reportSuccess(this.id, apiKey);
        
        // Log success
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
          // Log permanent error
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
          throw this.normalizeError(err);
        }
      }
    }
    
    // Log final failure after all retries
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
    
    throw this.normalizeError(lastErr ?? new Error("Unknown NIM client error."));
  }

  private normalizeError(err: unknown): Error {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const body = err.response?.data;
      let detail = "";

      if (typeof body === "string") {
        detail = body;
      } else if (body && typeof body === "object") {
        // If it's a stream (common in chatStream errors), don't stringify it
        if (body.constructor?.name === "IncomingMessage" || body.readable) {
          detail = "Stream error (see logs for details)";
        } else if (body.detail && typeof body.detail === "string" && body.detail.includes("DEGRADED function")) {
          detail = `The selected model is currently unavailable or degraded on NVIDIA NIM: ${body.detail}. Please select a different model.`;
        } else {
          detail = body.error?.message ?? body.message ?? JSON.stringify(body);
        }
      }

      return new Error(`NIM API error (${status ?? "network"}): ${detail || err.message}`);
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}

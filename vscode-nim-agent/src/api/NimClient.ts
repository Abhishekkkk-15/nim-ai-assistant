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
    private readonly logger: Logger
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
    });
  }

  async chatStream(
    req: ChatRequest,
    handlers: StreamHandlers,
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    return this.withRotation(async (apiKey) => {
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
          // SSE frames are separated by blank lines
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 2);
            if (!frame) {
              continue;
            }
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) {
                continue;
              }
              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") {
                continue;
              }
              try {
                const json = JSON.parse(payload);
                resolvedModel = json.model ?? resolvedModel;
                const delta = json?.choices?.[0]?.delta?.content;
                if (typeof delta === "string" && delta.length > 0) {
                  full += delta;
                  handlers.onToken(delta);
                }
              } catch (err) {
                this.logger.debug("Failed to parse SSE frame, skipping.", err);
              }
            }
          }
        });
        stream.on("end", () => resolve());
        stream.on("error", (err) => reject(err));
      });

      handlers.onDone?.(full);
      return { content: full, model: resolvedModel };
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
  private async withRotation<T>(op: (apiKey: string) => Promise<T>): Promise<T> {
    if (!this.keys.hasKeys()) {
      throw new Error(
        "No NVIDIA NIM API key configured. Run \"NIM Agent: Add API Key\" from the Command Palette."
      );
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt < Math.min(MAX_ROTATIONS, this.keys.count()); attempt++) {
      const apiKey = this.keys.next();
      if (!apiKey) {
        break;
      }
      try {
        const result = await op(apiKey);
        this.keys.reportSuccess(apiKey);
        return result;
      } catch (err) {
        lastErr = err;
        const status = (err as AxiosError)?.response?.status;
        const transient = status === 429 || status === 500 || status === 502 || status === 503;
        if (status) {
          this.keys.reportFailure(apiKey, status);
        } else {
          // network error -> still penalize but lighter
          this.keys.reportFailure(apiKey);
        }
        this.logger.warn(
          `NIM request attempt ${attempt + 1} failed (status=${status ?? "n/a"}). ${
            transient ? "Rotating key and retrying." : "Aborting."
          }`
        );
        if (!transient && status) {
          throw this.normalizeError(err);
        }
      }
    }
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
        } else {
          detail = body.error?.message ?? body.message ?? JSON.stringify(body);
        }
      }

      return new Error(`NIM API error (${status ?? "network"}): ${detail || err.message}`);
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}

import type { ProviderRegistry } from "../../api/ProviderRegistry";
import type { ModelManager } from "../../core/models/ModelManager";
import type { Logger } from "../../utils/logger";
import type { ChatMessage } from "../../api/BaseProvider";

export type UiDesignAppType = "web" | "mobile" | "dashboard" | "saas" | "landing";
export type UiDesignStyle =
  | "modern"
  | "minimal"
  | "dark"
  | "playful"
  | "corporate"
  | "brutalist"
  | "glassmorphism";

export interface UiDesignSpec {
  appType: UiDesignAppType;
  style: UiDesignStyle;
  features: string[];
  notes?: string;
  variations?: number;
}

export interface UiDesignSystem {
  colors: { name: string; value: string; usage?: string }[];
  typography: { role: string; family: string; size?: string; weight?: string }[];
  spacing: { token: string; value: string }[];
  radii?: { token: string; value: string }[];
}

export interface UiComponent {
  type: string;
  name?: string;
  props?: Record<string, any>;
  children?: UiComponent[];
}

export interface UiSection {
  name: string;
  description?: string;
  components: UiComponent[];
}

export interface UiScreen {
  name: string;
  description?: string;
  sections: UiSection[];
}

export interface UiDesignDocument {
  meta: {
    name: string;
    appType: UiDesignAppType;
    style: UiDesignStyle;
    summary: string;
  };
  designSystem: UiDesignSystem;
  screens: UiScreen[];
}

export interface UiDesignResult {
  document: UiDesignDocument;
  variations?: UiDesignDocument[];
  modelUsed: string;
  rawJson: string;
}

const VISION_MODEL_HINTS = ["vision", "vlm", "vl-", "image", "multimodal"];

/**
 * UiDesigner — produces a structured UI design document by calling a NIM model
 * directly (one-shot, no agent loop, no tools). Designed to be modular and
 * isolated from the existing agent system.
 */
export class UiDesigner {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly models: ModelManager,
    private readonly logger: Logger,
  ) {}

  /**
   * Pick a sensible model for a one-shot design generation. We bias toward a
   * non-vision text model (cheaper / faster) and fall back to the active model.
   */
  pickDesignModel(): string {
    try {
      const enabled = this.models.enabled().map(m => m.name);
      if (enabled.length > 0) {
        const text = enabled.find(n => !VISION_MODEL_HINTS.some(h => n.toLowerCase().includes(h)));
        if (text) return text;
        return enabled[0];
      }
    } catch {
      // ignore
    }
    return this.models.getActive();
  }

  buildSystemPrompt(): string {
    return [
      "You are a senior product designer working with a developer to specify a complete UI.",
      "You output ONLY a single JSON object — no markdown fences, no commentary, no prose.",
      "The JSON must be a valid `UiDesignDocument` with this exact shape:",
      "{",
      '  "meta": { "name": string, "appType": string, "style": string, "summary": string },',
      '  "designSystem": {',
      '    "colors":     [ { "name": string, "value": "#RRGGBB", "usage": string } ],',
      '    "typography": [ { "role": string, "family": string, "size": string, "weight": string } ],',
      '    "spacing":    [ { "token": string, "value": string } ],',
      '    "radii":      [ { "token": string, "value": string } ]',
      '  },',
      '  "screens": [',
      '    { "name": string, "description": string,',
      '      "sections": [',
      '        { "name": string, "description": string,',
      '          "components": [',
      '            { "type": string, "name": string, "props": object, "children": [ ...recursive ] }',
      '          ]',
      '        }',
      '      ]',
      '    }',
      '  ]',
      "}",
      "",
      "Rules:",
      "- Use semantic component types (Button, Input, Card, Navbar, Sidebar, Hero, Stat, Table, Form, Tabs, Modal, Avatar, Badge, ListItem, Chart, etc.).",
      "- Provide AT LEAST 3 screens for SaaS/dashboard apps, 2 for mobile, 1 for landing.",
      "- Provide 6-10 colors covering: bg, surface, surface-2, text, text-muted, accent, accent-fg, success, warning, danger.",
      "- Provide 4+ typography roles (display, h1, h2, body, mono, small).",
      "- Spacing on a 4px or 8px grid (xs..2xl).",
      "- Components should reflect the requested style and features.",
      "- Output strictly valid JSON. No trailing commas. No comments. No leading text.",
    ].join("\n");
  }

  buildUserPrompt(spec: UiDesignSpec): string {
    const features = (spec.features || []).filter(Boolean);
    return [
      `App type: ${spec.appType}`,
      `Visual style: ${spec.style}`,
      features.length > 0
        ? `Required features:\n- ${features.join("\n- ")}`
        : "Required features: (use sensible defaults for the app type)",
      spec.notes ? `Additional notes: ${spec.notes}` : "",
      "",
      "Generate a complete UI design document for this product. Return JSON only.",
    ].filter(Boolean).join("\n");
  }

  async generate(
    spec: UiDesignSpec,
    onProgress?: (msg: string) => void,
    signal?: AbortSignal,
  ): Promise<UiDesignResult> {
    const provider = this.providers.active();
    const model = this.pickDesignModel();
    onProgress?.(`Designing with ${model}...`);

    const messages: ChatMessage[] = [
      { role: "system", content: this.buildSystemPrompt() },
      { role: "user", content: this.buildUserPrompt(spec) },
    ];

    let raw: string;
    try {
      const r = await provider.chatComplete(
        { model, messages, temperature: 0.7, maxTokens: 6000, stream: false },
        signal,
      );
      raw = r.content;
    } catch (err: any) {
      // Fallback: try the currently active model if the picked one failed.
      const fallback = this.models.getActive();
      if (fallback === model) throw err;
      this.logger.warn?.(`UiDesigner: primary model "${model}" failed (${err?.message}); falling back to "${fallback}".`);
      onProgress?.(`Primary model failed, retrying with ${fallback}...`);
      const r = await provider.chatComplete(
        { model: fallback, messages, temperature: 0.7, maxTokens: 6000, stream: false },
        signal,
      );
      raw = r.content;
    }

    const document = this.parseJsonDocument(raw, spec);

    let variations: UiDesignDocument[] | undefined;
    const wantVariants = Math.max(0, Math.min(2, (spec.variations ?? 0) - 1));
    if (wantVariants > 0) {
      variations = [];
      for (let i = 0; i < wantVariants; i++) {
        if (signal?.aborted) break;
        onProgress?.(`Generating variation ${i + 2} of ${wantVariants + 1}...`);
        try {
          const variantMessages: ChatMessage[] = [
            { role: "system", content: this.buildSystemPrompt() },
            {
              role: "user",
              content:
                this.buildUserPrompt(spec) +
                `\n\nThis is variation #${i + 2}. Produce a meaningfully DIFFERENT layout, color palette, and typography from the previous design while honoring the same brief. Return JSON only.`,
            },
          ];
          const r = await provider.chatComplete(
            { model, messages: variantMessages, temperature: 0.95, maxTokens: 6000, stream: false },
            signal,
          );
          variations.push(this.parseJsonDocument(r.content, spec));
        } catch (err: any) {
          this.logger.warn?.(`UiDesigner: variation ${i + 2} failed: ${err?.message}`);
        }
      }
    }

    return { document, variations, modelUsed: model, rawJson: JSON.stringify(document, null, 2) };
  }

  /** Robustly extract a JSON document from an LLM response. */
  private parseJsonDocument(raw: string, spec: UiDesignSpec): UiDesignDocument {
    const stripped = stripCodeFences(raw).trim();
    const candidate = extractFirstJsonObject(stripped) ?? stripped;
    let obj: any;
    try {
      obj = JSON.parse(candidate);
    } catch (err: any) {
      throw new Error(
        `UiDesigner could not parse model output as JSON: ${err?.message}. ` +
          `First 200 chars: ${stripped.slice(0, 200)}`,
      );
    }
    return normalizeDocument(obj, spec);
  }
}

function stripCodeFences(s: string): string {
  // Remove ```json ... ``` or ``` ... ``` wrappers if present.
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) return fence[1];
  return s;
}

function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function normalizeDocument(obj: any, spec: UiDesignSpec): UiDesignDocument {
  const meta = obj?.meta ?? {};
  const designSystem = obj?.designSystem ?? obj?.design_system ?? {};
  const screens = Array.isArray(obj?.screens) ? obj.screens : [];

  return {
    meta: {
      name: String(meta.name ?? "Untitled Design"),
      appType: (meta.appType ?? meta.app_type ?? spec.appType) as UiDesignAppType,
      style: (meta.style ?? spec.style) as UiDesignStyle,
      summary: String(meta.summary ?? meta.description ?? ""),
    },
    designSystem: {
      colors: ensureArray(designSystem.colors).map((c: any) => ({
        name: String(c?.name ?? c?.token ?? "color"),
        value: String(c?.value ?? c?.hex ?? "#000000"),
        usage: c?.usage ? String(c.usage) : undefined,
      })),
      typography: ensureArray(designSystem.typography).map((t: any) => ({
        role: String(t?.role ?? t?.name ?? "body"),
        family: String(t?.family ?? "system-ui"),
        size: t?.size ? String(t.size) : undefined,
        weight: t?.weight ? String(t.weight) : undefined,
      })),
      spacing: ensureArray(designSystem.spacing).map((s: any) => ({
        token: String(s?.token ?? s?.name ?? "md"),
        value: String(s?.value ?? "8px"),
      })),
      radii: ensureArray(designSystem.radii).map((r: any) => ({
        token: String(r?.token ?? r?.name ?? "md"),
        value: String(r?.value ?? "8px"),
      })),
    },
    screens: screens.map((s: any) => normalizeScreen(s)),
  };
}

function normalizeScreen(s: any): UiScreen {
  return {
    name: String(s?.name ?? "Screen"),
    description: s?.description ? String(s.description) : undefined,
    sections: ensureArray(s?.sections).map((sec: any) => ({
      name: String(sec?.name ?? "Section"),
      description: sec?.description ? String(sec.description) : undefined,
      components: ensureArray(sec?.components).map((c: any) => normalizeComponent(c)),
    })),
  };
}

function normalizeComponent(c: any): UiComponent {
  return {
    type: String(c?.type ?? "Box"),
    name: c?.name ? String(c.name) : undefined,
    props: typeof c?.props === "object" && c.props ? c.props : undefined,
    children: Array.isArray(c?.children) ? c.children.map(normalizeComponent) : undefined,
  };
}

function ensureArray<T = any>(v: any): T[] {
  return Array.isArray(v) ? v : [];
}

import axios from "axios";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export class FetchUrlTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "fetch_url",
      description: "Fetch content from a URL. Automatically strips HTML to return clean, readable text. Use this to read documentation or search results.",
      input: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full URL to fetch (e.g., https://example.com)" }
        },
        required: ["url"]
      },
      requiresPermission: true
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const url = typeof input.url === "string" ? input.url : "";
    if (!url) {
      return { ok: false, output: "Missing or invalid 'url'." };
    }

    try {
      const response = await axios.get(url, {
        headers: { "User-Agent": "NIM-Agent/1.0" },
        timeout: 10000,
        maxRedirects: 5
      });

      let content = "";
      if (typeof response.data === "string") {
        // Very basic HTML to text conversion
        content = response.data
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "") // Remove styles
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "") // Remove scripts
          .replace(/<[^>]+>/g, " ") // Remove tags
          .replace(/&nbsp;/g, " ") // Replace non-breaking spaces
          .replace(/\s+/g, " ") // Collapse whitespace
          .trim();
      } else if (typeof response.data === "object") {
        content = JSON.stringify(response.data, null, 2);
      } else {
        content = String(response.data);
      }

      // Truncate to avoid massive context blows
      if (content.length > 50000) {
        content = content.substring(0, 50000) + "\n...[Content Truncated]";
      }

      return { ok: true, output: content };
    } catch (err) {
      return { ok: false, output: `Failed to fetch URL: ${(err as Error).message}` };
    }
  }
}

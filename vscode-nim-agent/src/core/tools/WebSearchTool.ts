import axios from "axios";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export class WebSearchTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "web_search",
      description: "Search the web for documentation, API references, or solutions to errors. Returns a list of relevant URLs and snippets. You can then use 'fetch_url' to read the full content of a specific result.",
      input: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." }
        },
        required: ["query"]
      },
      requiresPermission: true
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const query = typeof input.query === "string" ? input.query : "";
    if (!query) {
      return { ok: false, output: "Missing or invalid 'query'." };
    }

    try {
      // Using DuckDuckGo Lite for keyless web search
      const response = await axios.post(
        "https://lite.duckduckgo.com/lite/",
        new URLSearchParams({ q: query }),
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Content-Type": "application/x-www-form-urlencoded"
          },
          timeout: 10000
        }
      );

      const html = response.data as string;
      const results = this.parseDuckDuckGoLite(html);

      if (results.length === 0) {
        return { ok: true, output: `No search results found for: ${query}` };
      }

      const output = results.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Snippet: ${r.snippet}`).join("\n\n");
      return { ok: true, output: `Search Results for "${query}":\n\n${output}\n\nUse 'fetch_url' to read the full content of any of these URLs.` };
    } catch (err) {
      return { ok: false, output: `Web search failed: ${(err as Error).message}` };
    }
  }

  private parseDuckDuckGoLite(html: string): Array<{ title: string; url: string; snippet: string }> {
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    
    // Very basic regex parsing for DDG Lite HTML structure
    // Result rows look like:
    // <tr class='result-title'>... <a rel="nofollow" href="URL">TITLE</a> ...</tr>
    // <tr class='result-snippet'>... <td class='result-snippet'>SNIPPET</td> ...</tr>
    
    const titleRegex = /<a[^>]+class=["']?result-url["']?[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
    let titleMatch;
    
    while ((titleMatch = titleRegex.exec(html)) !== null) {
      const url = titleMatch[1];
      const titleRaw = titleMatch[2];
      const title = titleRaw.replace(/<[^>]+>/g, "").trim();
      
      // Attempt to find snippet which usually follows shortly after
      const snippetStart = html.indexOf("result-snippet", titleMatch.index);
      let snippet = "";
      
      if (snippetStart !== -1 && snippetStart - titleMatch.index < 500) {
        const snippetEnd = html.indexOf("</td>", snippetStart);
        if (snippetEnd !== -1) {
          const snippetRaw = html.substring(snippetStart + 15, snippetEnd);
          snippet = snippetRaw.replace(/<[^>]+>/g, "").trim();
        }
      }
      
      // Filter out DDG internal links
      if (url && !url.startsWith("/") && !url.includes("duckduckgo.com")) {
        results.push({ title, url, snippet });
      }
      
      if (results.length >= 8) break; // Limit to top 8 results
    }
    
    return results;
  }
}

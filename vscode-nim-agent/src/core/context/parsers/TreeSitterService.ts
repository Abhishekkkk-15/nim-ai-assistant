import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as Parser from "web-tree-sitter";

export interface CodeBlock {
  type: string;
  name: string;
  content: string;
  startLine: number;
  endLine: number;
}

export class TreeSitterService {
  private parser: Parser.Parser | undefined;
  private languages: Record<string, Parser.Language> = {};
  private wasmDir: string;

  constructor(context: vscode.ExtensionContext) {
    this.wasmDir = path.join(context.extensionPath, "resources", "parsers");
  }

  public async init() {
    if (this.parser) return;
    
    await Parser.Parser.init();
    this.parser = new Parser.Parser();
    
    // Attempt to load common languages if they exist
    await this.loadLanguage("typescript", "tree-sitter-typescript.wasm");
    await this.loadLanguage("javascript", "tree-sitter-javascript.wasm");
    await this.loadLanguage("python", "tree-sitter-python.wasm");
  }

  private async loadLanguage(langId: string, wasmFile: string) {
    const wasmPath = path.join(this.wasmDir, wasmFile);
    if (!fs.existsSync(wasmPath)) return;

    try {
      const lang = await Parser.Language.load(wasmPath);
      this.languages[langId] = lang;
    } catch (err) {
      console.error(`Failed to load tree-sitter language ${langId}:`, err);
    }
  }

  public async getBlocks(text: string, languageId: string): Promise<CodeBlock[]> {
    if (!this.parser) await this.init();
    
    const lang = this.languages[this.normalizeLang(languageId)];
    if (!lang || !this.parser) {
      // Fallback: Return the whole file as one block if no parser available
      return [{
        type: "file",
        name: "full_content",
        content: text,
        startLine: 1,
        endLine: text.split("\n").length
      }];
    }

    this.parser.setLanguage(lang);
    const tree = this.parser.parse(text);
    const blocks: CodeBlock[] = [];

    if (tree) {
      const cursor = tree.walk();
      this.traverse(cursor, text, blocks);
    }
    
    // If no meaningful blocks found, return the whole thing
    if (blocks.length === 0) {
      blocks.push({
        type: "file",
        name: "fallback",
        content: text,
        startLine: 1,
        endLine: text.split("\n").length
      });
    }

    return blocks;
  }

  private traverse(cursor: Parser.TreeCursor, text: string, blocks: CodeBlock[]) {
    const node = cursor.currentNode;
    
    const isMeaningful = 
      node.type === "function_declaration" || 
      node.type === "class_declaration" || 
      node.type === "method_definition" ||
      node.type === "arrow_function" ||
      node.type === "function_definition"; // Python

    if (isMeaningful) {
      const nameNode = node.childForFieldName("name") || node.child(1); // Rough guess for name
      const name = nameNode ? text.substring(nameNode.startIndex, nameNode.endIndex) : "anonymous";
      
      blocks.push({
        type: node.type,
        name: name,
        content: text.substring(node.startIndex, node.endIndex),
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1
      });
      
      // Don't recurse into meaningful blocks to avoid duplicates, 
      // unless it's a class where we want methods too.
      if (node.type !== "class_declaration") return;
    }

    if (cursor.gotoFirstChild()) {
      do {
        this.traverse(cursor, text, blocks);
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  }

  private normalizeLang(lang: string): string {
    lang = lang.toLowerCase();
    if (lang === "ts" || lang === "typescriptreact") return "typescript";
    if (lang === "js" || lang === "javascriptreact") return "javascript";
    if (lang === "py") return "python";
    return lang;
  }
}

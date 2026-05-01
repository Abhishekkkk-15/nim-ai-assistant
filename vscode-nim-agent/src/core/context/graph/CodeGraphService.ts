import * as vscode from "vscode";
import * as path from "path";
import { ExtensionContextStore } from "../../../utils/context";

export interface GraphNode {
  id: string;
  type: "file" | "class" | "function";
  name: string;
  path: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: "calls" | "imports" | "extends";
}

export class CodeGraphService {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: Set<string> = new Set();

  constructor(private readonly store: ExtensionContextStore) {}

  public async buildInitialGraph() {
    this.store.logger.info("Building initial code dependency graph...");
    const files = await vscode.workspace.findFiles("**/*.{ts,js,py}", "**/node_modules/**");
    
    for (const file of files) {
      const relPath = vscode.workspace.asRelativePath(file);
      this.addNode({
        id: relPath,
        type: "file",
        name: path.basename(relPath),
        path: relPath
      });
    }
    
    // In a real implementation, we would parse imports here.
    // For now, we'll provide methods to query the graph dynamically.
  }

  public addNode(node: GraphNode) {
    this.nodes.set(node.id, node);
  }

  public addEdge(from: string, to: string, type: GraphEdge["type"]) {
    this.edges.add(`${from}->${to}:${type}`);
  }

  public getRelatedNodes(nodeId: string): GraphNode[] {
    const relatedIds = new Set<string>();
    for (const edge of this.edges) {
      const [f, t_type] = edge.split("->");
      const [t] = t_type.split(":");
      if (f === nodeId) relatedIds.add(t);
      if (t === nodeId) relatedIds.add(f);
    }
    
    return Array.from(relatedIds)
      .map(id => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /**
   * Find impact of a change by traversing the graph.
   */
  public async findImpact(relPath: string, depth = 2): Promise<string[]> {
    const impacted = new Set<string>();
    const queue: { id: string, d: number }[] = [{ id: relPath, d: 0 }];
    
    while (queue.length > 0) {
      const { id, d } = queue.shift()!;
      if (d >= depth) continue;
      
      const related = this.getRelatedNodes(id);
      for (const r of related) {
        if (!impacted.has(r.id)) {
          impacted.add(r.id);
          queue.push({ id: r.id, d: d + 1 });
        }
      }
    }
    
    return Array.from(impacted);
  }
}

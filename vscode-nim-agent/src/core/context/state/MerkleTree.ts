import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface MerkleNode {
  name: string;
  hash: string;
  children?: Record<string, MerkleNode>;
  isDir: boolean;
}

export class MerkleTree {
  private root: MerkleNode;

  constructor(rootName: string) {
    this.root = {
      name: rootName,
      hash: "",
      isDir: true,
      children: {}
    };
  }

  public getRootHash(): string {
    return this.root.hash;
  }

  public getRoot(): MerkleNode {
    return this.root;
  }

  /**
   * Update the tree with a new or modified file.
   */
  public updateFile(relPath: string, content: string | Buffer): void {
    const parts = relPath.split(/[\\/]/);
    const fileName = parts.pop()!;
    let current = this.root;

    // Traverse to the parent directory
    for (const part of parts) {
      if (!current.children) current.children = {};
      if (!current.children[part]) {
        current.children[part] = { name: part, hash: "", isDir: true, children: {} };
      }
      current = current.children[part];
    }

    // Update file node
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    if (!current.children) current.children = {};
    current.children[fileName] = { name: fileName, hash, isDir: false };

    // Re-calculate hashes up to root
    this.recalculate(this.root);
  }

  /**
   * Remove a file or directory from the tree.
   */
  public remove(relPath: string): void {
    const parts = relPath.split(/[\\/]/);
    const target = parts.pop()!;
    let current = this.root;

    for (const part of parts) {
      if (!current.children || !current.children[part]) return;
      current = current.children[part];
    }

    if (current.children && current.children[target]) {
      delete current.children[target];
      this.recalculate(this.root);
    }
  }

  private recalculate(node: MerkleNode): string {
    if (!node.isDir) return node.hash;

    const children = node.children || {};
    const childNames = Object.keys(children).sort();
    
    const hasher = crypto.createHash("sha256");
    for (const name of childNames) {
      const childHash = this.recalculate(children[name]);
      hasher.update(name + childHash);
    }
    
    node.hash = hasher.digest("hex");
    return node.hash;
  }

  public serialize(): string {
    return JSON.stringify(this.root);
  }

  public static deserialize(rootName: string, json: string): MerkleTree {
    const tree = new MerkleTree(rootName);
    try {
      tree.root = JSON.parse(json);
    } catch (e) {
      // Return empty tree if parsing fails
    }
    return tree;
  }

  /**
   * Compare with another tree and return a list of changed paths.
   */
  public diff(other: MerkleNode): string[] {
    const changes: string[] = [];
    this.diffRecursive(this.root, other, "", changes);
    return changes;
  }

  private diffRecursive(node1: MerkleNode, node2: MerkleNode, currentPath: string, changes: string[]): void {
    if (node1.hash === node2.hash) return;

    if (!node1.isDir || !node2.isDir) {
      changes.push(currentPath);
      return;
    }

    const children1 = node1.children || {};
    const children2 = node2.children || {};
    const allNames = new Set([...Object.keys(children1), ...Object.keys(children2)]);

    for (const name of allNames) {
      const pathWithChild = currentPath ? `${currentPath}/${name}` : name;
      if (!children1[name] || !children2[name]) {
        changes.push(pathWithChild);
      } else {
        this.diffRecursive(children1[name], children2[name], pathWithChild, changes);
      }
    }
  }
}

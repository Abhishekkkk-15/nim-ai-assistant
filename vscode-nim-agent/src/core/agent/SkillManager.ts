import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ExtensionContextStore } from "../../utils/context";

export interface SkillMetadata {
  name: string;
  description: string;
}

export interface Skill {
  metadata: SkillMetadata;
  path: string;
  instructions: string;
  supportingFiles: Map<string, string>;
}

export class SkillManager {
  private skills = new Map<string, Skill>();
  private activeSkillName: string | undefined;

  constructor(private readonly store: ExtensionContextStore) {}

  async initialize(): Promise<void> {
    await this.scanSkills();
  }

  async scanSkills(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return;

    const root = folders[0].uri.fsPath;
    const skillsDir = path.join(root, "skills");

    if (!fs.existsSync(skillsDir)) {
      this.store.logger.info("Skills directory not found. Skipping skill discovery.");
      return;
    }

    this.skills.clear();
    await this.scanDirectory(skillsDir);
    this.store.logger.info(`Discovered ${this.skills.size} skills.`);
  }

  private async scanDirectory(dir: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.scanDirectory(fullPath);
      } else if (entry.name === "SKILL.md") {
        await this.loadSkill(fullPath);
      }
    }
  }

  private async loadSkill(skillFile: string): Promise<void> {
    try {
      const content = await fs.promises.readFile(skillFile, "utf8");
      const { metadata, instructions } = this.parseSkillContent(content);
      
      const skillDir = path.dirname(skillFile);
      const supportingFiles = new Map<string, string>();
      
      // Load supporting files like REFERENCE.md if they exist
      const files = await fs.promises.readdir(skillDir);
      for (const file of files) {
        if (file !== "SKILL.md" && (file.endsWith(".md") || file.endsWith(".json"))) {
          const fileContent = await fs.promises.readFile(path.join(skillDir, file), "utf8");
          supportingFiles.set(file, fileContent);
        }
      }

      this.skills.set(metadata.name, {
        metadata,
        path: skillFile,
        instructions,
        supportingFiles
      });
    } catch (err) {
      this.store.logger.error(`Failed to load skill at ${skillFile}`, err);
    }
  }

  private parseSkillContent(content: string): { metadata: SkillMetadata; instructions: string } {
    const yamlMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    let metadata: SkillMetadata = { name: "unknown", description: "" };
    let instructions = content;

    if (yamlMatch) {
      const yaml = yamlMatch[1];
      const lines = yaml.split(/\r?\n/);
      for (const line of lines) {
        const [key, ...valueParts] = line.split(":");
        const value = valueParts.join(":").trim();
        if (key.trim() === "name") metadata.name = value;
        if (key.trim() === "description") metadata.description = value;
      }
      instructions = content.slice(yamlMatch[0].length).trim();
    }

    return { metadata, instructions };
  }

  listSkills(): SkillMetadata[] {
    return Array.from(this.skills.values()).map(s => s.metadata);
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  setActiveSkill(name: string | undefined): void {
    if (name && !this.skills.has(name)) {
      throw new Error(`Skill not found: ${name}`);
    }
    this.activeSkillName = name;
  }

  getActiveSkill(): Skill | undefined {
    return this.activeSkillName ? this.skills.get(this.activeSkillName) : undefined;
  }

  getSkillInjectionPrompt(): string {
    const active = this.getActiveSkill();
    if (!active) return "";

    let prompt = `\n\n<active_skill name="${active.metadata.name}">\n`;
    prompt += `IMPORTANT: You are currently operating under the "${active.metadata.name}" skill.\n`;
    prompt += `Follow these instructions EXACTLY:\n\n${active.instructions}\n`;
    
    if (active.supportingFiles.size > 0) {
      prompt += `\nSupporting Context:\n`;
      for (const [name, content] of active.supportingFiles) {
        prompt += `--- ${name} ---\n${content}\n`;
      }
    }
    
    prompt += `\n</active_skill>\n`;
    return prompt;
  }

  async saveConfig(config: Record<string, any>): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return;

    const root = folders[0].uri.fsPath;
    const configDir = path.join(root, ".agent");
    if (!fs.existsSync(configDir)) {
      await fs.promises.mkdir(configDir, { recursive: true });
    }

    const configFile = path.join(configDir, "skills-config.json");
    await fs.promises.writeFile(configFile, JSON.stringify(config, null, 2));
  }

  async loadConfig(): Promise<Record<string, any>> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return {};

    const root = folders[0].uri.fsPath;
    const configFile = path.join(root, ".agent", "skills-config.json");
    if (fs.existsSync(configFile)) {
      const content = await fs.promises.readFile(configFile, "utf8");
      return JSON.parse(content);
    }
    return {};
  }
}

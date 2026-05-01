import * as vscode from 'vscode';

export interface PinnedItem {
    path: string;
    content: string;
    type: 'file' | 'rule';
}

export class ContextManager {
    private pinned: Map<string, PinnedItem> = new Map();

    constructor(private context: vscode.ExtensionContext) {
        this.load();
    }

    private async load() {
        const saved = this.context.globalState.get<PinnedItem[]>('nim-agent-pinned', []);
        saved.forEach(item => this.pinned.set(item.path, item));
    }

    private async save() {
        await this.context.globalState.update('nim-agent-pinned', Array.from(this.pinned.values()));
    }

    public async pinFile(path: string) {
        try {
            const uri = vscode.Uri.file(path);
            const data = await vscode.workspace.fs.readFile(uri);
            const content = Buffer.from(data).toString('utf8');
            this.pinned.set(path, { path, content, type: 'file' });
            await this.save();
        } catch (err) {
            console.error('Failed to pin file:', err);
        }
    }

    public async unpin(path: string) {
        this.pinned.delete(path);
        await this.save();
    }

    public getAll(): PinnedItem[] {
        return Array.from(this.pinned.values());
    }

    public formatForPrompt(): string {
        const items = this.getAll();
        if (items.length === 0) return "";
        
        let prompt = "\n--- CONTEXT BANK (Pinned Files/Rules) ---\n";
        items.forEach(item => {
            const truncated = item.content.length > 10000 
                ? item.content.slice(0, 10000) + "\n[... (Content truncated to first 10k chars to fit context) ...]"
                : item.content;
            prompt += `File: ${item.path}\nContent:\n${truncated}\n---\n`;
        });
        return prompt;
    }
}

import * as vscode from 'vscode';
import { ChatMessage } from '../../api/BaseProvider';

export interface ChatSession {
    id: string;
    title: string;
    messages: ChatMessage[];
    createdAt: number;
    updatedAt: number;
}

export class HistoryManager {
    private sessions: ChatSession[] = [];
    private currentSessionId?: string;

    constructor(private context: vscode.ExtensionContext) {
        this.load();
    }

    private load() {
        this.sessions = this.context.workspaceState.get<ChatSession[]>('nim-agent-sessions', []);
    }

    private async save() {
        await this.context.workspaceState.update('nim-agent-sessions', this.sessions);
    }

    public async createSession(title: string = 'New Chat'): Promise<ChatSession> {
        const session: ChatSession = {
            id: Date.now().toString(),
            title,
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        this.sessions.unshift(session);
        this.currentSessionId = session.id;
        await this.save();
        return session;
    }

    public async appendMessage(message: ChatMessage) {
        if (!this.currentSessionId) {
            await this.createSession();
        }
        const session = this.sessions.find(s => s.id === this.currentSessionId);
        if (session) {
            session.messages.push(message);
            session.updatedAt = Date.now();
            // Simple title generation if it's the first user message
            if (session.title === 'New Chat' && message.role === 'user') {
                session.title = message.content.substring(0, 30) + (message.content.length > 30 ? '...' : '');
            }
            await this.save();
        }
    }

    public getSessions(): ChatSession[] {
        return this.sessions;
    }

    public getCurrentSessionId(): string | undefined {
        return this.currentSessionId;
    }

    public async loadSession(id: string): Promise<ChatSession | undefined> {
        const session = this.sessions.find(s => s.id === id);
        if (session) {
            this.currentSessionId = id;
            return session;
        }
        return undefined;
    }

    public async clearAll() {
        this.sessions = [];
        this.currentSessionId = undefined;
        await this.save();
    }
}

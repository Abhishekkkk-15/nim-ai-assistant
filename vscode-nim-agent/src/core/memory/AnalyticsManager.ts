import * as vscode from 'vscode';

export interface AnalyticsEvent {
    id: string;
    timestamp: number;
    model: string;
    agent: string;
    tokensIn: number;
    tokensOut: number;
    status: 'success' | 'error';
    errorMessage?: string;
    retries: number;
    duration: number;
    apiKeyName: string;
}

export class AnalyticsManager {
    private events: AnalyticsEvent[] = [];
    private readonly MAX_EVENTS = 1000;

    constructor(private context: vscode.ExtensionContext) {
        this.load();
    }

    private load() {
        this.events = this.context.globalState.get<AnalyticsEvent[]>('nim-agent-analytics', []);
    }

    private async save() {
        // Keep only last MAX_EVENTS
        if (this.events.length > this.MAX_EVENTS) {
            this.events = this.events.slice(-this.MAX_EVENTS);
        }
        await this.context.globalState.update('nim-agent-analytics', this.events);
    }

    public async logEvent(event: Omit<AnalyticsEvent, 'id' | 'timestamp'>) {
        const fullEvent: AnalyticsEvent = {
            ...event,
            id: Math.random().toString(36).substring(7),
            timestamp: Date.now()
        };
        this.events.unshift(fullEvent);
        await this.save();
    }

    public getEvents(): AnalyticsEvent[] {
        return this.events;
    }

    public getSummary() {
        const totalTokensIn = this.events.reduce((sum, e) => sum + e.tokensIn, 0);
        const totalTokensOut = this.events.reduce((sum, e) => sum + e.tokensOut, 0);
        const successCount = this.events.filter(e => e.status === 'success').length;
        const totalCount = this.events.length;
        const totalRetries = this.events.reduce((sum, e) => sum + e.retries, 0);
        
        // Group by model
        const modelUsage: Record<string, number> = {};
        this.events.forEach(e => {
            modelUsage[e.model] = (modelUsage[e.model] || 0) + (e.tokensIn + e.tokensOut);
        });

        // Group by API key
        const keyHealth: Record<string, { success: number, total: number }> = {};
        this.events.forEach(e => {
            if (!keyHealth[e.apiKeyName]) keyHealth[e.apiKeyName] = { success: 0, total: 0 };
            keyHealth[e.apiKeyName].total++;
            if (e.status === 'success') keyHealth[e.apiKeyName].success++;
        });

        return {
            totalTokensIn,
            totalTokensOut,
            totalTokens: totalTokensIn + totalTokensOut,
            successRate: totalCount > 0 ? (successCount / totalCount) * 100 : 0,
            totalRetries,
            modelUsage,
            keyHealth
        };
    }

    public async clear() {
        this.events = [];
        await this.save();
    }
}

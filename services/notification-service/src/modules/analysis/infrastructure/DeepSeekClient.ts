import type { Logger } from '@trader/core';

// DeepSeek serves an OpenAI-compatible /chat/completions endpoint. `deepseek-chat` (V3)
// is the general-purpose model — fast and cheap enough for per-cycle enrichment. The
// reasoning variant `deepseek-reasoner` (R1-style) is overkill for prose generation and
// 5-10x slower; only worth it if we ever want LLM-driven trade decisions, not for
// describing companies + summarising signals.
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL     = 'deepseek-chat';

export interface DeepSeekClientOptions {
    apiKey:  string;
    logger:  Logger;
    model?:  string;
    timeoutMs?: number;
}

export interface ChatMessage {
    role:    'system' | 'user' | 'assistant';
    content: string;
}

export interface ChatCompletionOptions {
    messages:    ChatMessage[];
    // When set, asks the model to respond with valid JSON only. Cleaner for the
    // company-profile path which parses the response into a typed object.
    jsonMode?:   boolean;
    maxTokens?:  number;
    temperature?: number;
}

export class DeepSeekClient {
    private readonly model:     string;
    private readonly timeoutMs: number;

    constructor(private readonly opts: DeepSeekClientOptions) {
        this.model     = opts.model     ?? DEFAULT_MODEL;
        this.timeoutMs = opts.timeoutMs ?? 60_000;
    }

    async chat(req: ChatCompletionOptions): Promise<string> {
        const body: Record<string, unknown> = {
            model:       this.model,
            messages:    req.messages,
            max_tokens:  req.maxTokens   ?? 1500,
            temperature: req.temperature ?? 0.4,
        };
        if (req.jsonMode) body.response_format = { type: 'json_object' };

        const ctl = new AbortController();
        const t   = setTimeout(() => ctl.abort(), this.timeoutMs);
        const t0  = Date.now();
        try {
            const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.opts.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body:   JSON.stringify(body),
                signal: ctl.signal,
            });
            if (!res.ok) {
                const txt = await res.text();
                throw new Error(`deepseek ${res.status}: ${txt.slice(0, 400)}`);
            }
            const data = await res.json() as {
                choices?: Array<{ message?: { content?: string } }>;
                usage?:   { prompt_tokens?: number; completion_tokens?: number };
            };
            const content = data.choices?.[0]?.message?.content ?? '';
            this.opts.logger.info({
                model:       this.model,
                durationMs:  Date.now() - t0,
                inputTokens: data.usage?.prompt_tokens,
                outputTokens: data.usage?.completion_tokens,
                jsonMode:    !!req.jsonMode,
            }, 'deepseek chat ok');
            return content;
        } finally {
            clearTimeout(t);
        }
    }
}

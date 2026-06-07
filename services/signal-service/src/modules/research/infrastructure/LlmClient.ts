import type { Logger } from '@trader/core';

// Local mirror of notification-service's DeepSeekClient — the same OpenAI-compatible DeepSeek
// /chat/completions surface, the same `DEEPSEEK_API_KEY` secret. The market narrative only needs
// the narrow "give me one chat completion" capability, so this is a thin client rather than a shared
// package (DeepSeekClient is notification-service-local; duplicating the ~40 lines keeps the two
// services decoupled — neither imports the other's infrastructure). `deepseek-chat` (V3) is the
// general-purpose model; the reasoning variant is overkill for constrained prose.
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL     = 'deepseek-chat';

export interface ChatMessage {
    role:    'system' | 'user' | 'assistant';
    content: string;
}

export interface ChatCompletionOptions {
    messages:     ChatMessage[];
    maxTokens?:   number;
    temperature?: number;
}

// Narrow LLM surface — anything with `.chat(req)` plugs in. Lets the narrative builder + tests pass a
// stub instead of a real client + API key (mirrors notification-service's NarrativeLLM).
export interface NarrativeLLM {
    chat(req: ChatCompletionOptions): Promise<string>;
}

export interface LlmClientOptions {
    apiKey:     string;
    logger:     Logger;
    model?:     string;
    timeoutMs?: number;
}

export class DeepSeekClient implements NarrativeLLM {
    private readonly model:     string;
    private readonly timeoutMs: number;

    constructor(private readonly opts: LlmClientOptions) {
        this.model     = opts.model     ?? DEFAULT_MODEL;
        this.timeoutMs = opts.timeoutMs ?? 30_000;
    }

    async chat(req: ChatCompletionOptions): Promise<string> {
        const body: Record<string, unknown> = {
            model:       this.model,
            messages:    req.messages,
            max_tokens:  req.maxTokens   ?? 700,
            temperature: req.temperature ?? 0.3,
        };

        const ctl = new AbortController();
        const t   = setTimeout(() => ctl.abort(), this.timeoutMs);
        const t0  = Date.now();
        try {
            const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
                method:  'POST',
                headers: {
                    Authorization:  `Bearer ${this.opts.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body:   JSON.stringify(body),
                signal: ctl.signal,
            });
            if (!res.ok) {
                const txt = await res.text();
                throw new Error(`deepseek ${res.status}: ${txt.slice(0, 400)}`);
            }
            const data = (await res.json()) as {
                choices?: Array<{ message?: { content?: string } }>;
                usage?:   { prompt_tokens?: number; completion_tokens?: number };
            };
            const content = data.choices?.[0]?.message?.content ?? '';
            this.opts.logger.info(
                {
                    model:        this.model,
                    durationMs:   Date.now() - t0,
                    inputTokens:  data.usage?.prompt_tokens,
                    outputTokens: data.usage?.completion_tokens,
                },
                'narrative llm chat ok',
            );
            return content;
        } finally {
            clearTimeout(t);
        }
    }
}

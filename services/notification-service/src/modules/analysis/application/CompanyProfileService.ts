import type { Db } from 'mongodb';
import type { Logger } from '@trader/core';
import { COLLECTIONS } from '@trader/shared-mongo';
import type { DeepSeekClient } from '../infrastructure/DeepSeekClient.ts';

const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;   // 90 days — company facts change slowly

// Stable, slow-changing facts about a company. Three short blocks render cleanly inside
// the per-cycle analysis email's per-ticker section without overwhelming the eye.
// `differentiator` is the one the user explicitly asked for — "what does it do that is
// different" — kept separate so the email template can highlight it.
export interface CompanyProfile {
    ticker:           string;          // T212 ticker (e.g. 'AAPL_US_EQ')
    name:             string;          // human-readable ("Apple Inc.")
    history:          string;          // 2-3 sentence founding + trajectory
    market_position:  string;          // 2-3 sentence current market role
    differentiator:   string;          // 2-3 sentence what sets it apart from sector rivals
    fetchedAt:        Date;
    model:            string;          // record which model generated this — useful when refreshing
}

const PROFILE_PROMPT = (ticker: string, hint: string) => `You are a financial analyst. Generate a JSON object describing the public company behind the T212 ticker "${ticker}"${hint}. Keep each field to 2-3 sentences, factual and current to early 2026. Return ONLY a JSON object with this exact shape:
{
  "name": "Full company name",
  "history": "Founding, key milestones, recent trajectory",
  "market_position": "Current market share, segment leadership, scale",
  "differentiator": "What makes it different from sector rivals — technology, moat, business model"
}`;

export class CompanyProfileService {
    constructor(
        private readonly db:     Db,
        private readonly client: DeepSeekClient | null,
        private readonly logger: Logger,
        private readonly now:    () => number = () => Date.now(),
    ) {}

    /**
     * Fetch a profile, regenerating if older than 90d. Returns null when no DeepSeek client
     * is wired (so the analysis path skips gracefully on a missing key without crashing).
     * Sector is passed only to bias the LLM's market-position framing; ranking math stays
     * in AnalysisEmailSender so this layer is purely "tell me about the company".
     */
    async get(ticker: string, sectorHint?: string): Promise<CompanyProfile | null> {
        if (!this.client) return null;

        const col = this.db.collection<CompanyProfile>(COLLECTIONS.COMPANY_PROFILES);
        const existing = await col.findOne({ ticker });
        if (existing && this.now() - existing.fetchedAt.getTime() < CACHE_TTL_MS) {
            return existing;
        }

        const hint = sectorHint ? ` (sector: ${sectorHint})` : '';
        let raw: string;
        try {
            raw = await this.client.chat({
                messages:    [{ role: 'user', content: PROFILE_PROMPT(ticker, hint) }],
                jsonMode:    true,
                maxTokens:   600,
                temperature: 0.3,
            });
        } catch (err) {
            this.logger.warn({ err, ticker }, 'company-profile: DeepSeek failed; serving stale if any');
            return existing ?? null;
        }

        let parsed: { name?: string; history?: string; market_position?: string; differentiator?: string };
        try { parsed = JSON.parse(raw); }
        catch (err) {
            this.logger.warn({ err, ticker, raw: raw.slice(0, 200) }, 'company-profile: JSON parse failed');
            return existing ?? null;
        }
        if (!parsed.name || !parsed.history || !parsed.market_position || !parsed.differentiator) {
            this.logger.warn({ ticker, parsed }, 'company-profile: missing fields in response');
            return existing ?? null;
        }

        const profile: CompanyProfile = {
            ticker,
            name:            parsed.name,
            history:         parsed.history,
            market_position: parsed.market_position,
            differentiator:  parsed.differentiator,
            fetchedAt:       new Date(this.now()),
            model:           'deepseek-chat',
        };
        await col.updateOne({ ticker }, { $set: profile }, { upsert: true });
        this.logger.info({ ticker, name: profile.name }, 'company-profile: cached');
        return profile;
    }
}

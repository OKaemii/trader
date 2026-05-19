import type { Logger } from "@trader/core";
import { getRedisClient } from "@trader/shared-redis";
import { getMongoDb } from "@trader/shared-mongo";
import type { NotificationEnv } from "./env.ts";
import { EmailSender } from "./modules/notifications/infrastructure/email.ts";
import { PushSender } from "./modules/notifications/infrastructure/push.ts";
import { DeepSeekClient } from "./modules/analysis/infrastructure/DeepSeekClient.ts";
import { CompanyProfileService } from "./modules/analysis/application/CompanyProfileService.ts";
import { AnalysisEmailSender } from "./modules/analysis/infrastructure/AnalysisEmailSender.ts";
import { CycleAnalysisBatcher, nyseCalendar, lseCalendar } from "./modules/analysis/application/CycleAnalysisBatcher.ts";
import {
    HolidayCache, NyseIcalProvider, UkGovBankHolidayProvider, STATIC_FALLBACK,
} from "@trader/shared-calendar";

export interface NotificationDeps {
    readonly logger: Logger;
    readonly env: NotificationEnv;
    readonly redis: Awaited<ReturnType<typeof getRedisClient>>;
    readonly email: EmailSender | null;
    readonly push: PushSender;
    // Per-cycle analysis path. Both fields are nullable so the service still boots when
    // DEEPSEEK_API_KEY (or RESEND/EMAIL_TO) is missing — quick emails alone keep working.
    readonly analysisEmail: AnalysisEmailSender | null;
    readonly analysisBatcher: CycleAnalysisBatcher | null;
}

export async function wireDependencies(env: NotificationEnv, logger: Logger): Promise<NotificationDeps> {
    const redis = await getRedisClient();
    // Email is optional — operator may run notification-service without a Resend key
    // (push-only). Constructing Resend without an API key fails at the first send call,
    // so we guard at wiring time and degrade gracefully.
    const email = env.RESEND_API_KEY && env.EMAIL_TO
        ? new EmailSender({ apiKey: env.RESEND_API_KEY, toEmail: env.EMAIL_TO })
        : null;
    if (!email) logger.warn("RESEND_API_KEY or EMAIL_TO not set — email notifications disabled");

    const push = new PushSender(redis as never);

    // Per-cycle analysis path: needs DeepSeek (for company profiles + cycle narrative)
    // AND Resend (the email transport). If either is missing, we degrade to per-signal
    // emails only. Mongo is needed for the company-profile cache.
    let analysisEmail:   AnalysisEmailSender   | null = null;
    let analysisBatcher: CycleAnalysisBatcher | null = null;
    if (env.DEEPSEEK_API_KEY && env.RESEND_API_KEY && env.EMAIL_TO) {
        const db        = await getMongoDb();
        const deepseek  = new DeepSeekClient({ apiKey: env.DEEPSEEK_API_KEY, logger });
        const profiles  = new CompanyProfileService(db, deepseek, logger);
        analysisEmail   = new AnalysisEmailSender(
            { apiKey: env.RESEND_API_KEY, toEmail: env.EMAIL_TO },
            profiles, deepseek, logger,
        );
        // Exchange calendars for the EOD cadence. Shared HolidayCache reads the same
        // gov.uk + NYSE iCal sources as market-data-service. STATIC_FALLBACK is the
        // baked-in closure table the cache reaches for when both Mongo and the live
        // provider are unavailable (currently the source of truth for US, since the
        // NYSE iCal URL is a 404 — see CLAUDE.md).
        const holidayCache = new HolidayCache(
            db,
            { US: new NyseIcalProvider(), LSE: new UkGovBankHolidayProvider() },
            STATIC_FALLBACK,
        );
        const calendars = {
            US:  nyseCalendar(holidayCache),
            LSE: lseCalendar(holidayCache),
        };

        analysisBatcher = new CycleAnalysisBatcher({
            logger,
            calendars,
            intradayOverride: env.REPORT_INTRADAY_CADENCE,
            onFlush: async (batch) => {
                if (!analysisEmail) return;
                try { await analysisEmail.send(batch); }
                catch (err) { logger.warn({ err, cycleKey: batch.cycleKey }, "analysis email send failed"); }
            },
        });
        logger.info("analysis email path enabled (DeepSeek + Resend)");
    } else {
        logger.warn({
            haveDeepseek: !!env.DEEPSEEK_API_KEY,
            haveResend:   !!env.RESEND_API_KEY,
            haveEmailTo:  !!env.EMAIL_TO,
        }, "analysis email path disabled — missing one of DEEPSEEK_API_KEY/RESEND_API_KEY/EMAIL_TO");
    }

    return { logger, env, redis, email, push, analysisEmail, analysisBatcher };
}

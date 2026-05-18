import type { Logger } from "@trader/core";
import { getRedisClient } from "@trader/shared-redis";
import type { NotificationEnv } from "./env.ts";
import { EmailSender } from "./email.ts";
import { PushSender } from "./push.ts";

export interface NotificationDeps {
    readonly logger: Logger;
    readonly env: NotificationEnv;
    readonly redis: Awaited<ReturnType<typeof getRedisClient>>;
    readonly email: EmailSender | null;
    readonly push: PushSender;
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
    return { logger, env, redis, email, push };
}

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { MongoUserRepository } from './infrastructure/repositories/MongoUserRepository.ts';
import { RedisRefreshTokenStore } from './infrastructure/repositories/RedisRefreshTokenStore.ts';
import { LoginUseCase } from './application/use-cases/LoginUseCase.ts';
import { RegisterUseCase } from './application/use-cases/RegisterUseCase.ts';
import { SeedAdminUseCase } from './application/use-cases/SeedAdminUseCase.ts';
import { createPublicRouter, createInternalRouter } from './infrastructure/http/router.ts';

// Composition root — wire dependencies
const users       = new MongoUserRepository();
const tokenStore  = new RedisRefreshTokenStore();
const loginUseCase    = new LoginUseCase(users, tokenStore);
const registerUseCase = new RegisterUseCase(users);

// Seed admin from env vars if provided. Idempotent: skips if the user already exists.
const seedEmail    = process.env.SEED_ADMIN_EMAIL;
const seedPassword = process.env.SEED_ADMIN_PASSWORD;
if (seedEmail && seedPassword) {
  new SeedAdminUseCase(users).execute(seedEmail, seedPassword)
    .then((r) => console.log(r.created ? `[seed] admin created: ${seedEmail}` : `[seed] admin already exists: ${seedEmail}`))
    .catch((e) => console.error('[seed] failed:', e));
}

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));
app.route('/', createPublicRouter(loginUseCase, registerUseCase, users));
app.route('/', createInternalRouter());

const port = Number(process.env.PORT ?? 3001);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[auth-service] listening on :${info.port}`);
});

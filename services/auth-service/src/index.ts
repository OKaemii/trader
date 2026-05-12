import { Hono } from 'hono';
import { MongoUserRepository } from './infrastructure/repositories/MongoUserRepository.ts';
import { RedisRefreshTokenStore } from './infrastructure/repositories/RedisRefreshTokenStore.ts';
import { LoginUseCase } from './application/use-cases/LoginUseCase.ts';
import { RegisterUseCase } from './application/use-cases/RegisterUseCase.ts';
import { createPublicRouter, createInternalRouter } from './infrastructure/http/router.ts';

// Composition root — wire dependencies
const users       = new MongoUserRepository();
const tokenStore  = new RedisRefreshTokenStore();
const loginUseCase    = new LoginUseCase(users, tokenStore);
const registerUseCase = new RegisterUseCase(users);

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));
app.route('/', createPublicRouter(loginUseCase, registerUseCase, users));
app.route('/', createInternalRouter());

export default { port: 3001, fetch: app.fetch };

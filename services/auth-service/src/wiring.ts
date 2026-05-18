import type { Logger } from "@trader/core";
import { MongoUserRepository } from "./modules/auth/infrastructure/MongoUserRepository.ts";
import { RedisRefreshTokenStore } from "./modules/auth/infrastructure/RedisRefreshTokenStore.ts";
import { LoginUseCase } from "./modules/auth/application/LoginUseCase.ts";
import { RegisterUseCase } from "./modules/auth/application/RegisterUseCase.ts";
import { SeedAdminUseCase } from "./modules/auth/application/SeedAdminUseCase.ts";
import type { AuthEnv } from "./env.ts";

export interface AuthDeps {
    readonly logger: Logger;
    readonly env: AuthEnv;
    readonly users: MongoUserRepository;
    readonly login: LoginUseCase;
    readonly register: RegisterUseCase;
    readonly seedAdmin: SeedAdminUseCase;
}

export function wireDependencies(env: AuthEnv, logger: Logger): AuthDeps {
    const users      = new MongoUserRepository();
    const tokenStore = new RedisRefreshTokenStore();
    const login      = new LoginUseCase(users, tokenStore);
    const register   = new RegisterUseCase(users);
    const seedAdmin  = new SeedAdminUseCase(users);
    return { logger, env, users, login, register, seedAdmin };
}

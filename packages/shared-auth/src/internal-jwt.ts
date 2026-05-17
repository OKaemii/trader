import { SignJWT } from "jose";
import type { Audience } from "./audiences.ts";

const secret = (): Uint8Array =>
    new TextEncoder().encode(process.env.JWT_SECRET ?? "dev-secret-change-me");

const INTERNAL_TTL_SEC = 300; // 5 min — caps blast radius if a token leaks.

/**
 * Mint a short-lived JWT for service-to-service calls. The `sub` claim names the caller,
 * `aud` is fixed to "internal". Downstream callees verify both via `requireInternal`
 * (audience-check) and optionally enforce per-peer access via `req.user.sub`.
 */
export async function mintInternalJwt(callerService: string, ttlSec = INTERNAL_TTL_SEC): Promise<string> {
    const aud: Audience = "internal";
    return await new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(callerService)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(`${ttlSec}s`)
        .sign(secret());
}

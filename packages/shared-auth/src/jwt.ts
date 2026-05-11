import { SignJWT, jwtVerify, type JWTPayload as JosePayload } from 'jose';

export type UserRole = 'admin' | 'user';

export interface AppJWTPayload extends JosePayload {
  sub: string;
  role: UserRole;
}

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-secret-change-me');
const ACCESS_TTL  = '15m';
const REFRESH_TTL = '7d';

export async function signAccessToken(payload: Omit<AppJWTPayload, 'iat' | 'exp'>): Promise<string> {
  return new SignJWT(payload as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL)
    .sign(secret());
}

export async function signRefreshToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, type: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(REFRESH_TTL)
    .sign(secret());
}

export async function verifyAccessToken(token: string): Promise<AppJWTPayload> {
  const { payload } = await jwtVerify(token, secret());
  return payload as AppJWTPayload;
}

export async function verifyRefreshToken(token: string): Promise<{ sub: string }> {
  const { payload } = await jwtVerify(token, secret());
  if ((payload as Record<string, unknown>).type !== 'refresh') throw new Error('Not a refresh token');
  return { sub: payload.sub as string };
}

export const Audiences = ["user", "admin", "internal", "login", "refresh"] as const;
export type Audience = (typeof Audiences)[number];

export const isAudience = (v: unknown): v is Audience =>
    typeof v === "string" && (Audiences as readonly string[]).includes(v);

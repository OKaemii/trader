import type { z, ZodTypeAny } from "zod";

export interface LoadEnvOptions {
    source?: NodeJS.ProcessEnv;
    onFatal?: (issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>) => never;
}

const defaultFatal = (issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>): never => {
    // Logger doesn't exist yet at boot. Print to stderr in a Pino-shaped one-liner per issue.
    process.stderr.write(`{"level":50,"msg":"[env] invalid configuration"}\n`);
    for (const issue of issues) {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        process.stderr.write(`{"level":50,"msg":"  ${path}: ${issue.message}"}\n`);
    }
    process.exit(1);
};

export function loadEnv<S extends ZodTypeAny>(schema: S, opts: LoadEnvOptions = {}): z.infer<S> {
    const source = opts.source ?? process.env;
    const result = schema.safeParse(source);
    if (!result.success) {
        const fatal = opts.onFatal ?? defaultFatal;
        return fatal(result.error.issues) as never;
    }
    return result.data;
}

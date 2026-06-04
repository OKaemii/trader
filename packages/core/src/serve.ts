import { serve as honoServe, type ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import type { Logger } from "./logger.ts";
import { mountMetrics } from "./metrics.ts";

export interface ListenConfig {
    app: Hono;
    port: number;
    logger: Logger;
}

export interface ServerHandle {
    close(): Promise<void>;
    server: ServerType;
}

export function listen(cfg: ListenConfig): ServerHandle {
    mountMetrics(cfg.app);   // GET /metrics on every service that uses the shared server entry
    const server = honoServe({ fetch: cfg.app.fetch, port: cfg.port }, (info) => {
        cfg.logger.info({ port: info.port }, "listening");
    });
    return {
        server,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            }),
    };
}

import { Hono } from "hono";
import { requireAuth } from "@trader/shared-auth";
import type { PortfolioDeps } from "../wiring.ts";

export function createPublicRouter(deps: PortfolioDeps): Hono {
    const router = new Hono();
    router.use("/api/portfolio/*", requireAuth);
    router.use("/api/portfolio",   requireAuth);

    router.get("/api/portfolio", async (c) => {
        const positions = await deps.readService.listPositions();
        return c.json({ positions });
    });

    router.get("/api/portfolio/pnl", async (c) => {
        const pnl = await deps.readService.pnl();
        if (!pnl) return c.json({ error: "fx unavailable for P&L computation" }, 502);
        return c.json(pnl);
    });

    return router;
}

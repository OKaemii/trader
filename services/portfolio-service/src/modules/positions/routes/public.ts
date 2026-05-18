import { Hono } from "hono";
import { parseUserHeaders } from "@trader/shared-auth/middleware";
import type { PortfolioDeps } from "../../../wiring.ts";

export function createPublicRouter(deps: PortfolioDeps): Hono {
    const router = new Hono();
    // /api/portfolio/* — user-scope reads. Each service is its own auth perimeter.
    router.use("/api/portfolio/*", parseUserHeaders);

    router.get("/api/portfolio/positions", async (c) => {
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

/** Private agent routes are served on a loopback-only port separate from the dashboard. */

import { Hono } from "hono";
import { buildAgentConfig, ingestReportBatch, validAgentToken } from "../services/report.service.js";

const router = new Hono();

/** Rejects every internal request without the generated shared bearer token. */
router.use("*", async (context, next) => {
  if (!validAgentToken(context.req.header("authorization"))) return context.json({ ok: false, error: "Unauthorized" }, 401);
  await next();
});

router.get("/config", async (context) => context.json(await buildAgentConfig()));

router.post("/reports", async (context) => {
  try {
    const payload = await context.req.json();
    return context.json({ ok: true, ...(await ingestReportBatch(payload)) });
  } catch (error) {
    return context.json({ ok: false, error: error instanceof Error ? error.message : "Invalid report batch" }, 400);
  }
});

export { router as internalRoutes };

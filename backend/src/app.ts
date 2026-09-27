import cors from "cors";
import express, { type Express } from "express";

import { errorHandler, unknownRoute } from "./errors";
import { customersRouter } from "./routes/customers";
import { refundRequestsRouter } from "./routes/refundRequests";
import type { ServiceDeps } from "./services/refundService";

export interface AppOptions extends ServiceDeps {
  corsOrigins?: string[];
  /** Active LLM provider, reported by /health (never includes the key). */
  ai?: { provider: string; model: string | null; configured: boolean };
}

export function createApp(options: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: options.corsOrigins ?? ["http://localhost:3000"] }));
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", async (_req, res) => {
    let database = "ok";
    try {
      await options.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = "unavailable";
    }
    res.status(database === "ok" ? 200 : 503).json({
      status: database === "ok" ? "ok" : "degraded",
      database,
      ...(options.ai ? { ai: options.ai } : {}),
    });
  });

  app.use("/refund-requests", refundRequestsRouter(options));
  app.use("/customers", customersRouter(options));

  app.use(unknownRoute);
  app.use(errorHandler);
  return app;
}

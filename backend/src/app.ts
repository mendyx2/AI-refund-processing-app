import cors from "cors";
import express, { type Express } from "express";

import { randomBytes } from "node:crypto";

import { errorHandler, unknownRoute } from "./errors";
import { authRouter } from "./routes/auth";
import { meRouter } from "./routes/me";
import { refundRequestsRouter } from "./routes/refundRequests";
import type { ServiceDeps } from "./services/refundService";

export interface AppOptions extends ServiceDeps {
  corsOrigins?: string[];
  /** Active LLM provider, reported by /health (never includes the key). */
  ai?: { provider: string; model: string | null; configured: boolean };
  /** Signs customer session tokens. Defaults to a random per-process secret. */
  authSecret?: string;
}

export function createApp(options: AppOptions): Express {
  const app = express();
  const secret = options.authSecret ?? randomBytes(32).toString("hex");
  app.disable("x-powered-by");
  // Behind Docker/a proxy, req.ip (used by the sign-in rate limiter) should be the client's.
  app.set("trust proxy", "loopback, linklocal, uniquelocal");
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

  app.use("/auth", authRouter(options, secret));
  app.use("/me", meRouter(options, secret));
  app.use("/refund-requests", refundRequestsRouter(options, secret));

  app.use(unknownRoute);
  app.use(errorHandler);
  return app;
}

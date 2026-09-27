import { createProvider, describeAiConfig, resolveAiConfig } from "./ai/config";
import { RefundAiLayer } from "./aiLayer";
import { createApp } from "./app";
import { createPrisma } from "./db";

const port = Number(process.env.PORT ?? 8000);
const corsOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((o) => o.trim());

const aiConfig = resolveAiConfig(process.env);
const ai = describeAiConfig(aiConfig);
if (aiConfig.provider === "none") {
  console.warn(
    `AI provider not configured (${aiConfig.reason}). Requests that need the model's judgment will be ` +
      "escalated to a human; the policy engine still decides everything else. See .env.example.",
  );
} else {
  console.log(`AI provider: ${ai.provider}, model: ${ai.model}`);
}

const prisma = createPrisma();
const app = createApp({
  prisma,
  assessor: new RefundAiLayer({ provider: createProvider(aiConfig) }),
  corsOrigins,
  ai,
});

const server = app.listen(port, () => {
  console.log(`Refund API listening on http://0.0.0.0:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => void prisma.$disconnect().then(() => process.exit(0)));
  });
}

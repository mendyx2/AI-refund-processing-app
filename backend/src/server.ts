import { RefundAiLayer } from "./aiLayer";
import { createApp } from "./app";
import { createPrisma } from "./db";

const port = Number(process.env.PORT ?? 8000);
const corsOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((o) => o.trim());

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.warn(
    "ANTHROPIC_API_KEY is not set: judgment-call refund requests will be escalated to a human " +
      "(unless credentials come from an `ant auth login` profile).",
  );
}

const prisma = createPrisma();
const app = createApp({ prisma, assessor: new RefundAiLayer(), corsOrigins });

const server = app.listen(port, () => {
  console.log(`Refund API listening on http://0.0.0.0:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => void prisma.$disconnect().then(() => process.exit(0)));
  });
}

import { Router } from "express";
import { z } from "zod";

import { MIN_SUGGESTION_CONFIDENCE } from "../ai/assist";
import { requireCustomer } from "../auth";
import { notFound } from "../errors";
import { getCustomerOrders, type ServiceDeps } from "../services/refundService";

const suggestBody = z
  .object({
    orderId: z.number().int().positive(),
    message: z.string().trim().min(1).max(4000),
  })
  .strict();

/** The signed-in customer's own account: profile + orders, and chat helpers. */
export function meRouter(deps: Pick<ServiceDeps, "prisma" | "assistant">, secret: string): Router {
  const router = Router();
  router.use(requireCustomer(secret));

  router.get("/", async (_req, res) => {
    res.json(await getCustomerOrders(deps.prisma, res.locals.customerId as number));
  });

  /**
   * Suggests a reason code for what the customer typed. Only a suggestion: the
   * chat asks the customer to confirm it before anything is submitted. Never
   * fails the chat: any problem (AI unavailable, low confidence, injection-like
   * text) returns `suggestion: null` and the customer picks from the list.
   */
  router.post("/suggest-reason", async (req, res) => {
    const { orderId, message } = suggestBody.parse(req.body);
    const order = await deps.prisma.order.findFirst({
      where: { id: orderId, customerId: res.locals.customerId as number },
      select: { productName: true, category: true, status: true },
    });
    if (!order) throw notFound(`Order ${orderId} not found`);

    if (!deps.assistant) return void res.json({ suggestion: null });
    const outcome = await deps.assistant.suggestReason(order, message);
    const suggestion = "ok" in outcome && outcome.ok.confidence >= MIN_SUGGESTION_CONFIDENCE ? outcome.ok : null;
    res.json({ suggestion });
  });

  return router;
}

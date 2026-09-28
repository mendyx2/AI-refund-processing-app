import { Router } from "express";
import { z } from "zod";

import { attemptLimiter, signToken, TOKEN_TTL_MS, unauthorized } from "../auth";
import { findCustomerForSignIn, type ServiceDeps } from "../services/refundService";

const signInBody = z
  .object({
    email: z.string().trim().email("Enter a valid email address").max(320),
    orderNumber: z.string().trim().min(1, "Enter an order number").max(40),
  })
  .strict();

export function authRouter(deps: Pick<ServiceDeps, "prisma">, secret: string): Router {
  const router = Router();

  // 10 attempts per IP per 15 minutes.
  router.post("/sign-in", attemptLimiter({ max: 10, windowMs: 15 * 60 * 1000 }), async (req, res) => {
    const { email, orderNumber } = signInBody.parse(req.body);
    const customer = await findCustomerForSignIn(deps.prisma, email, orderNumber);
    // One message for both "no such email" and "wrong order number", so the
    // form can't be used to discover which emails have accounts.
    if (!customer) throw unauthorized("We couldn't find an order with that email and order number.");

    res.json({
      token: signToken(customer.id, secret),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      customer,
    });
  });

  return router;
}

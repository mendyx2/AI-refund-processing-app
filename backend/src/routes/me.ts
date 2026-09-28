import { Router } from "express";

import { requireCustomer } from "../auth";
import { getCustomerOrders, type ServiceDeps } from "../services/refundService";

/** The signed-in customer's own account: profile + orders with their refund requests. */
export function meRouter(deps: Pick<ServiceDeps, "prisma">, secret: string): Router {
  const router = Router();
  router.use(requireCustomer(secret));

  router.get("/", async (_req, res) => {
    res.json(await getCustomerOrders(deps.prisma, res.locals.customerId as number));
  });

  return router;
}

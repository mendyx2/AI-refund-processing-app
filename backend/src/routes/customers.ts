import { Router } from "express";

import { getCustomerOrders, listCustomers, type ServiceDeps } from "../services/refundService";
import { idParam } from "./params";

export function customersRouter(deps: Pick<ServiceDeps, "prisma">): Router {
  const router = Router();

  // No real auth yet: the support page uses this to "log in" as a seeded customer.
  router.get("/", async (_req, res) => {
    res.json(await listCustomers(deps.prisma));
  });

  router.get("/:id/orders", async (req, res) => {
    const { id } = idParam.parse(req.params);
    res.json(await getCustomerOrders(deps.prisma, id));
  });

  return router;
}

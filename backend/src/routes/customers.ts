import { Router } from "express";

import { getCustomerOrders, type ServiceDeps } from "../services/refundService";
import { idParam } from "./params";

export function customersRouter(deps: Pick<ServiceDeps, "prisma">): Router {
  const router = Router();

  router.get("/:id/orders", async (req, res) => {
    const { id } = idParam.parse(req.params);
    res.json(await getCustomerOrders(deps.prisma, id));
  });

  return router;
}

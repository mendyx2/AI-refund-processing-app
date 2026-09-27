import { Router } from "express";
import { z } from "zod";

import { RefundReason, RefundStatus } from "../generated/prisma/enums";
import {
  getRefundRequest,
  listRefundRequests,
  rerunRefundRequest,
  submitRefundRequest,
  type ServiceDeps,
} from "../services/refundService";
import { idParam } from "./params";

export const createRefundRequestBody = z
  .object({
    customerId: z.number().int().positive(),
    orderId: z.number().int().positive(),
    message: z.string().trim().min(1, "message must not be empty").max(4000),
    /** The chat UI's reason picker; free-text-only submissions default to OTHER. */
    reason: z.enum(RefundReason).default("OTHER"),
    /** Partial refunds; defaults to the full order total. */
    amountCents: z.number().int().positive().optional(),
  })
  .strict();

const listQuery = z.object({ status: z.enum(RefundStatus).optional() });

export function refundRequestsRouter(deps: ServiceDeps): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const input = createRefundRequestBody.parse(req.body);
    const result = await submitRefundRequest(deps, input);
    res.status(201).json(result);
  });

  router.get("/", async (req, res) => {
    const { status } = listQuery.parse(req.query);
    res.json(await listRefundRequests(deps.prisma, { status }));
  });

  router.get("/:id", async (req, res) => {
    const { id } = idParam.parse(req.params);
    res.json(await getRefundRequest(deps.prisma, id));
  });

  // Staff action (no auth yet, like the rest of the admin API).
  router.post("/:id/rerun", async (req, res) => {
    const { id } = idParam.parse(req.params);
    res.json(await rerunRefundRequest(deps, id));
  });

  return router;
}

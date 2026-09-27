import { z } from "zod";

/** `:id` route params: positive integer, rejecting "1.5", "1e3", " 1", etc. */
export const idParam = z.object({
  id: z
    .string()
    .regex(/^[1-9]\d{0,9}$/, "id must be a positive integer")
    .transform(Number),
});

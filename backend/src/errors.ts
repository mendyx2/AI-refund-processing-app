import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

/** An error whose message is safe to show to API clients. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFound = (message: string) => new HttpError(404, "not_found", message);
export const conflict = (message: string) => new HttpError(409, "conflict", message);

export const unknownRoute: RequestHandler = (req, _res, next) => {
  next(notFound(`No route for ${req.method} ${req.path}`));
};

/** body-parser errors carry a `type` and an HTTP status. */
function isBodyParserError(err: unknown): err is { type: string; status: number } {
  return typeof err === "object" && err !== null && "type" in err && "status" in err;
}

/**
 * Single place that turns errors into responses. Every error body has the
 * shape { error: { code, message, details? } }. Unexpected errors are logged
 * and returned as a generic 500 so internals never leak to clients.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "validation_error",
        message: "Request validation failed",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (isBodyParserError(err)) {
    const tooLarge = err.type === "entity.too.large";
    res.status(tooLarge ? 413 : 400).json({
      error: {
        code: tooLarge ? "payload_too_large" : "invalid_body",
        message: tooLarge ? "Request body is too large" : "Request body is not valid JSON",
      },
    });
    return;
  }

  console.error(JSON.stringify({ level: "error", event: "unhandled_error", error: String(err?.stack ?? err) }));
  res.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
};

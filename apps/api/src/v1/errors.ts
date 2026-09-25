/**
 * Structured API errors: `{ error: { code, message, details? } }`.
 * Mutator errors are mapped here so the REST API, the CLI and the MCP server report the same codes
 * as the web app (ALREADY_LINKED, DOC_CONFLICT, permission errors…).
 */

import { DOC_CONFLICT, parseDocConflict } from "@feedbacks/schema/docs";
import { ALREADY_LINKED, parseAlreadyLinked } from "@feedbacks/schema/tickets";
import { PermissionError } from "@feedbacks/schema/zero/permissions";
import { ApplicationError } from "@rocicorp/zero";
import { ZodError } from "zod";

export type ErrorCode =
  | "unauthorized"
  | "insufficient_scope"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "already_linked"
  | "doc_conflict"
  | "conflict"
  | "idempotency_key_reused"
  | "idempotency_in_progress"
  | "rate_limited"
  | "unprocessable"
  | "internal_error";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") => new ApiError(404, "not_found", `${what} not found or not accessible`);

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof ZodError)
    return new ApiError(
      400,
      "invalid_request",
      "Invalid request",
      e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  const message = e instanceof Error ? e.message : String(e);
  // Zero validates mutator arguments with the same schemas (the message starts with "Validation failed")
  if ((e as Error | undefined)?.name === "InputValidationError") return new ApiError(400, "invalid_request", message);
  if (e instanceof PermissionError) {
    return /not found|not accessible|unknown/i.test(message)
      ? new ApiError(404, "not_found", message)
      : new ApiError(403, "forbidden", message);
  }
  if (e instanceof ApplicationError || message.includes(ALREADY_LINKED) || message.includes(DOC_CONFLICT)) {
    const links = parseAlreadyLinked(message);
    if (links)
      return new ApiError(409, "already_linked", "Some messages are already linked to a ticket (retry with force: true)", { links });
    const current = parseDocConflict(message);
    if (current !== null)
      return new ApiError(409, "doc_conflict", "The document changed since base_version (reload, or retry with force: true)", {
        currentVersion: current,
      });
    return new ApiError(422, "unprocessable", message);
  }
  return new ApiError(500, "internal_error", "Internal error");
}

export const errorBody = (e: ApiError) => ({
  error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) },
});

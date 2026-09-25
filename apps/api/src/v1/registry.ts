/**
 * Route registry of the REST API v1: each route declares its Zod schemas once; they validate requests
 * and generate the OpenAPI 3.1 document (see openapi.ts). No framework-specific magic.
 */
import type { Context } from "hono";
import type { z } from "zod";
import type { TokenCaller } from "../tokens";

export type Caller = TokenCaller & {
  /** "api" (REST, CLI, scripts) or "mcp" (MCP server) */
  via: "api" | "mcp";
  /** Client label shown as "via …" on messages and comments (X-Feedbacks-Client header) */
  client: string;
};

export type V1Env = { Variables: { caller: Caller } };

type AnyObject = z.ZodObject<z.ZodRawShape>;

export type RouteDef<P extends AnyObject, Q extends AnyObject, B extends z.ZodType, R extends z.ZodType> = {
  method: "get" | "post" | "patch" | "delete";
  /** Hono path relative to /api/v1, e.g. "/tickets/:ref" */
  path: string;
  operationId: string;
  tag: string;
  summary: string;
  description?: string;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  /** HTTP status of a successful response (default 200) */
  status?: 200 | 201;
  handler: (input: {
    caller: Caller;
    params: z.output<P>;
    query: z.output<Q>;
    body: z.output<B>;
    c: Context<V1Env>;
  }) => Promise<z.input<R>>;
};

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous registry
export type AnyRoute = RouteDef<any, any, any, any>;

export const routes: AnyRoute[] = [];

export function defineRoute<P extends AnyObject, Q extends AnyObject, B extends z.ZodType, R extends z.ZodType>(
  def: RouteDef<P, Q, B, R>,
): RouteDef<P, Q, B, R> {
  routes.push(def as AnyRoute);
  return def;
}

/** "/tickets/:ref" → "/tickets/{ref}" */
export const openApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

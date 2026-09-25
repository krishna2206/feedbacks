/**
 * Zero endpoints called by zero-cache (ZERO_QUERY_URL / ZERO_MUTATE_URL). zero-cache forwards
 * the browser's cookies, so the Better Auth session identifies the user; the resulting context
 * drives every permission filter in @feedbacks/schema/zero.
 */
import { mutators, queries, schema, type ZeroContext } from "@feedbacks/schema/zero";
import { mustGetMutator, mustGetQuery } from "@rocicorp/zero";
import { handleMutateRequest, handleQueryRequest } from "@rocicorp/zero/server";
import { zeroDrizzle } from "@rocicorp/zero/server/adapters/drizzle";
import type { Hono } from "hono";
import { auth } from "./auth";
import { db } from "./db";
import { drainDeletions } from "./uploads-sweeper";

export const dbProvider = zeroDrizzle(schema, db);

declare module "@rocicorp/zero" {
  interface DefaultTypes {
    dbProvider: typeof dbProvider;
  }
}

async function contextFrom(request: Request): Promise<ZeroContext | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  return session ? { userID: session.user.id } : null;
}

export function mountZero(app: Hono) {
  app.post("/api/zero/query", async (c) => {
    const ctx = await contextFrom(c.req.raw);
    if (!ctx) return c.json({ error: "unauthorized" }, 401);
    const result = await handleQueryRequest({
      handler: (name, args) => mustGetQuery(queries, name).fn({ args, ctx }),
      schema,
      request: c.req.raw,
      userID: ctx.userID,
    });
    return c.json(result);
  });

  app.post("/api/zero/mutate", async (c) => {
    const ctx = await contextFrom(c.req.raw);
    if (!ctx) return c.json({ error: "unauthorized" }, 401);
    const result = await handleMutateRequest({
      dbProvider,
      handler: (transact) => transact((tx, name, args) => mustGetMutator(mutators, name).fn({ args, tx, ctx })),
      request: c.req.raw,
      userID: ctx.userID,
    });
    // Mutations may have deleted attachments (their files are queued by a trigger): delete them now
    drainDeletions();
    return c.json(result);
  });
}

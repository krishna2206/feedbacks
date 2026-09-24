import { defineMutator, defineMutators, type Transaction } from "@rocicorp/zero";
import { z } from "zod";
import { channelKind } from "../enums";
import { visibleChannels } from "./permissions";
import { zql } from "./schema";

const id = z.string().min(1).max(64);

/**
 * Permission checks run only on the server (`tx.location === "server"`): on the client the
 * membership rows needed for the check may not be synced, and the server result is authoritative.
 */
async function assertOrgMember(tx: Transaction, userID: string, organizationId: string) {
  if (tx.location !== "server") return;
  const m = await tx.run(zql.member.where("organizationId", organizationId).where("userId", userID).one());
  if (!m) throw new Error("Not a member of this organization");
}

export const mutators = defineMutators({
  channels: {
    create: defineMutator(
      z.object({
        id,
        organizationId: id,
        name: z.string().trim().min(1).max(80),
        kind: channelKind.exclude(["dm"]),
        topic: z.string().max(500).nullable().optional(),
        createdAt: z.number(),
      }),
      async ({ tx, ctx, args }) => {
        await assertOrgMember(tx, ctx.userID, args.organizationId);
        await tx.mutate.channel.insert({
          id: args.id,
          organizationId: args.organizationId,
          kind: args.kind,
          name: args.name.toLowerCase().replace(/\s+/g, "-"),
          topic: args.topic ?? null,
          projectId: null,
          createdBy: ctx.userID,
          createdAt: args.createdAt,
          archivedAt: null,
        });
        // The creator is always a member (required for private channels, harmless for public ones)
        await tx.mutate.channelMember.insert({
          id: `${args.id}:${ctx.userID}`,
          organizationId: args.organizationId,
          channelId: args.id,
          userId: ctx.userID,
          lastReadAt: args.createdAt,
          joinedAt: args.createdAt,
        });
      },
    ),
  },
  messages: {
    send: defineMutator(
      z.object({
        id,
        organizationId: id,
        channelId: id,
        body: z.string().trim().min(1).max(20_000),
        parentId: id.nullable().optional(),
        createdAt: z.number(),
      }),
      async ({ tx, ctx, args }) => {
        if (tx.location === "server") {
          const ch = await tx.run(visibleChannels(ctx.userID, args.organizationId).where("id", args.channelId).one());
          if (!ch) throw new Error("Channel not found or not accessible");
        }
        await tx.mutate.message.insert({
          id: args.id,
          organizationId: args.organizationId,
          channelId: args.channelId,
          authorId: ctx.userID,
          parentId: args.parentId ?? null,
          body: args.body,
          // The server clock is authoritative for ordering
          createdAt: tx.location === "server" ? Date.now() : args.createdAt,
          editedAt: null,
          deletedAt: null,
        });
      },
    ),
  },
});

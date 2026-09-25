/**
 * Chat helpers shared by the web client, the API and the mutators.
 *
 * Mentions are stored in message bodies as `<@userId>` tokens (stable when a user is renamed)
 * and rendered as "@Name" by clients.
 */

const MENTION_RE = /<@([A-Za-z0-9_-]{1,64})>/g;

/** User ids mentioned in a message body, without duplicates */
export function mentionedUserIds(body: string): string[] {
  return [...new Set(Array.from(body.matchAll(MENTION_RE), (m) => m[1] as string))];
}

export const mentionToken = (userId: string) => `<@${userId}>`;

/** Splits a body into text and mention parts (for rendering) */
export function splitMentions(body: string): ({ type: "text"; value: string } | { type: "mention"; userId: string })[] {
  const out: ({ type: "text"; value: string } | { type: "mention"; userId: string })[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    const index = m.index ?? 0;
    if (index > last) out.push({ type: "text", value: body.slice(last, index) });
    out.push({ type: "mention", userId: m[1] as string });
    last = index + m[0].length;
  }
  if (last < body.length) out.push({ type: "text", value: body.slice(last) });
  return out;
}

/** Maximum number of people in a direct conversation (including the author) */
export const DM_MAX_MEMBERS = 8;

/**
 * Deterministic id of the direct conversation between a set of users: opening a DM twice
 * (from two devices, or by both people at the same time) always targets the same channel.
 */
export function dmChannelId(organizationId: string, userIds: readonly string[]): string {
  const members = [...new Set(userIds)].sort();
  return `dm.${organizationId}.${members.join(".")}`;
}

/** Normalizes a channel name: lowercase, spaces → dashes, no leading "#" */
export function normalizeChannelName(name: string): string {
  return name.trim().replace(/^#+/, "").toLowerCase().replace(/\s+/g, "-").replace(/-{2,}/g, "-").slice(0, 80);
}

/** Short plain-text preview of a message body (mentions resolved by the caller) */
export function excerpt(body: string, max = 140): string {
  const flat = body
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

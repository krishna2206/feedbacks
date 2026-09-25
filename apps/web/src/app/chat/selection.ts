import { createContext, useContext } from "react";

/**
 * Multi-selection of chat messages (to build or feed a ticket). Provided by the channel page;
 * message rows read it to show their checkbox, highlight and "create ticket" action.
 */
export type ChatSelection = {
  /** The user can create or edit tickets somewhere (otherwise no checkboxes) */
  enabled: boolean;
  selected: ReadonlySet<string>;
  /** Click: plain toggle; Shift = range from the last toggled message; Cmd/Ctrl = toggle */
  toggle: (id: string, mods?: { shiftKey?: boolean }) => void;
  /** "Create ticket" from one message (plus the captures posted right after it by the same author) */
  createFrom: (id: string) => void;
  /** Message under the pointer (the `x` shortcut toggles it) */
  hover: (id: string | null) => void;
};

export const ChatSelectionContext = createContext<ChatSelection | null>(null);
export const useChatSelection = () => useContext(ChatSelectionContext);

/** Messages following `id` that belong with it: same author, attachments only, within 5 minutes */
export function withFollowingCaptures<
  M extends { id: string; authorId: string | null; body: string; createdAt: number | null; attachments: readonly unknown[] },
>(ordered: readonly M[], id: string): string[] {
  const i = ordered.findIndex((m) => m.id === id);
  if (i < 0) return [id];
  const first = ordered[i] as M;
  const out = [id];
  for (let j = i + 1; j < ordered.length; j++) {
    const m = ordered[j] as M;
    if (m.authorId !== first.authorId || m.body.trim() || !m.attachments.length || (m.createdAt ?? 0) - (first.createdAt ?? 0) > 5 * 60_000)
      break;
    out.push(m.id);
  }
  return out;
}

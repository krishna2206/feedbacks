import { dayKey, Icon } from "@feedbacks/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OrgUser } from "../org-data";
import { type MessageData, MessageRow } from "./MessageRow";

const GROUP_WINDOW_MS = 5 * 60_000;
const BOTTOM_EPSILON = 48;
const LOAD_MORE_THRESHOLD = 400;

type Row =
  | { type: "intro"; key: string }
  | { type: "loader"; key: string }
  | { type: "day"; key: string; ts: number }
  | { type: "new"; key: string }
  | { type: "msg"; key: string; msg: MessageData; first: boolean };

type Props = {
  /** Chronological order */
  messages: readonly MessageData[];
  hasMore: boolean;
  onLoadMore: () => void;
  /** Read position when the channel was opened (draws the "New messages" divider) */
  lastReadSeqAtOpen: number | null;
  meId: string;
  users: Map<string, OrgUser>;
  people: readonly OrgUser[];
  isAdmin: boolean;
  onOpenThread?: (id: string) => void;
  /** Called while the bottom of the conversation is visible, with the latest sequence */
  onReadUpTo?: (seq: number) => void;
  highlightId?: string;
  intro: ReactNode;
};

export function MessageList({
  messages,
  hasMore,
  onLoadMore,
  lastReadSeqAtOpen,
  meId,
  users,
  people,
  isAdmin,
  onOpenThread,
  onReadUpTo,
  highlightId,
  intro,
}: Props) {
  const { t, i18n } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState<null | "new" | "latest">(null);
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const initialized = useRef(false);
  const lastKey = useRef<string | null>(null);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [hasMore ? { type: "loader", key: "loader" } : { type: "intro", key: "intro" }];
    let prev: MessageData | undefined;
    let newShown = false;
    for (const m of messages) {
      const ts = m.createdAt ?? Date.now();
      const newDay = !prev || dayKey(prev.createdAt ?? ts) !== dayKey(ts);
      if (newDay) out.push({ type: "day", key: `day-${dayKey(ts)}`, ts });
      const isNew = !newShown && lastReadSeqAtOpen !== null && m.seq !== null && m.seq > lastReadSeqAtOpen && m.authorId !== meId;
      if (isNew) {
        out.push({ type: "new", key: "new" });
        newShown = true;
      }
      const first =
        newDay || isNew || !prev || prev.authorId !== m.authorId || ts - (prev.createdAt ?? 0) > GROUP_WINDOW_MS || !!prev.deletedAt;
      out.push({ type: "msg", key: m.id, msg: m, first });
      prev = m;
    }
    return out;
  }, [messages, hasMore, lastReadSeqAtOpen, meId]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    getItemKey: (i) => rows[i]?.key ?? i,
    estimateSize: (i) => {
      const r = rows[i];
      if (!r) return 32;
      if (r.type === "msg") return (r.first ? 60 : 30) + (r.msg.attachments.length ? 200 : 0) + (r.msg.reactions.length ? 32 : 0);
      return r.type === "intro" ? 120 : 40;
    },
    overscan: 10,
  });

  const scrollToBottom = useCallback(() => {
    if (rows.length) virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    // Measurements settle after the first paint: stick once more
    requestAnimationFrame(() => {
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [rows.length, virtualizer]);

  const latestSeq = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const s = messages[i]?.seq;
      if (s !== null && s !== undefined) return s;
    }
    return 0;
  }, [messages]);

  const reportRead = useCallback(() => {
    if (atBottom.current && document.visibilityState === "visible" && latestSeq) onReadUpTo?.(latestSeq);
  }, [latestSeq, onReadUpTo]);

  // Initial position, new messages, and history prepends
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (!initialized.current) {
      initialized.current = true;
      lastKey.current = last?.id ?? null;
      const newIdx = rows.findIndex((r) => r.type === "new");
      if (highlightId) {
        const i = rows.findIndex((r) => r.key === highlightId);
        if (i >= 0) {
          virtualizer.scrollToIndex(i, { align: "center" });
          return;
        }
      }
      if (newIdx >= 0 && newIdx < rows.length - 12) virtualizer.scrollToIndex(newIdx, { align: "start" });
      else scrollToBottom();
      return;
    }
    // Older messages were prepended: keep the anchored message where it was
    if (anchor.current) {
      const a = anchor.current;
      const i = rows.findIndex((r) => r.key === a.key);
      const start = i >= 0 ? virtualizer.measurementsCache[i]?.start : undefined;
      if (start !== undefined) el.scrollTop = start - a.offset;
      anchor.current = null;
    }
    // A message arrived at the end
    if (last && last.id !== lastKey.current) {
      lastKey.current = last.id;
      if (atBottom.current || last.authorId === meId) scrollToBottom();
      else setShowJump("new");
    }
  }, [rows, messages, meId, highlightId, scrollToBottom, virtualizer]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = distance < BOTTOM_EPSILON;
    if (atBottom.current) {
      setShowJump(null);
      reportRead();
    } else if (distance > el.clientHeight * 2) setShowJump((j) => j ?? "latest");
    if (hasMore && el.scrollTop < LOAD_MORE_THRESHOLD && !anchor.current) {
      const firstMsg = rows.find((r) => r.type === "msg");
      const i = firstMsg ? rows.indexOf(firstMsg) : -1;
      const start = i >= 0 ? virtualizer.measurementsCache[i]?.start : undefined;
      if (firstMsg && start !== undefined) {
        anchor.current = { key: firstMsg.key, offset: start - el.scrollTop };
        onLoadMore();
      }
    }
  };

  // Mark as read when the tab becomes visible again at the bottom, and when new messages arrive
  useEffect(() => {
    reportRead();
    const onVis = () => reportRead();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [reportRead]);

  const dayLabel = (ts: number) => {
    const d = dayKey(ts);
    if (d === dayKey(Date.now())) return t("channel.today");
    if (d === dayKey(Date.now() - 86_400_000)) return t("channel.yesterday");
    return new Date(ts).toLocaleDateString(i18n.language, { weekday: "long", day: "numeric", month: "long" });
  };

  const items = virtualizer.getVirtualItems();
  return (
    <div className="chat__viewport">
      <div className="chat__scroll" ref={scroller} onScroll={onScroll}>
        <div className="chat__canvas" style={{ height: virtualizer.getTotalSize() }}>
          <div className="chat__items" style={{ transform: `translateY(${items[0]?.start ?? 0}px)` }}>
            {items.map((vi) => {
              const r = rows[vi.index];
              if (!r) return null;
              return (
                <div key={vi.key} data-index={vi.index} ref={virtualizer.measureElement}>
                  {r.type === "intro" && intro}
                  {r.type === "loader" && <div className="chat__loader">{t("chat.loadingOlder")}</div>}
                  {r.type === "day" && <div className="chat__day">{dayLabel(r.ts)}</div>}
                  {r.type === "new" && <div className="chat__new">{t("chat.newMessages")}</div>}
                  {r.type === "msg" && (
                    <MessageRow
                      message={r.msg}
                      first={r.first}
                      users={users}
                      people={people}
                      isAdmin={isAdmin}
                      onOpenThread={onOpenThread}
                      highlighted={r.msg.id === highlightId}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          className="chat__jump"
          onClick={() => {
            scrollToBottom();
            setShowJump(null);
          }}
        >
          {showJump === "new" ? t("chat.newMessagesBelow") : t("chat.jumpToLatest")}
          <Icon name="arrowDown" size={14} />
        </button>
      )}
    </div>
  );
}

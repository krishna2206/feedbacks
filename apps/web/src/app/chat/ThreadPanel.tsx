import { queries } from "@feedbacks/schema/zero";
import { Button, Icon, Tooltip } from "@feedbacks/ui";
import { useQuery } from "@rocicorp/zero/react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "../org-context";
import type { OrgUser } from "../org-data";
import { Composer } from "./Composer";
import { MessageRow } from "./MessageRow";

const GROUP_WINDOW_MS = 5 * 60_000;

export function ThreadPanel({
  parentId,
  channelName,
  canPost,
  users,
  people,
  isAdmin,
  onClose,
}: {
  parentId: string;
  channelName: string;
  canPost: boolean;
  users: Map<string, OrgUser>;
  people: readonly OrgUser[];
  isAdmin: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [thread] = useQuery(queries.messages.thread({ organizationId: org.id, parentId }));
  const scroller = useRef<HTMLDivElement>(null);
  const replies = thread?.replies ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === "Escape" && !["INPUT", "TEXTAREA"].includes(el.tagName)) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Follow new replies
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll only when the number of replies changes
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [replies.length]);

  return (
    <aside className="thread" aria-label={t("chat.thread")}>
      <header className="thread__header">
        <span className="thread__title">{t("chat.thread")}</span>
        <span className="thread__channel truncate">{t("chat.threadIn", { name: channelName })}</span>
        <span className="spacer" />
        <Tooltip content={t("chat.closeThread")} shortcut="Esc" placement="bottom">
          <Button
            variant="muted"
            size="sm"
            iconOnly
            icon={<Icon name="x" size={14} />}
            onClick={onClose}
            aria-label={t("chat.closeThread")}
          />
        </Tooltip>
      </header>
      <div className="thread__scroll" ref={scroller}>
        {thread && (
          <>
            <MessageRow message={thread} first users={users} people={people} isAdmin={isAdmin} />
            {replies.length > 0 && <div className="thread__count">{t("chat.replies", { count: replies.length })}</div>}
            {replies.map((r, i) => {
              const prev = replies[i - 1];
              const first = !prev || prev.authorId !== r.authorId || (r.createdAt ?? 0) - (prev.createdAt ?? 0) > GROUP_WINDOW_MS;
              return <MessageRow key={r.id} message={r} first={first} users={users} people={people} isAdmin={isAdmin} />;
            })}
          </>
        )}
      </div>
      {thread && canPost && !thread.deletedAt && (
        <Composer channelId={thread.channelId} parentId={thread.id} placeholder={t("chat.replyPlaceholder")} people={people} autoFocus />
      )}
    </aside>
  );
}

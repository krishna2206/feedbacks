import { mutators } from "@feedbacks/schema/zero";
import { Icon, Popover, Tooltip, useMenu } from "@feedbacks/ui";
import { useZero } from "@rocicorp/zero/react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "../org-context";

/* A deliberately small emoji set (no multi-MB emoji database): the common reactions of team chat. */
const FREQUENT = ["👍", "❤️", "😂", "🎉", "👀", "🙏", "🔥", "✅"];
const PEOPLE = [
  "😀",
  "😃",
  "😄",
  "😁",
  "😅",
  "🤣",
  "😊",
  "🙂",
  "😉",
  "😍",
  "🤩",
  "😘",
  "😎",
  "🤔",
  "🤨",
  "😐",
  "🙄",
  "😬",
  "😴",
  "😷",
  "🤯",
  "😱",
  "😢",
  "😭",
  "😤",
  "😡",
  "🥳",
  "🤗",
  "🫡",
  "👏",
  "🙌",
  "👌",
  "✌️",
  "🤞",
  "💪",
  "👋",
  "🫶",
  "🤝",
  "👎",
  "💯",
];
const OBJECTS = [
  "⭐",
  "✨",
  "⚡",
  "💡",
  "🚀",
  "🐛",
  "🛠️",
  "🔧",
  "📌",
  "📎",
  "📝",
  "📣",
  "⏰",
  "⏳",
  "🎯",
  "🏁",
  "🚧",
  "❗",
  "❓",
  "⚠️",
  "❌",
  "✔️",
  "➕",
  "🔒",
  "💬",
  "👉",
  "☕",
  "🍕",
  "🎂",
  "🌍",
];

type Reaction = { id: string; emoji: string; userId: string; user?: { name: string } | null };

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const all = useMemo(() => [...new Set([...FREQUENT, ...PEOPLE, ...OBJECTS])], []);
  const groups = q
    ? [{ label: "", items: all.filter((e) => e.includes(q.trim())) }]
    : [
        { label: t("emoji.frequent"), items: FREQUENT },
        { label: t("emoji.people"), items: PEOPLE },
        { label: t("emoji.objects"), items: OBJECTS },
      ];
  return (
    <div className="emoji-picker">
      <div className="menu-filter">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("emoji.search")} />
      </div>
      <div className="emoji-picker__body">
        {groups.map((g) => (
          <div key={g.label || "results"}>
            {g.label && <div className="emoji-picker__group">{g.label}</div>}
            <div className="emoji-picker__grid">
              {g.items.map((e) => (
                <button key={e} type="button" className="emoji-picker__item" onClick={() => onPick(e)}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Button that opens the picker and toggles the chosen reaction */
export function AddReactionButton({
  messageId,
  className,
  onOpenChange,
}: {
  messageId: string;
  className?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const zero = useZero();
  const { org } = useOrg();
  const menu = useMenu();
  const close = () => {
    menu.close();
    onOpenChange?.(false);
  };
  return (
    <>
      <Tooltip content={t("chat.react")} placement="top">
        <button
          type="button"
          className={className ?? "msg-action"}
          data-active={menu.open || undefined}
          aria-label={t("chat.react")}
          onClick={(e) => {
            menu.toggleFrom(e);
            onOpenChange?.(!menu.open);
          }}
        >
          <Icon name="smile" size={16} />
        </button>
      </Tooltip>
      <Popover anchor={menu.anchor} onClose={close} placement="bottom-end" width={292}>
        <EmojiPicker
          onPick={(emoji) => {
            zero.mutate(mutators.reactions.toggle({ organizationId: org.id, messageId, emoji, at: Date.now() }));
            close();
          }}
        />
      </Popover>
    </>
  );
}

export function Reactions({ messageId, reactions, meId }: { messageId: string; reactions: readonly Reaction[]; meId: string }) {
  const { t } = useTranslation();
  const zero = useZero();
  const { org } = useOrg();
  const grouped = useMemo(() => {
    const map = new Map<string, Reaction[]>();
    for (const r of reactions) map.set(r.emoji, [...(map.get(r.emoji) ?? []), r]);
    return [...map.entries()];
  }, [reactions]);
  if (!grouped.length) return null;
  return (
    <div className="reactions">
      {grouped.map(([emoji, list]) => {
        const mine = list.some((r) => r.userId === meId);
        const names = list.map((r) => (r.userId === meId ? t("chat.you") : (r.user?.name ?? "?"))).join(", ");
        return (
          <Tooltip key={emoji} content={t("chat.reactedBy", { names, emoji })} placement="top">
            <button
              type="button"
              className="reaction"
              data-mine={mine || undefined}
              onClick={() => zero.mutate(mutators.reactions.toggle({ organizationId: org.id, messageId, emoji, at: Date.now() }))}
            >
              <span className="reaction__emoji">{emoji}</span>
              <span className="reaction__count">{list.length}</span>
            </button>
          </Tooltip>
        );
      })}
      <AddReactionButton messageId={messageId} className="reaction reaction--add" />
    </div>
  );
}

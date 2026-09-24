import { newId } from "@feedbacks/schema/ids";
import { mutators, queries } from "@feedbacks/schema/zero";
import { Avatar, Button, clock, dayKey, Icon } from "@feedbacks/ui";
import { useQuery, useZero } from "@rocicorp/zero/react";
import { useParams } from "@tanstack/react-router";
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./chat.css";
import { useOrg } from "./org-context";
import { ViewHeader } from "./ViewHeader";

const GROUP_WINDOW_MS = 5 * 60_000;

export function ChannelPage() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { channelId } = useParams({ from: "/$orgSlug/c/$channelId" });
  const [channel, channelResult] = useQuery(queries.channels.get({ organizationId: org.id, channelId }));
  const [latest] = useQuery(queries.messages.byChannel({ organizationId: org.id, channelId, limit: 200 }));
  const messages = useMemo(() => [...latest].reverse(), [latest]);
  const scroller = useRef<HTMLDivElement>(null);

  // Stick to the bottom when new messages arrive
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll only when the number of messages changes
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  if (!channel) return channelResult.type === "complete" ? <div className="empty">{t("channel.notFound")}</div> : null;

  const dayLabel = (ts: number) => {
    const d = dayKey(ts);
    if (d === dayKey(Date.now())) return t("channel.today");
    if (d === dayKey(Date.now() - 86_400_000)) return t("channel.yesterday");
    return new Date(ts).toLocaleDateString(i18n.language, { weekday: "long", day: "numeric", month: "long" });
  };

  return (
    <>
      <ViewHeader>
        <span className="crumb">
          <Icon name={channel.kind === "private" ? "lock" : "hash"} size={14} />
          {channel.name}
        </span>
        {channel.topic && <span className="chat__topic truncate">{channel.topic}</span>}
      </ViewHeader>
      <div className="chat">
        <div className="chat__scroll" ref={scroller}>
          <div className="chat__spacer" />
          <div className="chat__intro">
            <h2>{t("channel.empty", { name: channel.name })}</h2>
            {messages.length === 0 && <p>{t("channel.emptyHint")}</p>}
          </div>
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const newDay = !prev || dayKey(prev.createdAt ?? 0) !== dayKey(m.createdAt ?? 0);
            const first = newDay || prev.authorId !== m.authorId || (m.createdAt ?? 0) - (prev.createdAt ?? 0) > GROUP_WINDOW_MS;
            const time = clock(m.createdAt ?? Date.now(), i18n.language);
            return (
              <Fragment key={m.id}>
                {newDay && <div className="chat__day">{dayLabel(m.createdAt ?? Date.now())}</div>}
                <div className={`msg${first ? " msg--first" : ""}`}>
                  {first ? <Avatar user={m.author ?? null} size={24} /> : <span className="msg__gutter">{time}</span>}
                  <div>
                    {first && (
                      <div className="msg__head">
                        <span className="msg__author">{m.author?.name ?? "—"}</span>
                        <span className="msg__time">{time}</span>
                      </div>
                    )}
                    <div className="msg__body">{m.body}</div>
                  </div>
                </div>
              </Fragment>
            );
          })}
        </div>
        <Composer channelId={channel.id} channelName={channel.name} />
      </div>
    </>
  );
}

function Composer({ channelId, channelName }: { channelId: string; channelName: string }) {
  const { t } = useTranslation();
  const zero = useZero();
  const { org } = useOrg();
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const autosize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  const send = () => {
    const body = text.trim();
    if (!body) return;
    zero.mutate(mutators.messages.send({ id: newId(), organizationId: org.id, channelId, body, createdAt: Date.now() }));
    setText("");
    requestAnimationFrame(autosize);
  };

  return (
    <div className="composer-wrap">
      <div className="composer" data-surface="elevated">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={t("channel.composerPlaceholder", { name: channelName })}
          onChange={(e) => {
            setText(e.target.value);
            autosize();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <Button
          variant={text.trim() ? "primary" : "secondary"}
          size="sm"
          iconOnly
          icon={<Icon name="arrowUp" size={14} />}
          onClick={send}
          aria-label="Send"
        />
      </div>
    </div>
  );
}

import { mentionToken } from "@feedbacks/schema/chat";
import { newId } from "@feedbacks/schema/ids";
import { mutators } from "@feedbacks/schema/zero";
import { Avatar, Button, Icon, Tooltip, toast } from "@feedbacks/ui";
import { useZero } from "@rocicorp/zero/react";
import { type Ref, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { encodeDocMentions, useDocIndex } from "../docs/data";
import { useOrg } from "../org-context";
import type { OrgUser } from "../org-data";
import { type UploadedAttachment, uploadFile } from "./upload";

export type ComposerHandle = { addFiles: (files: FileList | File[]) => void; focus: () => void };

type Pending = { key: string; file: File; preview: string | null; status: "uploading" | "done" | "error"; result?: UploadedAttachment };

const MAX_MB = 25;
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Replaces "@Name" written for known people by `<@id>` tokens (longest names first) */
export function encodeMentions(text: string, people: readonly OrgUser[]) {
  let out = text;
  for (const u of [...people].sort((a, b) => b.name.length - a.name.length)) {
    const escaped = u.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|[^\\w@])@${escaped}(?![\\w])`, "g"), (_, pre: string) => `${pre}${mentionToken(u.id)}`);
  }
  return out;
}

/** Inverse of encodeMentions, for editing */
export function decodeMentions(text: string, users: Map<string, OrgUser>) {
  return text.replace(/<@([A-Za-z0-9_-]{1,64})>/g, (_, id: string) => `@${users.get(id)?.name ?? "unknown"}`);
}

const draftKey = (channelId: string, parentId?: string) => `draft:${channelId}:${parentId ?? ""}`;
const readDraft = (k: string) => {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
};
const writeDraft = (k: string, v: string) => {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {}
};

export function Composer({
  channelId,
  placeholder,
  parentId,
  people,
  autoFocus,
  ref,
}: {
  channelId: string;
  placeholder: string;
  parentId?: string;
  /** Mention candidates (members who can read the channel) */
  people: readonly OrgUser[];
  autoFocus?: boolean;
  ref?: Ref<ComposerHandle>;
}) {
  const { t } = useTranslation();
  const zero = useZero();
  const { org, user } = useOrg();
  const key = draftKey(channelId, parentId);
  const [text, setText] = useState(() => readDraft(key));
  const [pending, setPending] = useState<Pending[]>([]);
  const [mention, setMention] = useState<{ query: string; start: number; index: number } | null>(null);
  // `[[` → documents the user can read (inserted as [[Title]], stored as <doc:id>)
  const [docMention, setDocMention] = useState<{ query: string; start: number; index: number } | null>(null);
  const docIndex = useDocIndex();
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const autosize = useCallback(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, []);

  // Draft follows the channel/thread
  useEffect(() => {
    setText(readDraft(key));
    setPending([]);
    requestAnimationFrame(autosize);
  }, [key, autosize]);
  useEffect(() => writeDraft(key, text), [key, text]);
  // Previews are object URLs: free them when they leave the composer
  useEffect(
    () => () => {
      for (const p of pending) if (p.preview) URL.revokeObjectURL(p.preview);
    },
    [pending],
  );

  const addFiles = useCallback(
    (list: FileList | File[]) => {
      for (const file of Array.from(list)) {
        if (file.size > MAX_MB * 1024 * 1024) {
          toast({ title: t("chat.tooLarge", { name: file.name, max: MAX_MB }), tone: "error" });
          continue;
        }
        const k = newId();
        const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
        setPending((p) => [...p, { key: k, file, preview, status: "uploading" }]);
        uploadFile(file, org.id, channelId).then(
          (result) => setPending((p) => p.map((x) => (x.key === k ? { ...x, status: "done", result } : x))),
          () => {
            setPending((p) => p.map((x) => (x.key === k ? { ...x, status: "error" } : x)));
            toast({ title: t("chat.uploadFailed"), description: file.name, tone: "error" });
          },
        );
      }
    },
    [org.id, channelId, t],
  );

  useImperativeHandle(ref, () => ({ addFiles, focus: () => area.current?.focus() }), [addFiles]);

  const candidates = useMemo(() => {
    if (!mention) return [];
    const q = norm(mention.query);
    return people.filter((u) => u.id !== user.id && (!q || norm(u.name).includes(q) || norm(u.email).startsWith(q))).slice(0, 8);
  }, [mention, people, user.id]);

  const detectMention = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = before.match(/(^|\s)@([^\s@]{0,32})$/);
    setMention(m ? { query: m[2] ?? "", start: caret - (m[2]?.length ?? 0) - 1, index: 0 } : null);
    const d = before.match(/\[\[([^\]\n]{0,60})$/);
    setDocMention(d ? { query: d[1] ?? "", start: caret - (d[1]?.length ?? 0) - 2, index: 0 } : null);
  };

  const docCandidates = useMemo(() => {
    if (!docMention) return [];
    const q = norm(docMention.query);
    return [...docIndex.values()].filter((d) => !q || norm(d.title).includes(q)).slice(0, 8);
  }, [docMention, docIndex]);

  const insertDoc = (d: { title: string }) => {
    if (!docMention || !area.current) return;
    const caret = area.current.selectionStart;
    const next = `${text.slice(0, docMention.start)}[[${d.title}]] ${text.slice(caret)}`;
    const pos = docMention.start + d.title.length + 5;
    setText(next);
    setDocMention(null);
    requestAnimationFrame(() => {
      area.current?.setSelectionRange(pos, pos);
      area.current?.focus();
    });
  };

  const insertMention = (u: OrgUser) => {
    if (!mention || !area.current) return;
    const el = area.current;
    const caret = el.selectionStart;
    const next = `${text.slice(0, mention.start)}@${u.name} ${text.slice(caret)}`;
    const pos = mention.start + u.name.length + 2;
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
      autosize();
    });
  };

  const uploading = pending.some((p) => p.status === "uploading");
  const ready = pending.filter((p) => p.status === "done" && p.result);
  const canSend = !uploading && (text.trim().length > 0 || ready.length > 0);

  const send = () => {
    if (!canSend) return;
    zero.mutate(
      mutators.messages.send({
        id: newId(),
        organizationId: org.id,
        channelId,
        parentId: parentId ?? null,
        body: encodeDocMentions(encodeMentions(text.trim(), people), docIndex),
        attachments: ready.map((p) => p.result as UploadedAttachment),
        createdAt: Date.now(),
      }),
    );
    setText("");
    setPending([]);
    setMention(null);
    setDocMention(null);
    requestAnimationFrame(autosize);
  };

  return (
    <div className="composer-wrap">
      {docMention && (
        <div className="mention-list" data-surface="menu" role="listbox">
          {docCandidates.length === 0 ? (
            <div className="menu-empty">{t("docs.mentionEmpty")}</div>
          ) : (
            docCandidates.map((d, i) => (
              <button
                key={d.id}
                type="button"
                role="option"
                aria-selected={i === docMention.index}
                className="menu-item"
                data-focused={i === docMention.index}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertDoc(d);
                }}
                onMouseMove={() => i !== docMention.index && setDocMention({ ...docMention, index: i })}
              >
                <span className="menu-item__icon">
                  <Icon name="doc" size={14} />
                </span>
                <span className="menu-item__label">{d.title}</span>
              </button>
            ))
          )}
          <div className="mention-list__hint">{t("docs.mentionHint")}</div>
        </div>
      )}
      {mention && (
        <div className="mention-list" data-surface="menu" role="listbox">
          {candidates.length === 0 ? (
            <div className="menu-empty">{t("chat.mentionEmpty")}</div>
          ) : (
            candidates.map((u, i) => (
              <button
                key={u.id}
                type="button"
                role="option"
                aria-selected={i === mention.index}
                className="menu-item"
                data-focused={i === mention.index}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(u);
                }}
                onMouseMove={() => i !== mention.index && setMention({ ...mention, index: i })}
              >
                <span className="menu-item__icon">
                  <Avatar user={u} size={18} />
                </span>
                <span className="menu-item__label">{u.name}</span>
                <span className="menu-item__hint truncate">{u.email}</span>
              </button>
            ))
          )}
          <div className="mention-list__hint">{t("chat.mentionHint")}</div>
        </div>
      )}
      <div className="composer" data-surface="elevated">
        {pending.length > 0 && (
          <div className="composer__files">
            {pending.map((p) => (
              <div key={p.key} className="composer-file" data-status={p.status}>
                {p.preview ? <img src={p.preview} alt="" /> : <Icon name="doc" size={18} />}
                <span className="composer-file__name truncate">{p.file.name}</span>
                {p.status === "uploading" && <span className="composer-file__spinner" role="img" aria-label={t("chat.uploading")} />}
                <button
                  type="button"
                  className="composer-file__remove"
                  aria-label={t("chat.remove")}
                  onClick={() => setPending((list) => list.filter((x) => x.key !== p.key))}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer__row">
          <textarea
            ref={area}
            rows={1}
            value={text}
            autoFocus={autoFocus}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(e) => {
              setText(e.target.value);
              detectMention(e.target.value, e.target.selectionStart);
              autosize();
            }}
            onSelect={(e) => detectMention(e.currentTarget.value, e.currentTarget.selectionStart)}
            onBlur={() => {
              setMention(null);
              setDocMention(null);
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length) {
                e.preventDefault();
                addFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if (docMention && docCandidates.length) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const d = e.key === "ArrowDown" ? 1 : -1;
                  setDocMention({ ...docMention, index: (docMention.index + d + docCandidates.length) % docCandidates.length });
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  const d = docCandidates[docMention.index];
                  if (d) insertDoc(d);
                  return;
                }
              }
              if (e.key === "Escape" && docMention) {
                e.preventDefault();
                setDocMention(null);
                return;
              }
              if (mention && candidates.length) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const d = e.key === "ArrowDown" ? 1 : -1;
                  setMention({ ...mention, index: (mention.index + d + candidates.length) % candidates.length });
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  const u = candidates[mention.index];
                  if (u) insertMention(u);
                  return;
                }
              }
              if (e.key === "Escape" && mention) {
                e.preventDefault();
                setMention(null);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <Tooltip content={t("chat.attach")} placement="top">
            <Button
              variant="muted"
              size="sm"
              iconOnly
              icon={<Icon name="clip" size={16} />}
              onClick={() => fileInput.current?.click()}
              aria-label={t("chat.attach")}
            />
          </Tooltip>
          <Tooltip content={t("chat.sendHint")} placement="top">
            <Button
              className="composer__send"
              variant={canSend ? "primary" : "secondary"}
              size="sm"
              iconOnly
              disabled={!canSend}
              icon={<Icon name="arrowUp" size={14} />}
              onClick={send}
              aria-label={t("chat.send")}
            />
          </Tooltip>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>
    </div>
  );
}

import { type DiffLine, lineDiff, parseDocConflict } from "@feedbacks/schema/docs";
import { newId } from "@feedbacks/schema/ids";
import { ticketKey } from "@feedbacks/schema/tickets";
import { mutators, queries } from "@feedbacks/schema/zero";
import { Avatar, Button, Icon, Menu, type MenuEntry, Tooltip, timeAgo, toast, useMenu } from "@feedbacks/ui";
import { useQuery, useZero } from "@rocicorp/zero/react";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { uploadFile } from "../chat/upload";
import { useOrg } from "../org-context";
import { useOrgMembers } from "../org-data";
import { TicketStatusIcon } from "../tickets/meta";
import { shortcutsBlocked } from "../ui-state";
import { ViewHeader } from "../ViewHeader";
import { DocMarkdown, headingsOf } from "./DocMarkdown";
import { Crumbs, DocsShell, MoveModal, NameModal, Restricted } from "./DocsPages";
import { canEdit, canManage, useDocsTree, useViewAs } from "./data";
import type { EditorApi } from "./MarkdownEditor";
import { ShareModal } from "./ShareModal";
import { levelLabel, useReport } from "./util";
import "./docs.css";

const MarkdownEditor = lazy(() => import("./MarkdownEditor"));

type ServerResult = { type: string; error?: { message?: string } };

export function DocPage() {
  const { docId = "" } = useParams({ strict: false }) as { docId?: string };
  return <DocView key={docId} docId={docId} />;
}

function DocView({ docId }: { docId: string }) {
  const { t, i18n } = useTranslation();
  const zero = useZero();
  const navigate = useNavigate();
  const report = useReport();
  const { org, user } = useOrg();
  const { users } = useOrgMembers();
  const tree = useDocsTree();
  const viewAs = useViewAs();
  const search = useSearch({ strict: false }) as { edit?: boolean; history?: boolean };
  const [doc, result] = useQuery(queries.docs.get({ organizationId: org.id, docId, viewAs: viewAs ?? undefined }));
  const [sharing, setSharing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const more = useMenu();

  const setSearch = (patch: { edit?: boolean; history?: boolean }) =>
    void navigate({
      to: "/$orgSlug/docs/d/$docId",
      params: { orgSlug: org.slug, docId },
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      replace: true,
    });

  const level = doc ? tree.levelOf(doc.aclEntries) : null;
  const editable = canEdit(level) && !tree.readOnly;
  const editing = !!search.edit && editable;
  const content = doc?.versions[0]?.content ?? "";
  const headings = useMemo(() => headingsOf(content), [content]);

  // `e` edits (outside text fields and overlays)
  const live = useRef({ editable, editing });
  live.current = { editable, editing };
  // biome-ignore lint/correctness/useExhaustiveDependencies: setSearch only depends on the doc id
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || shortcutsBlocked(e)) return;
      if (e.key === "e" && live.current.editable && !live.current.editing) {
        e.preventDefault();
        setSearch({ edit: true, history: undefined });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [docId]);

  if (!doc) {
    if (result.type === "complete" && tree.loaded) return <Restricted nodeId={docId} loaded />;
    return (
      <DocsShell current={{ kind: "doc", id: docId }}>
        <ViewHeader>
          <Crumbs tree={tree} folderId={null} />
        </ViewHeader>
      </DocsShell>
    );
  }

  const editor = doc.updatedBy ? users.get(doc.updatedBy) : undefined;
  const importedFrom = doc.source?.startsWith("import:") ? doc.source.slice("import:".length) : doc.source;

  const moreItems: MenuEntry[] = [
    ...(editable
      ? [
          { id: "rename", label: t("docs.rename"), icon: <Icon name="edit" size={14} />, onSelect: () => setRenaming(true) },
          { id: "move", label: t("docs.moveTo"), icon: <Icon name="folder" size={14} />, onSelect: () => setMoving(true) },
        ]
      : []),
    {
      id: "copy",
      label: t("docs.copyLink"),
      icon: <Icon name="link" size={14} />,
      onSelect: () => {
        void navigator.clipboard.writeText(`${location.origin}/${org.slug}/docs/d/${docId}`);
        toast({ title: t("docs.linkCopied") });
      },
    },
    ...(editable
      ? [
          { kind: "separator" as const, id: "s" },
          {
            id: "trash",
            label: t("docs.moveToTrash"),
            icon: <Icon name="trash" size={14} />,
            onSelect: () => {
              void report(
                zero.mutate(mutators.trash.delete({ organizationId: org.id, nodeId: docId, at: Date.now() })),
                t("docs.movedToTrash"),
              );
              if (doc.folderId) void navigate({ to: "/$orgSlug/docs/f/$folderId", params: { orgSlug: org.slug, folderId: doc.folderId } });
              else void navigate({ to: "/$orgSlug/docs", params: { orgSlug: org.slug } });
            },
          },
        ]
      : []),
  ];

  if (editing)
    return (
      <DocsShell current={{ kind: "doc", id: docId }}>
        <DocEditor
          doc={{ id: doc.id, title: doc.title, version: doc.version ?? 1, folderId: doc.folderId ?? null }}
          content={content}
          latestContent={content}
          onDone={() => setSearch({ edit: undefined })}
        />
      </DocsShell>
    );

  return (
    <DocsShell current={{ kind: "doc", id: docId }}>
      <ViewHeader>
        <Crumbs
          tree={tree}
          folderId={doc.folderId ?? null}
          tail={
            <span className="crumb-sep">
              <Icon name="chevronRight" size={14} />
            </span>
          }
        />
        <span className="crumb">
          <span className="truncate">{doc.title}</span>
        </span>
        <span className="spacer" />
        <Tooltip content={t("docs.history")} placement="bottom">
          <Button
            variant="muted"
            size="sm"
            iconOnly
            icon={<Icon name="history" size={14} />}
            active={!!search.history}
            onClick={() => {
              setSelectedVersion(null);
              setSearch({ history: search.history ? undefined : true });
            }}
            aria-label={t("docs.history")}
          />
        </Tooltip>
        {canManage(level) && !tree.readOnly && (
          <Button variant="secondary" size="sm" icon={<Icon name="share" size={14} />} onClick={() => setSharing(true)}>
            {t("docs.share")}
          </Button>
        )}
        {editable && (
          <Tooltip content={t("docs.edit")} shortcut="E" placement="bottom">
            <Button
              variant="primary"
              size="sm"
              icon={<Icon name="edit" size={14} />}
              onClick={() => setSearch({ edit: true, history: undefined })}
            >
              {t("docs.edit")}
            </Button>
          </Tooltip>
        )}
        <Button
          variant="muted"
          size="sm"
          iconOnly
          icon={<Icon name="more" size={14} />}
          active={more.open}
          onClick={more.toggleFrom}
          aria-label={t("chat.more")}
        />
      </ViewHeader>

      <div className="doc">
        <div className="doc-scroll">
          {selectedVersion ? (
            <VersionDiff
              docId={docId}
              versionId={selectedVersion}
              editable={editable}
              currentVersion={doc.version ?? 1}
              onClose={() => setSelectedVersion(null)}
            />
          ) : (
            <article className="doc-content">
              <h1 className="doc-title">{doc.title}</h1>
              <div className="doc-meta">
                <Avatar user={editor ?? null} size={16} />
                <span>
                  {t("docs.updatedBy", {
                    name: editor?.name ?? t("docs.someone"),
                    when: timeAgo(doc.updatedAt ?? Date.now(), i18n.language),
                  })}
                </span>
                <span className="doc-meta__sep">·</span>
                <span className="tabular">{t("docs.versionN", { n: doc.version ?? 1 })}</span>
                {level && (
                  <>
                    <span className="doc-meta__sep">·</span>
                    <span>{levelLabel(t, level)}</span>
                  </>
                )}
                {!doc.inheritGrants && (
                  <>
                    <span className="doc-meta__sep">·</span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <Icon name="lock" size={12} />
                      {t("docs.restricted")}
                    </span>
                  </>
                )}
                {importedFrom && (
                  <>
                    <span className="doc-meta__sep">·</span>
                    <span className="truncate" title={importedFrom}>
                      {t("docs.importedFrom", { path: importedFrom })}
                    </span>
                  </>
                )}
              </div>
              <div className="doc-body">
                {content.trim() ? (
                  <DocMarkdown text={content} users={(id) => users.get(id)} meId={user.id} />
                ) : (
                  <p className="doc-empty">{editable ? t("docs.emptyDocEditable") : t("docs.emptyDoc")}</p>
                )}
              </div>
              {doc.links.length > 0 && (
                <section className="doc-section">
                  <h2 className="doc-section__title">
                    <Icon name="ticket" size={14} />
                    {t("docs.referencedBy", { count: doc.links.length })}
                  </h2>
                  <div className="doc-refs">
                    {doc.links.map((l) =>
                      l.ticket?.project ? (
                        <Link
                          key={l.id}
                          to="/$orgSlug/issue/$ref"
                          params={{ orgSlug: org.slug, ref: ticketKey(l.ticket.project.key, l.ticket.number) }}
                          className="doc-ref"
                        >
                          <TicketStatusIcon status={l.ticket.status} size={14} />
                          <span className="doc-ref__key">{ticketKey(l.ticket.project.key, l.ticket.number)}</span>
                          <span className="truncate">{l.ticket.title}</span>
                        </Link>
                      ) : null,
                    )}
                  </div>
                </section>
              )}
            </article>
          )}
        </div>
        {!selectedVersion && !search.history && headings.length >= 3 && (
          <aside className="doc-toc" aria-label={t("docs.toc")}>
            <div className="doc-toc__inner">
              <div className="doc-toc__title">{t("docs.toc")}</div>
              {headings.map((h) => (
                <a key={h.slug} href={`#${h.slug}`} data-level={h.level}>
                  {h.text.replace(/[*_`]/g, "")}
                </a>
              ))}
            </div>
          </aside>
        )}
        {search.history && (
          <DocHistory
            docId={docId}
            selected={selectedVersion}
            onSelect={setSelectedVersion}
            onClose={() => {
              setSelectedVersion(null);
              setSearch({ history: undefined });
            }}
          />
        )}
      </div>

      <Menu anchor={more.anchor} onClose={more.close} items={moreItems} width={220} placement="bottom-end" />
      {sharing && <ShareModal nodeId={docId} onClose={() => setSharing(false)} />}
      {moving && <MoveModal item={{ kind: "doc", id: docId }} onClose={() => setMoving(false)} />}
      {renaming && (
        <NameModal
          title={t("docs.rename")}
          initial={doc.title}
          onClose={() => setRenaming(false)}
          onSubmit={(title) => {
            void report(zero.mutate(mutators.docs.rename({ organizationId: org.id, docId, title, at: Date.now() })));
            setRenaming(false);
          }}
        />
      )}
    </DocsShell>
  );
}

/* ------------------------------------------------------------------ */
/* Editor: markdown source | live preview, conflict handling           */
/* ------------------------------------------------------------------ */

function DocEditor({
  doc,
  content,
  latestContent,
  onDone,
}: {
  doc: { id: string; title: string; version: number; folderId: string | null };
  content: string;
  latestContent: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const zero = useZero();
  const { org, user } = useOrg();
  const { users } = useOrgMembers();
  const [title, setTitle] = useState(doc.title);
  const [text, setText] = useState(content);
  const [base, setBase] = useState(doc.version);
  const [initial, setInitial] = useState({ title: doc.title, text: content });
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<number | null>(null);
  const [uploads, setUploads] = useState(0);
  const api = useRef<EditorApi>(null);
  const dirty = title !== initial.title || text !== initial.text;
  // Someone else saved a newer version while we edit (seen through sync, before we even try to save)
  const newerElsewhere = !saving && doc.version > base;

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  const save = async (force = false) => {
    if (!title.trim() || saving) return;
    setSaving(true);
    const w = zero.mutate(
      mutators.docs.save({
        organizationId: org.id,
        docId: doc.id,
        title: title.trim(),
        content: text,
        baseVersion: base,
        force,
        versionId: newId(),
        at: Date.now(),
      }),
    );
    const r = (await w.server) as ServerResult;
    setSaving(false);
    if (r.type === "error") {
      const current = parseDocConflict(r.error?.message);
      if (current != null) setConflict(current);
      else toast({ tone: "error", title: t("docs.saveFailed"), description: r.error?.message }, 6000);
      return;
    }
    setConflict(null);
    toast({ title: t("docs.saved") });
    onDone();
  };

  const reload = () => {
    setTitle(doc.title);
    setText(latestContent);
    setInitial({ title: doc.title, text: latestContent });
    setBase(doc.version);
    setConflict(null);
  };

  const addFiles = (files: File[]) => {
    for (const file of files) {
      setUploads((n) => n + 1);
      uploadFile(file, org.id, { docId: doc.id })
        .then((a) => {
          const url = `/api/files/${a.id}`;
          api.current?.insert(a.kind === "image" ? `![${a.name}](${url})\n` : `[${a.name}](${url})`);
        })
        .catch(() => toast({ tone: "error", title: t("chat.uploadFailed"), description: file.name }))
        .finally(() => setUploads((n) => n - 1));
    }
  };

  const cancel = () => {
    if (dirty && !window.confirm(t("docs.discardConfirm"))) return;
    onDone();
  };

  return (
    <>
      <ViewHeader>
        <span className="crumb">
          <Icon name="edit" size={14} />
          {t("docs.editing")}
        </span>
        {dirty && <span className="doc-dirty" title={t("docs.unsaved")} />}
        {uploads > 0 && <span className="faint">{t("chat.uploading")}</span>}
        <span className="spacer" />
        <Button variant="muted" size="sm" onClick={cancel}>
          {t("common.cancel")}
        </Button>
        <Tooltip content={t("docs.save")} shortcut={["⌘", "S"]} placement="bottom">
          <Button variant="primary" size="sm" disabled={saving || !title.trim() || !dirty} onClick={() => void save()}>
            {saving ? t("docs.saving") : t("docs.save")}
          </Button>
        </Tooltip>
      </ViewHeader>
      {(conflict != null || newerElsewhere) && (
        <div className="doc-conflict" role="alert">
          <Icon name="history" size={14} />
          <span>
            <b>{t("docs.conflictTitle")}</b> {t("docs.conflictText")}
          </span>
          <span className="spacer" />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void navigator.clipboard.writeText(text).then(() => toast({ title: t("docs.copied") }))}
          >
            {t("docs.copyMine")}
          </Button>
          <Button variant="secondary" size="sm" onClick={reload}>
            {t("docs.reload")}
          </Button>
          <Button variant="danger" size="sm" onClick={() => void save(true)}>
            {t("docs.overwrite")}
          </Button>
        </div>
      )}
      <div className="doc-edit">
        <div className="doc-edit__pane">
          <input
            className="doc-edit__title"
            value={title}
            placeholder={t("docs.titlePlaceholder")}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
          />
          <Suspense fallback={<div className="doc-edit__cm" />}>
            <MarkdownEditor
              value={text}
              onChange={setText}
              onSave={() => void save()}
              onFiles={addFiles}
              placeholder={t("docs.editorPlaceholder")}
              api={api}
            />
          </Suspense>
        </div>
        <div className="doc-edit__pane">
          <div className="doc-edit__label">{t("docs.preview")}</div>
          <div className="doc-edit__preview">
            <h1 className="doc-title">{title || t("docs.untitled")}</h1>
            <div className="doc-body">
              <DocMarkdown text={text} users={(id) => users.get(id)} meId={user.id} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* History: versions, diffs, restore                                   */
/* ------------------------------------------------------------------ */

function DocHistory({
  docId,
  selected,
  onSelect,
  onClose,
}: {
  docId: string;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const [versions] = useQuery(queries.docs.history({ organizationId: org.id, docId }));
  return (
    <aside className="doc-history" aria-label={t("docs.history")}>
      <div className="doc-history__head">
        <Icon name="history" size={14} />
        {t("docs.history")}
        <span className="spacer" />
        <Button variant="muted" size="sm" iconOnly icon={<Icon name="x" size={14} />} onClick={onClose} aria-label={t("common.close")} />
      </div>
      <div className="doc-history__list" role="listbox">
        {versions.map((v, i) => (
          <div
            key={v.id}
            className="doc-version"
            role="option"
            tabIndex={0}
            aria-selected={selected === v.id}
            data-selected={selected === v.id}
            onClick={() => onSelect(i === 0 && selected === v.id ? null : v.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSelect(v.id);
            }}
          >
            <Avatar user={v.author ?? null} size={20} />
            <span className="doc-version__main">
              <span className="doc-version__who">{v.author?.name ?? t("docs.someone")}</span>
              <span className="doc-version__when">{timeAgo(v.createdAt ?? Date.now(), i18n.language)}</span>
            </span>
            <span className="doc-version__num">{i === 0 ? t("docs.current") : `v${v.number}`}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

/** Changes introduced by a version (compared with the previous one), and "restore" */
function VersionDiff({
  docId,
  versionId,
  editable,
  currentVersion,
  onClose,
}: {
  docId: string;
  versionId: string;
  editable: boolean;
  currentVersion: number;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const zero = useZero();
  const report = useReport();
  const { org } = useOrg();
  const [versions] = useQuery(queries.docs.history({ organizationId: org.id, docId }));
  const index = versions.findIndex((v) => v.id === versionId);
  const version = versions[index];
  const previous = versions[index + 1];
  const lines = useMemo(() => (version ? lineDiff(previous?.content ?? "", version.content) : []), [version, previous]);
  if (!version) return null;
  const titleChanged = previous && previous.title !== version.title;
  return (
    <article className="doc-content">
      <div className="doc-meta" style={{ marginTop: 0, marginBottom: 16 }}>
        <Avatar user={version.author ?? null} size={16} />
        <span>
          {t("docs.versionBy", {
            n: version.number,
            name: version.author?.name ?? t("docs.someone"),
            when: timeAgo(version.createdAt ?? Date.now(), i18n.language),
          })}
        </span>
        <span className="spacer" />
        <Button variant="muted" size="sm" onClick={onClose}>
          {t("docs.backToDoc")}
        </Button>
        {editable && version.number !== currentVersion && (
          <Button
            variant="secondary"
            size="sm"
            icon={<Icon name="restore" size={14} />}
            onClick={() =>
              void report(
                zero.mutate(
                  mutators.docs.restoreVersion({
                    organizationId: org.id,
                    docId,
                    fromVersionId: version.id,
                    baseVersion: currentVersion,
                    versionId: newId(),
                    at: Date.now(),
                  }),
                ),
                t("docs.restoredVersion", { n: version.number }),
              ).then((ok) => ok && onClose())
            }
          >
            {t("docs.restoreVersion")}
          </Button>
        )}
      </div>
      <h1 className="doc-title">{version.title}</h1>
      {titleChanged && <p className="faint">{t("docs.titleWas", { title: previous.title })}</p>}
      <div className="doc-body">{previous ? <Diff lines={lines} /> : <p className="faint">{t("docs.firstVersion")}</p>}</div>
    </article>
  );
}

/** Line diff with unchanged runs folded (3 lines of context) */
function Diff({ lines }: { lines: DiffLine[] }) {
  const { t } = useTranslation();
  const CONTEXT = 3;
  const keep = lines.map(
    (l, i) => l.type !== "same" || lines.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((x) => x.type !== "same"),
  );
  if (!lines.some((l) => l.type !== "same")) return <p className="faint">{t("docs.noChanges")}</p>;
  const out: React.ReactNode[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (!keep[i]) {
      skipped++;
      return;
    }
    if (skipped) {
      out.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: positions of an immutable diff
        <div key={`gap-${i}`} className="doc-diff__gap">
          {t("docs.unchangedLines", { count: skipped })}
        </div>,
      );
      skipped = 0;
    }
    out.push(
      // biome-ignore lint/suspicious/noArrayIndexKey: positions of an immutable diff
      <div key={i} className="doc-diff__line" data-type={l.type}>
        <span className="doc-diff__sign">{l.type === "add" ? "+" : l.type === "del" ? "−" : ""}</span>
        <span>{l.text || " "}</span>
      </div>,
    );
  });
  if (skipped)
    out.push(
      <div key="gap-end" className="doc-diff__gap">
        {t("docs.unchangedLines", { count: skipped })}
      </div>,
    );
  return <div className="doc-diff">{out}</div>;
}

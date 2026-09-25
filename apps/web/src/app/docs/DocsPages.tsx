import type { AccessLevel } from "@feedbacks/schema/enums";
import { newId } from "@feedbacks/schema/ids";
import { mutators, queries } from "@feedbacks/schema/zero";
import { Avatar, Button, Caret, Icon, type IconName, Menu, type MenuEntry, Modal, shortDate, Tooltip, toast, useMenu } from "@feedbacks/ui";
import { useQuery, useZero } from "@rocicorp/zero/react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "../org-context";
import { useOrgMembers } from "../org-data";
import { ViewHeader } from "../ViewHeader";
import { canEdit, canManage, setViewAs, type TreeDoc, type TreeFolder, useDocsTree, useViewAs } from "./data";
import { ShareModal } from "./ShareModal";
import { levelLabel, useReport } from "./util";
import "./docs.css";

type Tree = ReturnType<typeof useDocsTree>;
type Current = { kind: "folder"; id: string | null } | { kind: "doc"; id: string } | { kind: "trash" };

/* ------------------------------------------------------------------ */
/* Shell: view-as banner + tree + main column                          */
/* ------------------------------------------------------------------ */

export function DocsShell({ current, children }: { current: Current; children: ReactNode }) {
  const tree = useDocsTree();
  return (
    <>
      <ViewAsBanner />
      <div className="docs">
        <DocsTree tree={tree} current={current} />
        <div className="docs-main">{children}</div>
      </div>
    </>
  );
}

export function ViewAsBanner() {
  const { t } = useTranslation();
  const viewAs = useViewAs();
  const { users } = useOrgMembers();
  if (!viewAs) return null;
  return (
    <div className="docs-viewas" role="status">
      <Icon name="eye" size={14} />
      <span>
        {t("docs.viewingAs")} <b>{users.get(viewAs)?.name ?? "…"}</b> · {t("docs.readOnly")}
      </span>
      <Button variant="secondary" size="sm" onClick={() => setViewAs(null)}>
        {t("docs.backToMe")}
      </Button>
    </div>
  );
}

const EXPANDED_KEY = "docs:expanded";
function useExpanded() {
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (id: string, value?: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (value ?? !next.has(id)) next.add(id);
      else next.delete(id);
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  return { open, toggle };
}

/** Drag and drop in the tree and the lists: moving needs edit on the item and on the destination */
function useMover(tree: Tree) {
  const zero = useZero();
  const { org } = useOrg();
  const report = useReport();
  const { t } = useTranslation();
  return (item: { kind: "folder" | "doc"; id: string }, destination: string | null) => {
    if (tree.readOnly) return;
    const level = item.kind === "folder" ? tree.folderLevel(item.id) : tree.docLevel(item.id);
    if (!canEdit(level) || !canEdit(tree.folderLevel(destination))) {
      toast({ tone: "error", title: t("docs.cantMove") });
      return;
    }
    if (item.kind === "folder") {
      if (item.id === destination || tree.pathOf(destination).some((f) => f.id === item.id)) return; // not inside itself
      const siblings = tree.childFolders(destination);
      const sortOrder = (siblings[siblings.length - 1]?.sortOrder ?? 0) + 1;
      void report(
        zero.mutate(mutators.folders.move({ organizationId: org.id, folderId: item.id, parentId: destination, sortOrder, at: Date.now() })),
      );
    } else {
      const siblings = tree.childDocs(destination);
      const sortOrder = (siblings[siblings.length - 1]?.sortOrder ?? 0) + 1;
      void report(
        zero.mutate(mutators.docs.move({ organizationId: org.id, docId: item.id, folderId: destination, sortOrder, at: Date.now() })),
      );
    }
  };
}

type DragItem = { kind: "folder" | "doc"; id: string };
const DRAG_TYPE = "application/x-feedbacks-doc";
const readDrag = (e: React.DragEvent): DragItem | null => {
  try {
    return JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as DragItem;
  } catch {
    return null;
  }
};

function DocsTree({ tree, current }: { tree: Tree; current: Current }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { open, toggle } = useExpanded();
  const move = useMover(tree);
  const [dropOn, setDropOn] = useState<string | null | undefined>(undefined);

  // Reveal the current item
  const currentId = current.kind === "trash" ? null : current.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the current item (or the tree size) changes
  useEffect(() => {
    const folderId =
      current.kind === "folder" ? currentId : current.kind === "doc" && currentId ? (tree.docById.get(currentId)?.folderId ?? null) : null;
    for (const f of tree.pathOf(folderId)) if (!open.has(f.id)) toggle(f.id, true);
  }, [current.kind, currentId, tree.folders.length]);

  const dropProps = (target: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropOn(target);
    },
    onDragLeave: () => setDropOn(undefined),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropOn(undefined);
      const item = readDrag(e);
      if (item) move(item, target);
    },
  });

  const renderFolder = (f: TreeFolder, depth: number): ReactNode => {
    const isOpen = open.has(f.id);
    const children = tree.childFolders(f.id);
    const docs = tree.childDocs(f.id);
    const empty = !children.length && !docs.length;
    return (
      <div key={f.id}>
        <Link
          to="/$orgSlug/docs/f/$folderId"
          params={{ orgSlug: org.slug, folderId: f.id }}
          className="docs-node"
          data-active={current.kind === "folder" && current.id === f.id}
          data-drop={dropOn === f.id || undefined}
          style={{ paddingLeft: 4 + depth * 14 }}
          draggable={!tree.readOnly}
          onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: "folder", id: f.id }))}
          {...dropProps(f.id)}
        >
          <button
            type="button"
            className="docs-node__caret"
            data-open={isOpen}
            aria-label={isOpen ? t("docs.collapse") : t("docs.expand")}
            style={{ visibility: empty ? "hidden" : undefined }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggle(f.id);
            }}
          >
            <Caret />
          </button>
          <Icon name={isOpen && !empty ? "folderOpen" : "folder"} size={16} />
          <span className="docs-node__label">{f.name}</span>
          {!f.inheritGrants && (
            <Tooltip content={t("docs.restricted")} placement="right">
              <span className="docs-node__lock">
                <Icon name="lock" size={12} />
              </span>
            </Tooltip>
          )}
        </Link>
        {isOpen && (
          <div>
            {children.map((c) => renderFolder(c, depth + 1))}
            {docs.map((d) => renderDoc(d, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const renderDoc = (d: TreeDoc, depth: number) => (
    <Link
      key={d.id}
      to="/$orgSlug/docs/d/$docId"
      params={{ orgSlug: org.slug, docId: d.id }}
      className="docs-node"
      data-active={current.kind === "doc" && current.id === d.id}
      style={{ paddingLeft: 4 + depth * 14 + 22 }}
      draggable={!tree.readOnly}
      onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: "doc", id: d.id }))}
    >
      <Icon name="doc" size={16} />
      <span className="docs-node__label">{d.title}</span>
      {!d.inheritGrants && (
        <span className="docs-node__lock">
          <Icon name="lock" size={12} />
        </span>
      )}
    </Link>
  );

  return (
    <nav className="docs-tree" aria-label={t("docs.tree")}>
      <div className="docs-tree__scroll">
        <div className="docs-tree__root" data-drop={dropOn === null || undefined} {...dropProps(null)}>
          <Link
            to="/$orgSlug/docs"
            params={{ orgSlug: org.slug }}
            className="docs-node"
            data-active={current.kind === "folder" && current.id === null}
          >
            <span className="docs-node__caret" />
            <Icon name="book" size={16} />
            <span className="docs-node__label">{t("docs.all")}</span>
          </Link>
          {tree.childFolders(null).map((f) => renderFolder(f, 0))}
          {tree.childDocs(null).map((d) => renderDoc(d, 0))}
        </div>
      </div>
      <div className="docs-tree__foot">
        <Link to="/$orgSlug/docs/trash" params={{ orgSlug: org.slug }} className="docs-node" data-active={current.kind === "trash"}>
          <span className="docs-node__caret" />
          <Icon name="trash" size={16} />
          <span className="docs-node__label">{t("docs.trash")}</span>
        </Link>
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* Folder view (root = "All documents")                                */
/* ------------------------------------------------------------------ */

export function DocsRootPage() {
  return <FolderPage folderId={null} />;
}

export function DocsFolderPage() {
  const { folderId = "" } = useParams({ strict: false }) as { folderId?: string };
  return <FolderPage key={folderId} folderId={folderId} />;
}

export function Crumbs({ tree, folderId, tail }: { tree: Tree; folderId: string | null; tail?: ReactNode }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <>
      <Link to="/$orgSlug/docs" params={{ orgSlug: org.slug }} className="crumb">
        <Icon name="book" size={14} />
        {t("nav.docs")}
      </Link>
      {tree.pathOf(folderId).map((f) => (
        <span key={f.id} style={{ display: "contents" }}>
          <span className="crumb-sep">
            <Icon name="chevronRight" size={14} />
          </span>
          <Link to="/$orgSlug/docs/f/$folderId" params={{ orgSlug: org.slug, folderId: f.id }} className="crumb crumb--muted">
            <span className="truncate">{f.name}</span>
          </Link>
        </span>
      ))}
      {tail}
    </>
  );
}

function FolderPage({ folderId }: { folderId: string | null }) {
  const { t, i18n } = useTranslation();
  const zero = useZero();
  const navigate = useNavigate();
  const { org } = useOrg();
  const { users, isAdmin } = useOrgMembers();
  const tree = useDocsTree();
  const report = useReport();
  const folder = folderId ? tree.folderById.get(folderId) : null;
  const level = tree.folderLevel(folderId);
  const writable = !tree.readOnly && canEdit(level);
  const [naming, setNaming] = useState<null | { kind: "newFolder" } | { kind: "rename"; item: DragItem; name: string }>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const [moving, setMoving] = useState<DragItem | null>(null);
  const [importing, setImporting] = useState(false);
  const viewAsMenu = useMenu();
  const viewAs = useViewAs();
  const move = useMover(tree);
  const [dropOn, setDropOn] = useState<string | null>(null);

  if (folderId && !folder) return <Restricted nodeId={folderId} loaded={tree.loaded} />;

  const folders = tree.childFolders(folderId);
  const docs = tree.childDocs(folderId);

  const createDoc = () => {
    const id = newId();
    const last = docs[docs.length - 1];
    void report(
      zero.mutate(
        mutators.docs.create({
          id,
          organizationId: org.id,
          folderId,
          title: t("docs.untitled"),
          content: "",
          sortOrder: (last?.sortOrder ?? 0) + 1,
          versionId: newId(),
          at: Date.now(),
        }),
      ),
    );
    void navigate({ to: "/$orgSlug/docs/d/$docId", params: { orgSlug: org.slug, docId: id }, search: { edit: true } });
  };

  const rowMenu = (item: DragItem, name: string, itemLevel: AccessLevel | null): MenuEntry[] => [
    ...(canEdit(itemLevel) && !tree.readOnly
      ? [
          {
            id: "rename",
            label: t("docs.rename"),
            icon: <Icon name="edit" size={14} />,
            onSelect: () => setNaming({ kind: "rename", item, name }),
          },
          { id: "move", label: t("docs.moveTo"), icon: <Icon name="folder" size={14} />, onSelect: () => setMoving(item) },
        ]
      : []),
    ...(canManage(itemLevel) && !tree.readOnly
      ? [{ id: "share", label: t("docs.share"), icon: <Icon name="share" size={14} />, onSelect: () => setSharing(item.id) }]
      : []),
    {
      id: "copy",
      label: t("docs.copyLink"),
      icon: <Icon name="link" size={14} />,
      onSelect: () => {
        void navigator.clipboard.writeText(`${location.origin}/${org.slug}/docs/${item.kind === "doc" ? "d" : "f"}/${item.id}`);
        toast({ title: t("docs.linkCopied") });
      },
    },
    ...(canEdit(itemLevel) && !tree.readOnly
      ? [
          { kind: "separator" as const, id: "s" },
          {
            id: "delete",
            label: t("docs.moveToTrash"),
            icon: <Icon name="trash" size={14} />,
            onSelect: () =>
              void report(
                zero.mutate(mutators.trash.delete({ organizationId: org.id, nodeId: item.id, at: Date.now() })),
                t("docs.movedToTrash"),
              ),
          },
        ]
      : []),
  ];

  return (
    <DocsShell current={{ kind: "folder", id: folderId }}>
      <ViewHeader>
        <Crumbs tree={tree} folderId={folderId} />
        {folder && !folder.inheritGrants && (
          <Tooltip content={t("docs.restricted")} placement="bottom">
            <span className="faint" style={{ display: "inline-flex" }}>
              <Icon name="lock" size={14} />
            </span>
          </Tooltip>
        )}
        <span className="spacer" />
        {isAdmin && (
          <Tooltip content={t("docs.viewAs")} placement="bottom">
            <Button
              variant="muted"
              size="sm"
              iconOnly
              icon={<Icon name={viewAs ? "eye" : "personSwap"} size={14} />}
              active={viewAsMenu.open || !!viewAs}
              onClick={viewAsMenu.toggleFrom}
              aria-label={t("docs.viewAs")}
            />
          </Tooltip>
        )}
        {folderId && canManage(level) && !tree.readOnly && (
          <Button variant="secondary" size="sm" icon={<Icon name="share" size={14} />} onClick={() => setSharing(folderId)}>
            {t("docs.share")}
          </Button>
        )}
        {writable && (
          <>
            <Button variant="secondary" size="sm" icon={<Icon name="download" size={14} />} onClick={() => setImporting(true)}>
              {t("docs.import")}
            </Button>
            <Tooltip content={t("docs.newFolder")} placement="bottom">
              <Button
                variant="secondary"
                size="sm"
                iconOnly
                icon={<Icon name="folderAdd" size={14} />}
                onClick={() => setNaming({ kind: "newFolder" })}
                aria-label={t("docs.newFolder")}
              />
            </Tooltip>
            <Button variant="primary" size="sm" icon={<Icon name="docAdd" size={14} />} onClick={createDoc}>
              {t("docs.newDoc")}
            </Button>
          </>
        )}
      </ViewHeader>
      <div className="docs-scroll">
        {tree.loaded && !folders.length && !docs.length ? (
          <div className="doc-locked">
            <div className="doc-locked__icon">
              <Icon name={folderId ? "folderOpen" : "book"} size={22} />
            </div>
            <h3>{folderId ? t("docs.emptyFolder") : t("docs.emptyRoot")}</h3>
            <p>{writable ? t("docs.emptyText") : t("docs.emptyReadOnly")}</p>
            {writable && (
              <div className="doc-locked__actions">
                <Button variant="primary" size="md" onClick={createDoc}>
                  {t("docs.newDoc")}
                </Button>
                <Button variant="secondary" size="md" onClick={() => setImporting(true)}>
                  {t("docs.import")}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="docs-list">
            <div className="docs-list__head">
              <span>{t("docs.name")}</span>
              <span>{t("docs.access")}</span>
              <span>{t("docs.updated")}</span>
              <span />
            </div>
            {folders.map((f) => {
              const l = tree.levelOf(f.aclEntries);
              return (
                <Row
                  key={f.id}
                  icon="folder"
                  title={f.name}
                  restricted={!f.inheritGrants}
                  level={l}
                  updated={<span>{shortDate(f.updatedAt ?? f.createdAt ?? Date.now(), i18n.language)}</span>}
                  menu={rowMenu({ kind: "folder", id: f.id }, f.name, l)}
                  onOpen={() => void navigate({ to: "/$orgSlug/docs/f/$folderId", params: { orgSlug: org.slug, folderId: f.id } })}
                  dragItem={{ kind: "folder", id: f.id }}
                  dropping={dropOn === f.id}
                  onDropState={(on) => setDropOn(on ? f.id : null)}
                  onDropItem={(item) => move(item, f.id)}
                />
              );
            })}
            {docs.map((d) => {
              const l = tree.levelOf(d.aclEntries);
              const editor = d.updatedBy ? users.get(d.updatedBy) : undefined;
              return (
                <Row
                  key={d.id}
                  icon="doc"
                  title={d.title}
                  restricted={!d.inheritGrants}
                  imported={!!d.source}
                  level={l}
                  updated={
                    <>
                      <Avatar user={editor ?? null} size={16} />
                      <span className="truncate">{shortDate(d.updatedAt ?? Date.now(), i18n.language)}</span>
                    </>
                  }
                  menu={rowMenu({ kind: "doc", id: d.id }, d.title, l)}
                  onOpen={() => void navigate({ to: "/$orgSlug/docs/d/$docId", params: { orgSlug: org.slug, docId: d.id } })}
                  dragItem={{ kind: "doc", id: d.id }}
                />
              );
            })}
          </div>
        )}
      </div>

      <Menu
        anchor={viewAsMenu.anchor}
        onClose={viewAsMenu.close}
        width={260}
        filterPlaceholder={t("docs.viewAsPlaceholder")}
        items={[
          ...(viewAs
            ? [
                { id: "me", label: t("docs.backToMe"), icon: <Icon name="arrowLeft" size={14} />, onSelect: () => setViewAs(null) },
                { kind: "separator" as const, id: "s" },
              ]
            : []),
          ...[...users.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((u) => ({
              id: u.id,
              label: u.name,
              keywords: u.email,
              icon: <Avatar user={u} size={16} />,
              checked: viewAs === u.id,
              onSelect: () => setViewAs(u.id),
            })),
        ]}
      />
      {naming && (
        <NameModal
          title={naming.kind === "newFolder" ? t("docs.newFolder") : t("docs.rename")}
          initial={naming.kind === "rename" ? naming.name : ""}
          placeholder={naming.kind === "newFolder" ? t("docs.folderName") : ""}
          onClose={() => setNaming(null)}
          onSubmit={(name) => {
            if (naming.kind === "newFolder") {
              const last = folders[folders.length - 1];
              void report(
                zero.mutate(
                  mutators.folders.create({
                    id: newId(),
                    organizationId: org.id,
                    parentId: folderId,
                    name,
                    sortOrder: (last?.sortOrder ?? 0) + 1,
                    at: Date.now(),
                  }),
                ),
              );
            } else if (naming.item.kind === "folder") {
              void report(zero.mutate(mutators.folders.rename({ organizationId: org.id, folderId: naming.item.id, name, at: Date.now() })));
            } else {
              void report(
                zero.mutate(mutators.docs.rename({ organizationId: org.id, docId: naming.item.id, title: name, at: Date.now() })),
              );
            }
            setNaming(null);
          }}
        />
      )}
      {moving && <MoveModal item={moving} onClose={() => setMoving(null)} />}
      {sharing && <ShareModal nodeId={sharing} onClose={() => setSharing(null)} />}
      {importing && <ImportModal folderId={folderId} onClose={() => setImporting(false)} />}
    </DocsShell>
  );
}

function Row({
  icon,
  title,
  restricted,
  imported,
  level,
  updated,
  menu,
  onOpen,
  dragItem,
  dropping,
  onDropState,
  onDropItem,
}: {
  icon: IconName;
  title: string;
  restricted: boolean;
  imported?: boolean;
  level: AccessLevel | null;
  updated: ReactNode;
  menu: MenuEntry[];
  onOpen: () => void;
  dragItem: DragItem;
  dropping?: boolean;
  onDropState?: (on: boolean) => void;
  onDropItem?: (item: DragItem) => void;
}) {
  const { t } = useTranslation();
  const m = useMenu();
  // The menu renders in a portal: kept outside the row so its clicks don't bubble to the row (React bubbles through portals)
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: a row with its own action button (a <button> can't contain one) */}
      <div
        className="docs-row"
        role="button"
        tabIndex={0}
        data-drop={dropping || undefined}
        draggable
        onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragItem))}
        onDragOver={(e) => {
          if (!onDropItem || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          onDropState?.(true);
        }}
        onDragLeave={() => onDropState?.(false)}
        onDrop={(e) => {
          if (!onDropItem) return;
          e.preventDefault();
          onDropState?.(false);
          const item = readDrag(e);
          if (item && item.id !== dragItem.id) onDropItem(item);
        }}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter") onOpen();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          m.openAt(e.clientX, e.clientY);
        }}
      >
        <span className="docs-row__name">
          <Icon name={icon} size={16} />
          <span className="docs-row__title">{title}</span>
          {restricted && <Icon name="lock" size={12} className="faint" />}
          {imported && <span className="docs-source">{t("docs.imported")}</span>}
        </span>
        <span className="docs-access">{levelLabel(t, level)}</span>
        <span className="docs-row__meta">{updated}</span>
        <Button
          variant="muted"
          size="sm"
          iconOnly
          icon={<Icon name="more" size={14} />}
          active={m.open}
          aria-label={t("chat.more")}
          onClick={(e) => {
            e.stopPropagation();
            m.toggleFrom(e);
          }}
        />
      </div>
      <Menu anchor={m.anchor} onClose={m.close} items={menu} width={220} placement="bottom-end" />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */

export function NameModal({
  title,
  initial,
  placeholder,
  onClose,
  onSubmit,
}: {
  title: string;
  initial: string;
  placeholder?: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial);
  return (
    <Modal open onClose={onClose} width={420} labelledBy="name-modal-title">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSubmit(name.trim());
        }}
      >
        <div className="modal__header">
          <span id="name-modal-title" className="modal__title">
            {title}
          </span>
        </div>
        <div className="modal__body">
          <input
            className="input"
            autoFocus
            value={name}
            placeholder={placeholder}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
          />
        </div>
        <div className="modal__footer">
          <Button variant="muted" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={!name.trim()}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** "Move to…": destination folders the user can write into (never inside the moved folder) */
export function MoveModal({ item, onClose }: { item: DragItem; onClose: () => void }) {
  const { t } = useTranslation();
  const tree = useDocsTree();
  const move = useMover(tree);
  const [query, setQuery] = useState("");
  const destinations = useMemo(() => {
    const out: { id: string | null; label: string; depth: number }[] = [{ id: null, label: t("docs.all"), depth: 0 }];
    const walk = (parent: string | null, depth: number) => {
      for (const f of tree.childFolders(parent)) {
        if (item.kind === "folder" && f.id === item.id) continue; // not inside itself
        if (canEdit(tree.levelOf(f.aclEntries))) out.push({ id: f.id, label: f.name, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 1);
    return out;
  }, [tree, item, t]);
  const norm = (v: string) => v.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const visible = query ? destinations.filter((d) => norm(d.label).includes(norm(query))) : destinations;
  return (
    <Modal open onClose={onClose} width={420}>
      <div className="modal__header">
        <span className="modal__title">{t("docs.moveTo")}</span>
      </div>
      <div className="modal__body">
        <input className="input" autoFocus placeholder={t("docs.searchFolders")} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="menu-list" style={{ margin: "8px -16px 0", maxHeight: 320 }}>
          {visible.map((d) => (
            <button
              key={d.id ?? "root"}
              type="button"
              className="menu-item"
              style={{ width: "100%", border: 0, background: "none", paddingLeft: 14 + (query ? 0 : Math.max(0, d.depth - 1) * 14) }}
              onClick={() => {
                move(item, d.id);
                onClose();
              }}
            >
              <span className="menu-item__icon">
                <Icon name={d.id ? "folder" : "book"} size={14} />
              </span>
              <span className="menu-item__label">{d.label}</span>
            </button>
          ))}
          {!visible.length && <div className="menu-empty">{t("common.noResults")}</div>}
        </div>
      </div>
    </Modal>
  );
}

type ImportReport = {
  dryRun: boolean;
  folders: { created: number; reused: number };
  docs: { path: string; title: string }[];
  warnings: { path: string; message: string }[];
  failures: { path: string; message: string }[];
};

/** Import a .zip of markdown files (or one .md): dry run first, then for real */
function ImportModal({ folderId, onClose }: { folderId: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);

  const run = async (f: File, dryRun: boolean) => {
    setBusy(true);
    const form = new FormData();
    form.set("file", f);
    form.set("organizationId", org.id);
    if (folderId) form.set("folderId", folderId);
    if (dryRun) form.set("dryRun", "1");
    try {
      const res = await fetch("/api/docs/import", { method: "POST", body: form, credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? String(res.status));
      const r = (await res.json()) as ImportReport;
      setReport(r);
      if (!dryRun) toast({ title: t("docs.importDone", { count: r.docs.length }) });
    } catch (e) {
      toast({ tone: "error", title: t("docs.importFailed"), description: (e as Error).message }, 6000);
    } finally {
      setBusy(false);
    }
  };
  const pick = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setReport(null);
    void run(f, true);
  };

  return (
    <Modal open onClose={onClose} width={520}>
      <div className="modal__header">
        <span className="modal__title">{t("docs.importTitle")}</span>
      </div>
      <div className="modal__body">
        <button
          type="button"
          className="import-drop"
          data-over={over || undefined}
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            pick(e.dataTransfer.files[0]);
          }}
        >
          <Icon name="download" size={20} />
          <span>{file ? file.name : t("docs.importPick")}</span>
          <small className="faint">{t("docs.importHint")}</small>
        </button>
        <input ref={input} type="file" accept=".zip,.md,.markdown,.txt" hidden onChange={(e) => pick(e.target.files?.[0])} />
        {report && (
          <div className="import-report">
            <div className="import-report__stats">
              <span>
                <b>{report.docs.length}</b> {t("docs.importDocs")}
              </span>
              <span>
                <b>{report.folders.created}</b> {t("docs.importFoldersNew")}
              </span>
              {report.folders.reused > 0 && (
                <span>
                  <b>{report.folders.reused}</b> {t("docs.importFoldersReused")}
                </span>
              )}
            </div>
            {report.dryRun && <span className="faint">{t("docs.importDryRun")}</span>}
            {report.warnings.length > 0 && (
              <ul className="import-report__warn">
                {report.warnings.map((w) => (
                  <li key={`${w.path}:${w.message}`}>
                    {w.path} — {w.message}
                  </li>
                ))}
              </ul>
            )}
            {report.failures.length > 0 && (
              <ul className="import-report__fail">
                {report.failures.map((w) => (
                  <li key={`${w.path}:${w.message}`}>
                    {w.path} — {w.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <div className="modal__footer">
        <Button variant="muted" onClick={onClose}>
          {report && !report.dryRun ? t("common.close") : t("common.cancel")}
        </Button>
        {file && report?.dryRun && (
          <Button variant="primary" disabled={busy || report.docs.length === 0} onClick={() => void run(file, false)}>
            {t("docs.importConfirm", { count: report.docs.length })}
          </Button>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Restricted items (shared links) and trash                           */
/* ------------------------------------------------------------------ */

/** A folder/document the user can't see: kind only, and a request-access button */
export function Restricted({ nodeId, loaded }: { nodeId: string; loaded: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const zero = useZero();
  const report = useReport();
  const viewAs = useViewAs();
  const [info, setInfo] = useState<null | { kind: "doc" | "folder"; level: number; deleted: boolean } | "missing">(null);
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    if (!loaded) return;
    let alive = true;
    fetch(`/api/docs/node/${encodeURIComponent(nodeId)}?organizationId=${encodeURIComponent(org.id)}`, { credentials: "include" })
      .then(async (r) => (r.ok ? await r.json() : "missing"))
      .then((v) => alive && setInfo(v))
      .catch(() => alive && setInfo("missing"));
    return () => {
      alive = false;
    };
  }, [nodeId, org.id, loaded]);

  const body =
    !loaded || info === null ? null : info === "missing" ? (
      <>
        <div className="doc-locked__icon">
          <Icon name="doc" size={22} />
        </div>
        <h3>{t("docs.notFound")}</h3>
        <p>{t("docs.notFoundText")}</p>
      </>
    ) : info.level > 0 ? (
      <>
        <div className="doc-locked__icon">
          <Icon name={info.deleted ? "trash" : "eye"} size={22} />
        </div>
        <h3>{info.deleted ? t("docs.inTrash") : viewAs ? t("docs.hiddenForViewAs") : t("docs.loading")}</h3>
      </>
    ) : (
      <>
        <div className="doc-locked__icon">
          <Icon name="lock" size={22} />
        </div>
        <h3>{info.kind === "folder" ? t("docs.restrictedFolder") : t("docs.restrictedDoc")}</h3>
        <p>{t("docs.restrictedText")}</p>
        <div className="doc-locked__actions">
          <Button
            variant="primary"
            size="md"
            disabled={requested || !!viewAs}
            onClick={() => {
              setRequested(true);
              void report(
                zero.mutate(mutators.access.request({ organizationId: org.id, nodeId, level: "read", eventId: newId(), at: Date.now() })),
                t("docs.requestSent"),
              );
            }}
          >
            {requested ? t("docs.requestSentShort") : t("docs.requestAccess")}
          </Button>
        </div>
      </>
    );
  return (
    <DocsShell current={{ kind: "folder", id: null }}>
      <ViewHeader>
        <Link to="/$orgSlug/docs" params={{ orgSlug: org.slug }} className="crumb">
          <Icon name="book" size={14} />
          {t("nav.docs")}
        </Link>
      </ViewHeader>
      <div className="doc-locked">{body}</div>
    </DocsShell>
  );
}

export function DocsTrashPage() {
  const { t, i18n } = useTranslation();
  const zero = useZero();
  const { org } = useOrg();
  const { users, isAdmin } = useOrgMembers();
  const report = useReport();
  const [folders] = useQuery(queries.docs.trashFolders({ organizationId: org.id }));
  const [docs] = useQuery(queries.docs.trashDocs({ organizationId: org.id }));
  const tree = useDocsTree();
  const items = [
    ...folders.map((f) => ({
      kind: "folder" as const,
      id: f.id,
      name: f.name,
      deletedAt: f.deletedAt ?? 0,
      deletedBy: f.deletedBy,
      entries: f.aclEntries,
    })),
    ...docs.map((d) => ({
      kind: "doc" as const,
      id: d.id,
      name: d.title,
      deletedAt: d.deletedAt ?? 0,
      deletedBy: d.deletedBy,
      entries: d.aclEntries,
    })),
  ].sort((a, b) => b.deletedAt - a.deletedAt);

  return (
    <DocsShell current={{ kind: "trash" }}>
      <ViewHeader>
        <Link to="/$orgSlug/docs" params={{ orgSlug: org.slug }} className="crumb crumb--muted">
          <Icon name="book" size={14} />
          {t("nav.docs")}
        </Link>
        <span className="crumb-sep">
          <Icon name="chevronRight" size={14} />
        </span>
        <span className="crumb">
          <Icon name="trash" size={14} />
          {t("docs.trash")}
        </span>
      </ViewHeader>
      <div className="docs-scroll">
        {items.length === 0 ? (
          <div className="doc-locked">
            <div className="doc-locked__icon">
              <Icon name="trash" size={22} />
            </div>
            <h3>{t("docs.trashEmpty")}</h3>
            <p>{t("docs.trashText", { days: 30 })}</p>
          </div>
        ) : (
          <div className="docs-list">
            <div className="docs-list__head">
              <span>{t("docs.name")}</span>
              <span>{t("docs.deletedBy")}</span>
              <span>{t("docs.deletedAt")}</span>
              <span />
            </div>
            {items.map((it) => {
              const who = it.deletedBy ? users.get(it.deletedBy) : undefined;
              const editable = canEdit(tree.levelOf(it.entries)) && !tree.readOnly;
              return (
                <div key={it.id} className="docs-row">
                  <span className="docs-row__name">
                    <Icon name={it.kind === "folder" ? "folder" : "doc"} size={16} />
                    <span className="docs-row__title">{it.name}</span>
                  </span>
                  <span className="docs-row__meta">
                    <Avatar user={who ?? null} size={16} />
                    <span className="truncate">{who?.name ?? ""}</span>
                  </span>
                  <span className="docs-row__meta">{shortDate(it.deletedAt, i18n.language)}</span>
                  <span style={{ display: "flex", gap: 4, justifySelf: "end" }}>
                    {editable && (
                      <Tooltip content={t("docs.restore")} placement="top">
                        <Button
                          variant="muted"
                          size="sm"
                          iconOnly
                          style={{ opacity: 1 }}
                          icon={<Icon name="restore" size={14} />}
                          aria-label={t("docs.restore")}
                          onClick={() =>
                            void report(
                              zero.mutate(mutators.trash.restore({ organizationId: org.id, nodeId: it.id, at: Date.now() })),
                              t("docs.restored"),
                            )
                          }
                        />
                      </Tooltip>
                    )}
                    {isAdmin && !tree.readOnly && (
                      <Tooltip content={t("docs.deleteForever")} placement="top">
                        <Button
                          variant="muted"
                          size="sm"
                          iconOnly
                          style={{ opacity: 1 }}
                          icon={<Icon name="x" size={14} />}
                          aria-label={t("docs.deleteForever")}
                          onClick={() => {
                            if (window.confirm(t("docs.deleteForeverConfirm", { name: it.name })))
                              void report(zero.mutate(mutators.trash.purge({ organizationId: org.id, nodeId: it.id })), t("docs.deleted"));
                          }}
                        />
                      </Tooltip>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </DocsShell>
  );
}

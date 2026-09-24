import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";

/* ------------------------------------------------------------------ *
 * Menu: 12px radius, menu surface, 32px items with a
 * 6px-inset highlight, optional filter input, full keyboard support.
 * ------------------------------------------------------------------ */

export type MenuEntry =
  | {
      kind?: "item";
      id: string;
      label: string;
      icon?: ReactNode;
      /** Right-aligned hint (shortcut, count…) */
      hint?: ReactNode;
      /** Single key that selects the item when the filter is empty (e.g. "1".."7" for statuses) */
      shortcutKey?: string;
      checked?: boolean;
      disabled?: boolean;
      /** Extra words for filtering */
      keywords?: string;
      onSelect: () => void;
    }
  | { kind: "separator"; id: string }
  | { kind: "group"; id: string; label: string };

type SelectableEntry = Extract<MenuEntry, { onSelect: () => void }>;

export type Anchor = HTMLElement | { x: number; y: number };
export type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end" | "right-start";

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** State helper for a menu opened from a trigger button or at the cursor */
export function useMenu() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  return {
    open: !!anchor,
    anchor,
    openFrom: useCallback(
      (e: React.MouseEvent | HTMLElement) => setAnchor(e instanceof HTMLElement ? e : (e.currentTarget as HTMLElement)),
      [],
    ),
    openAt: useCallback((x: number, y: number) => setAnchor({ x, y }), []),
    toggleFrom: useCallback((e: React.MouseEvent) => {
      const el = e.currentTarget as HTMLElement;
      setAnchor((a) => (a ? null : el));
    }, []),
    close: useCallback(() => setAnchor(null), []),
  };
}

/** Position a floating element next to an anchor, flipping and clamping to the viewport */
export function useFloating(anchor: Anchor | null, placement: Placement, offset = 4) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: "hidden", left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const el = ref.current.getBoundingClientRect();
    const a =
      anchor instanceof HTMLElement
        ? anchor.getBoundingClientRect()
        : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
    const vw = window.innerWidth,
      vh = window.innerHeight,
      m = 8;
    let left: number, top: number, origin: string;
    if (placement === "right-start") {
      left = a.right + offset;
      top = a.top - 6;
      origin = "top left";
    } else {
      const end = placement.endsWith("end");
      left = end ? a.right - el.width : a.left;
      const wantTop = placement.startsWith("top");
      const below = a.bottom + offset,
        above = a.top - offset - el.height;
      const fitsBelow = below + el.height <= vh - m,
        fitsAbove = above >= m;
      const useTop = wantTop ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove;
      top = useTop ? above : below;
      origin = `${useTop ? "bottom" : "top"} ${end ? "right" : "left"}`;
    }
    left = Math.max(m, Math.min(left, vw - el.width - m));
    top = Math.max(m, Math.min(top, vh - el.height - m));
    setStyle({ left, top, ["--origin" as string]: origin });
  }, [anchor, placement, offset]);
  return { ref, style };
}

interface MenuProps {
  anchor: Anchor | null;
  onClose: () => void;
  items: MenuEntry[];
  filterPlaceholder?: string;
  placement?: Placement;
  width?: number;
  /** Keep the menu open after selecting (multi-select pickers like labels) */
  keepOpen?: boolean;
  emptyText?: string;
  /** Content shown above the list (e.g. a title) */
  header?: ReactNode;
}

export function Menu({
  anchor,
  onClose,
  items,
  filterPlaceholder,
  placement = "bottom-start",
  width,
  keepOpen,
  emptyText = "No results",
  header,
}: MenuProps) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(0);
  const { ref, style } = useFloating(anchor, placement);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    if (!query) return items;
    const q = norm(query);
    return items.filter(
      (i): i is SelectableEntry =>
        (i.kind ?? "item") === "item" && norm(`${(i as SelectableEntry).label} ${(i as SelectableEntry).keywords ?? ""}`).includes(q),
    );
  }, [items, query]);
  const selectable = visible.filter((i): i is SelectableEntry => (i.kind ?? "item") === "item" && !(i as SelectableEntry).disabled);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the highlighted item whenever the filter changes
  useEffect(() => {
    setFocused(0);
  }, [query]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-initialise when the menu opens (items change on every render)
  useEffect(() => {
    if (!anchor) return;
    setQuery("");
    const checked = items.findIndex((i) => (i.kind ?? "item") === "item" && (i as SelectableEntry).checked);
    const sel = items.filter((i) => (i.kind ?? "item") === "item" && !(i as SelectableEntry).disabled);
    setFocused(Math.max(0, sel.indexOf(items[checked] as SelectableEntry)));
    requestAnimationFrame(() => (inputRef.current ?? ref.current)?.focus());
  }, [anchor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Outside click closes (ignore clicks on the trigger so it can toggle itself)
  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchor instanceof HTMLElement && anchor.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [anchor, onClose, ref]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${focused}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  if (!anchor) return null;

  const select = (item: SelectableEntry) => {
    item.onSelect();
    if (!keepOpen) onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocused((f) => (f + 1) % Math.max(1, selectable.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocused((f) => (f - 1 + selectable.length) % Math.max(1, selectable.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = selectable[focused];
      if (it) select(it);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (!query && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      const hit = selectable.find((i) => i.shortcutKey === e.key);
      if (hit) {
        e.preventDefault();
        select(hit);
      }
    }
  };

  let idx = -1;
  return createPortal(
    <div ref={ref} className="popover" data-surface="menu" style={{ ...style, width }} tabIndex={-1} onKeyDown={onKeyDown} role="menu">
      {header}
      {filterPlaceholder && (
        <div className="menu-filter">
          <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={filterPlaceholder} />
        </div>
      )}
      <div className="menu-list" ref={listRef}>
        {visible.map((it) => {
          if (it.kind === "separator") return query ? null : <div key={it.id} className="menu-sep" />;
          if (it.kind === "group")
            return query ? null : (
              <div key={it.id} className="menu-group">
                {it.label}
              </div>
            );
          const s = it as SelectableEntry;
          const i = s.disabled ? -1 : ++idx;
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard navigation is handled by the menu container (arrows/Enter)
            <div
              key={s.id}
              className="menu-item"
              role="menuitem"
              tabIndex={-1}
              data-idx={i}
              data-focused={i === focused && i >= 0}
              data-disabled={s.disabled || undefined}
              onMouseMove={() => i >= 0 && i !== focused && setFocused(i)}
              onClick={() => !s.disabled && select(s)}
            >
              {s.icon !== undefined && <span className="menu-item__icon">{s.icon}</span>}
              <span className="menu-item__label">{s.label}</span>
              {s.checked !== undefined && (
                <span className="menu-item__check">{s.checked && <Icon name="check" size={14} strokeWidth={1.6} />}</span>
              )}
              {s.hint !== undefined && <span className="menu-item__hint">{s.hint}</span>}
            </div>
          );
        })}
        {selectable.length === 0 && <div className="menu-empty">{emptyText}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Generic floating panel (non-menu content) with the same surface + animation */
export function Popover({
  anchor,
  onClose,
  placement = "bottom-start",
  width,
  children,
}: {
  anchor: Anchor | null;
  onClose: () => void;
  placement?: Placement;
  width?: number;
  children: ReactNode;
}) {
  const { ref, style } = useFloating(anchor, placement);
  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || (anchor instanceof HTMLElement && anchor.contains(t))) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose, ref]);
  if (!anchor) return null;
  return createPortal(
    <div ref={ref} className="popover" data-surface="menu" style={{ ...style, width }}>
      {children}
    </div>,
    document.body,
  );
}

import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Kbd } from "./primitives";

/* Tooltip: 450ms delay, instant when another tooltip was just shown (warm-up). */
let lastHiddenAt = 0;

export function Tooltip({
  content,
  shortcut,
  children,
  placement = "top",
  disabled,
}: {
  content: ReactNode;
  shortcut?: string | string[];
  children: ReactNode;
  placement?: "top" | "bottom" | "right";
  disabled?: boolean;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const show = () => {
    if (disabled) return;
    const delay = Date.now() - lastHiddenAt < 300 ? 0 : 450;
    timer.current = window.setTimeout(() => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      if (placement === "right") setPos({ x: r.right + 6, y: r.top + r.height / 2 });
      else setPos({ x: r.left + r.width / 2, y: placement === "top" ? r.top - 6 : r.bottom + 6 });
    }, delay);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    if (pos) lastHiddenAt = Date.now();
    setPos(null);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // `translate` is independent from the `transform` used by the entry animation
  const translate = placement === "right" ? "0 -50%" : placement === "top" ? "-50% -100%" : "-50% 0";
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover wrapper only; the wrapped control stays focusable
    <span ref={anchor} style={{ display: "inline-flex" }} onMouseEnter={show} onMouseLeave={hide} onMouseDown={hide}>
      {children}
      {pos &&
        createPortal(
          <div className="tooltip" style={{ left: pos.x, top: pos.y, translate }}>
            <span>{content}</span>
            {shortcut && <Kbd keys={shortcut} />}
          </div>,
          document.body,
        )}
    </span>
  );
}

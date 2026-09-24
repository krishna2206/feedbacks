import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";

/* Dialog: overlay at .95, 12px radius, scale .98→1 in 200ms. */
export function Modal({
  open,
  onClose,
  width = 480,
  children,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  width?: number;
  children: ReactNode;
  labelledBy?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes; Escape is handled on document
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal aria-labelledby={labelledBy} style={{ width }}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

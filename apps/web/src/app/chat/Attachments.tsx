import { Button, Icon } from "@feedbacks/ui";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { fileUrl, formatSize } from "./upload";

type Attachment = {
  id: string;
  kind: string;
  name: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
};

const SINGLE_MAX_W = 360;
const SINGLE_MAX_H = 280;

/** Size of a lone image preview, keeping its ratio inside 360×280 */
function fit(w: number | null, h: number | null) {
  if (!w || !h) return { width: 240, height: 160 };
  const scale = Math.min(1, SINGLE_MAX_W / w, SINGLE_MAX_H / h);
  return { width: Math.max(48, Math.round(w * scale)), height: Math.max(48, Math.round(h * scale)) };
}

export function Attachments({ items }: { items: readonly Attachment[] }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState<Attachment | null>(null);
  if (!items.length) return null;
  const images = items.filter((a) => a.kind === "image");
  const files = items.filter((a) => a.kind !== "image");
  return (
    <div className="attachments">
      {images.length > 0 && (
        <div className={`attachments__images${images.length > 1 ? " attachments__images--grid" : ""}`}>
          {images.map((a) => {
            const size = images.length > 1 ? { width: 148, height: 148 } : fit(a.width, a.height);
            return (
              <button
                key={a.id}
                type="button"
                className="attachment-image"
                style={size}
                onClick={() => setOpen(a)}
                aria-label={t("chat.openImage")}
              >
                <img src={fileUrl(a.id, "thumb")} alt={a.name} loading="lazy" decoding="async" width={size.width} height={size.height} />
              </button>
            );
          })}
        </div>
      )}
      {files.map((a) => (
        <a key={a.id} className="attachment-file" href={fileUrl(a.id, "download")} download={a.name}>
          <span className="attachment-file__icon">
            <Icon name="doc" size={18} />
          </span>
          <span className="attachment-file__meta">
            <span className="attachment-file__name truncate">{a.name}</span>
            <span className="attachment-file__size">{formatSize(a.size, i18n.language)}</span>
          </span>
          <Icon name="download" size={16} />
        </a>
      ))}
      {open && <Lightbox item={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Lightbox({ item, onClose }: { item: Attachment; onClose: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes; Escape is handled on document
    <div className="lightbox" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lightbox__bar">
        <span className="truncate">{item.name}</span>
        <span className="spacer" />
        <a className="btn btn--muted btn--md btn--lead" href={fileUrl(item.id, "download")} download={item.name}>
          <Icon name="download" size={14} />
          {t("chat.download")}
        </a>
        <Button variant="muted" size="md" iconOnly icon={<Icon name="x" />} onClick={onClose} aria-label={t("common.close")} />
      </div>
      <img className="lightbox__img" src={fileUrl(item.id)} alt={item.name} />
    </div>,
    document.body,
  );
}

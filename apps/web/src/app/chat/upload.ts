/**
 * Uploads a file for a channel or a document. Images are measured and get a small preview generated in the
 * browser (canvas → WebP, JPEG fallback): the server stays free of native image libraries.
 */
export type UploadedAttachment = {
  id: string;
  kind: "image" | "file" | "audio";
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  thumbKey: string | null;
  width: number | null;
  height: number | null;
  createdAt: number;
};

const PREVIEWABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/avif"]);
const THUMB_EDGE = 720;

async function canvasToBlob(canvas: HTMLCanvasElement, type: string) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.82));
}

async function prepareImage(file: File): Promise<{ width: number; height: number; thumb: Blob | null } | null> {
  if (!file.type.startsWith("image/")) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    let thumb: Blob | null = null;
    // Animated GIFs keep their original; small images don't need a preview
    if (PREVIEWABLE.has(file.type) && (Math.max(width, height) > THUMB_EDGE || file.size > 300_000)) {
      const scale = Math.min(1, THUMB_EDGE / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      thumb = (await canvasToBlob(canvas, "image/webp")) ?? (await canvasToBlob(canvas, "image/jpeg"));
      if (thumb && thumb.type !== "image/webp" && thumb.type !== "image/jpeg") thumb = null;
    }
    bitmap.close();
    return { width, height, thumb };
  } catch {
    return null;
  }
}

/** Uploads for a channel (pending until the message is sent) or for a document (`{ docId }`, edit access needed) */
export async function uploadFile(file: File, organizationId: string, target: string | { docId: string }): Promise<UploadedAttachment> {
  const form = new FormData();
  form.set("file", file);
  form.set("organizationId", organizationId);
  if (typeof target === "string") form.set("channelId", target);
  else form.set("docId", target.docId);
  const img = await prepareImage(file);
  if (img) {
    form.set("width", String(img.width));
    form.set("height", String(img.height));
    if (img.thumb) form.set("thumb", new File([img.thumb], "thumb", { type: img.thumb.type }));
  }
  const res = await fetch("/api/uploads", { method: "POST", body: form, credentials: "same-origin" });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  return res.json();
}

export const fileUrl = (id: string, variant: "file" | "thumb" | "download" = "file") =>
  variant === "thumb" ? `/api/files/${id}/thumb` : variant === "download" ? `/api/files/${id}?download=1` : `/api/files/${id}`;

export function formatSize(bytes: number, locale: string) {
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toLocaleString(locale, { maximumFractionDigits: u === 0 ? 0 : 1 })} ${units[u]}`;
}

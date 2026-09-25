/**
 * Attachment storage behind a tiny interface, so self-hosters pick what fits:
 *  - `local`: files on disk (default; mount a volume in production);
 *  - `s3`: any S3-compatible service (AWS, OCI Object Storage, MinIO, R2…), signed with
 *    aws4fetch (a few KB) rather than the AWS SDK.
 * Downloads are always authorized by the API first (see routes/files.ts): local files are
 * streamed by the API, S3 objects are served through a short-lived presigned URL.
 */
import { createReadStream } from "node:fs";
import { mkdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { AwsClient } from "aws4fetch";
import { env } from "./env";

export interface StoredObject {
  body: ReadableStream<Uint8Array>;
  size: number;
}

export interface Storage {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  /** Local driver: the object itself */
  get?(key: string): Promise<StoredObject | null>;
  /** Remote drivers: a short-lived URL the browser can follow */
  signedUrl?(key: string, opts: { expiresIn: number; contentType: string; disposition: string }): Promise<string>;
  /** Idempotent: deleting a missing object succeeds. Throws when the backend fails (retried later). */
  delete(key: string): Promise<void>;
}

function localStorage(dir: string): Storage {
  const root = resolve(dir);
  const path = (key: string) => {
    const p = resolve(join(root, key));
    if (!p.startsWith(`${root}/`)) throw new Error("Invalid storage key");
    return p;
  };
  return {
    async put(key, data) {
      const p = path(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, data);
    },
    async get(key) {
      const p = path(key);
      try {
        const s = await stat(p);
        return { body: Readable.toWeb(createReadStream(p)) as ReadableStream<Uint8Array>, size: s.size };
      } catch {
        return null;
      }
    },
    async delete(key) {
      const p = path(key);
      await rm(p, { force: true });
      // Remove the upload's folder once its last file is gone (never above the storage root)
      const dir = dirname(p);
      if (dir.startsWith(`${root}/`)) await rmdir(dir).catch(() => {});
    },
  };
}

function s3Storage(cfg: { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string }): Storage {
  const aws = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: "s3", region: cfg.region });
  // Path-style URLs work with every S3-compatible provider
  const url = (key: string) => `${cfg.endpoint}/${cfg.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return {
    async put(key, data, contentType) {
      const res = await aws.fetch(url(key), { method: "PUT", body: data, headers: { "content-type": contentType } });
      if (!res.ok) throw new Error(`S3 upload failed: ${res.status} ${await res.text()}`);
    },
    async signedUrl(key, { expiresIn, contentType, disposition }) {
      const u = new URL(url(key));
      u.searchParams.set("X-Amz-Expires", String(expiresIn));
      u.searchParams.set("response-content-type", contentType);
      u.searchParams.set("response-content-disposition", disposition);
      const signed = await aws.sign(u.toString(), { method: "GET", aws: { signQuery: true } });
      return signed.url;
    },
    async delete(key) {
      const res = await aws.fetch(url(key), { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`S3 delete failed: ${res.status} ${await res.text()}`);
    },
  };
}

export const storage: Storage = env.storage.driver === "s3" ? s3Storage(env.storage) : localStorage(env.storage.dir);

/** Typed runtime configuration (see .env.example). Dev defaults are filled by scripts/lib/env.mjs. */
const required = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing environment variable ${k}`);
  return v;
};

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.API_PORT ?? 5302),
  appUrl: required("APP_URL").replace(/\/$/, ""),
  databaseUrl: required("DATABASE_URL"),
  authSecret: required("BETTER_AUTH_SECRET"),
  /** When set, the first-run setup (owner account + organization) requires this token, so a public
   *  instance can't be claimed by whoever reaches /setup first. Unused once the instance is set up. */
  setupToken: process.env.SETUP_TOKEN || null,
  google:
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET }
      : null,
  smtp: process.env.SMTP_HOST
    ? {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        user: process.env.SMTP_USER ?? "",
        pass: process.env.SMTP_PASS ?? "",
        from: process.env.SMTP_FROM ?? "Feedbacks <no-reply@localhost>",
      }
    : null,
  /** Attachments: "local" (disk, default) or "s3" (any S3-compatible storage, e.g. OCI Object Storage) */
  storage:
    process.env.STORAGE_DRIVER === "s3"
      ? {
          driver: "s3" as const,
          endpoint: required("S3_ENDPOINT").replace(/\/$/, ""),
          bucket: required("S3_BUCKET"),
          region: process.env.S3_REGION ?? "us-east-1",
          accessKeyId: required("S3_ACCESS_KEY_ID"),
          secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
          /** "redirect": browsers download from a presigned URL (endpoint must be public);
           *  "proxy": the API streams objects, so the bucket can stay private */
          downloads: process.env.S3_DOWNLOADS === "proxy" ? ("proxy" as const) : ("redirect" as const),
        }
      : { driver: "local" as const, dir: process.env.UPLOADS_DIR ?? `${process.env.DATA_DIR ?? "./data"}/uploads` },
  /** Maximum size of one uploaded file */
  uploadMaxBytes: Number(process.env.UPLOAD_MAX_MB ?? 25) * 1024 * 1024,
  /** Uploads never attached to a message are deleted after this delay */
  uploadPendingTtlHours: Number(process.env.UPLOAD_PENDING_TTL_HOURS ?? 24),
  /** Sweeper period in minutes (0 disables the in-process sweeper; the CLI still works) */
  uploadSweepIntervalMin: Number(process.env.UPLOAD_SWEEP_INTERVAL_MIN ?? 1440),
  /** Trashed folders and documents are deleted for good after this many days (by the same sweeper) */
  docsTrashDays: Number(process.env.DOCS_TRASH_DAYS ?? 30),
  /** REST API v1 rate limits, per access token and per API process */
  api: {
    rateLimitPerMin: Math.max(1, Number(process.env.API_RATE_LIMIT_PER_MIN ?? 300)),
    writeRateLimitPerMin: Math.max(1, Number(process.env.API_WRITE_RATE_LIMIT_PER_MIN ?? 60)),
  },
};

export const isDev = env.nodeEnv !== "production";

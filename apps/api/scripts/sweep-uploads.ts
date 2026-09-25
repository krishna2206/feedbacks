/**
 * Admin CLI: `pnpm uploads:sweep [--dry-run] [--ttl-hours=N]`
 * Deletes pending uploads older than the TTL and retries queued file deletions (see
 * src/uploads-sweeper.ts). In production: `node dist/sweep-uploads.js --dry-run`.
 */
import { pool } from "../src/db";
import { env } from "../src/env";
import { sweepUploads } from "../src/uploads-sweeper";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const ttlArg = args.find((a) => a.startsWith("--ttl-hours="));
const ttlHours = ttlArg ? Number(ttlArg.split("=")[1]) : env.uploadPendingTtlHours;
if (!Number.isFinite(ttlHours) || ttlHours < 0) {
  console.error("--ttl-hours must be a non-negative number");
  process.exit(1);
}

const r = await sweepUploads({ dryRun, ttlHours });
if (dryRun) {
  console.log(
    `dry run: ${r.expiredPending} pending upload(s) older than ${ttlHours}h and ${r.purgedTrash} trashed document(s)/folder(s) would be deleted; ${r.queued} file(s) queued for deletion. Nothing was changed.`,
  );
} else {
  console.log(
    `deleted ${r.expiredPending} expired pending upload(s), ${r.purgedTrash} trashed document(s)/folder(s) and ${r.deletedFiles} file(s); ${r.failedFiles} deletion(s) failed and ${r.queued} remain queued for retry.`,
  );
}
await pool.end();

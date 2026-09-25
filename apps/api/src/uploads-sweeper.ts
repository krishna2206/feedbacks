/**
 * Upload lifecycle cleanup. Deleted means deleted: when an attachment row disappears (message
 * deleted, channel or organization removed, pending upload expired) a trigger queues its files in
 * `storage_deletion`; this module deletes them from storage.
 *
 *  - `drainDeletions()` runs right after mutations (message deletions are cleaned up in seconds);
 *  - `sweepUploads()` runs at startup and every UPLOAD_SWEEP_INTERVAL_MIN: it purges trashed
 *    folders/documents older than DOCS_TRASH_DAYS, expires pending uploads older than
 *    UPLOAD_PENDING_TTL_HOURS (document images are never "pending"), then retries queued
 *    deletions that failed.
 *
 * Safe with several API instances: rows are claimed with `FOR UPDATE SKIP LOCKED`, so two
 * sweepers never process the same row, and every step is idempotent (deleting a missing file
 * succeeds). A failed storage deletion never fails the user action: the row stays queued with
 * an exponential backoff (1 min → 1 day).
 */

import { pool } from "./db";
import { env } from "./env";
import { storage } from "./storage";

const BATCH = 100;
const MAX_BATCHES = 50;

export type SweepReport = {
  expiredPending: number;
  /** Trashed folders/documents deleted for good (older than DOCS_TRASH_DAYS) */
  purgedTrash: number;
  deletedFiles: number;
  failedFiles: number;
  queued: number;
  dryRun: boolean;
};

/** Deletes up to MAX_BATCHES × BATCH queued files that are due */
async function processQueue(): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const client = await pool.connect();
    let claimed = 0;
    try {
      await client.query("begin");
      const { rows } = await client.query<{ id: number; key: string; attempts: number }>(
        `select id, key, attempts from storage_deletion
          where next_attempt_at <= now()
          order by next_attempt_at, id
          limit $1
          for update skip locked`,
        [BATCH],
      );
      claimed = rows.length;
      for (const row of rows) {
        try {
          await storage.delete(row.key);
          await client.query("delete from storage_deletion where id = $1", [row.id]);
          deleted++;
        } catch (e) {
          failed++;
          const backoffMin = Math.min(2 ** row.attempts, 1440);
          await client.query("update storage_deletion set attempts = attempts + 1, last_error = $2, next_attempt_at = $3 where id = $1", [
            row.id,
            String((e as Error).message ?? e).slice(0, 500),
            new Date(Date.now() + backoffMin * 60_000),
          ]);
          console.warn(`[uploads] could not delete ${row.key} (attempt ${row.attempts + 1}): ${(e as Error).message}`);
        }
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    // A short batch means the queue is drained (failed rows are rescheduled, not re-claimed)
    if (claimed < BATCH) break;
  }
  return { deleted, failed };
}

/** Deletes pending uploads older than the TTL (the trigger queues their files) */
const cutoff = (ttlHours: number) => new Date(Date.now() - ttlHours * 3_600_000);

async function expirePending(ttlHours: number): Promise<number> {
  let expired = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const { rowCount } = await pool.query(
      `delete from attachment where id in (
         select id from attachment
          where message_id is null and doc_id is null and created_at < $1
          order by created_at, id
          limit $2
          for update skip locked)`,
      [cutoff(ttlHours), BATCH],
    );
    expired += rowCount ?? 0;
    if ((rowCount ?? 0) < BATCH) break;
  }
  return expired;
}

/** Deletes trashed folders and documents older than the retention (attachments' files follow via the trigger) */
async function purgeTrash(days: number, dryRun: boolean): Promise<number> {
  const before = new Date(Date.now() - days * 86_400_000);
  if (dryRun) {
    const r = await pool.query<{ n: number }>(
      "select (select count(*) from doc where deleted_at < $1) + (select count(*) from doc_folder where deleted_at < $1) as n",
      [before],
    );
    return Number(r.rows[0]?.n ?? 0);
  }
  const docs = await pool.query("delete from doc where deleted_at < $1", [before]);
  const folders = await pool.query("delete from doc_folder where deleted_at < $1", [before]);
  return (docs.rowCount ?? 0) + (folders.rowCount ?? 0);
}

export async function sweepUploads({ dryRun = false, ttlHours = env.uploadPendingTtlHours } = {}): Promise<SweepReport> {
  const purgedTrash = env.docsTrashDays > 0 ? await purgeTrash(env.docsTrashDays, dryRun) : 0;
  if (dryRun) {
    const pending = await pool.query<{ n: number }>(
      "select count(*)::int as n from attachment where message_id is null and doc_id is null and created_at < $1",
      [cutoff(ttlHours)],
    );
    const queued = await pool.query<{ n: number }>("select count(*)::int as n from storage_deletion");
    return {
      expiredPending: pending.rows[0]?.n ?? 0,
      purgedTrash,
      deletedFiles: 0,
      failedFiles: 0,
      queued: queued.rows[0]?.n ?? 0,
      dryRun,
    };
  }
  const expiredPending = await expirePending(ttlHours);
  const { deleted, failed } = await processQueue();
  const queued = await pool.query<{ n: number }>("select count(*)::int as n from storage_deletion");
  return { expiredPending, purgedTrash, deletedFiles: deleted, failedFiles: failed, queued: queued.rows[0]?.n ?? 0, dryRun };
}

/* In-process scheduling ------------------------------------------------------------------ */

let draining: Promise<unknown> | null = null;
let drainAgain = false;

/** Deletes queued files now (after mutations). Coalesces concurrent calls; never throws. */
export function drainDeletions() {
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = processQueue()
    .catch((e) => console.warn(`[uploads] deletion queue: ${(e as Error).message}`))
    .finally(() => {
      draining = null;
      if (drainAgain) {
        drainAgain = false;
        drainDeletions();
      }
    });
}

export function startUploadSweeper() {
  const run = () =>
    sweepUploads()
      .then((r) => {
        if (r.expiredPending || r.purgedTrash || r.deletedFiles || r.failedFiles)
          console.log(
            `[uploads] sweep: ${r.expiredPending} expired uploads, ${r.purgedTrash} trashed documents/folders purged, ${r.deletedFiles} files deleted, ${r.failedFiles} failed`,
          );
      })
      .catch((e) => console.warn(`[uploads] sweep failed: ${(e as Error).message}`));
  // 0 disables the in-process sweeper entirely (startup run included): sweep with the CLI instead
  if (env.uploadSweepIntervalMin <= 0) return;
  setTimeout(run, 5_000).unref();
  setInterval(run, env.uploadSweepIntervalMin * 60_000).unref();
}

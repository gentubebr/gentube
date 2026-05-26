import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import {
  extractTextFromBatchMessage,
  isClaudeBatchSuccess,
  pollClaudeBatchUntilEnded,
  streamClaudeBatchResults,
} from "../integrations/claude-batch.js";
import {
  listClaudeBatchJobsPending,
  updateClaudeBatchJob,
  type ClaudeBatchJobRow,
} from "../repository-claude-batch.js";
import { CLAUDE_BATCH_POLL_INTERVAL_MS } from "../config.js";

export type ClaudeSyncSummary = {
  polled: number;
  done: number;
  failed: number;
};

async function persistBatchResults(
  batchId: string,
  projectPath: string,
  lines: Awaited<ReturnType<typeof streamClaudeBatchResults>>,
): Promise<string> {
  const dir = path.join(projectPath, "05 - Modelagem", "claude-batches");
  await fs.mkdir(dir, { recursive: true });
  const outPath = path.join(dir, `${batchId.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  await fs.writeFile(outPath, body, "utf-8");
  return outPath;
}

async function pollOneBatchGroup(
  batchId: string,
  jobs: ClaudeBatchJobRow[],
  projectPath: string,
): Promise<{ done: number; failed: number }> {
  const ended = await pollClaudeBatchUntilEnded(batchId, {
    pollIntervalMs: CLAUDE_BATCH_POLL_INTERVAL_MS,
    onStatus: (s, c) =>
      chalk.dim(
        `[claude-sync] batch ${batchId.slice(-8)} status=${s} ok=${c.succeeded} proc=${c.processing}`,
      ),
  });
  const results = await streamClaudeBatchResults(batchId);
  const resultPath = await persistBatchResults(batchId, projectPath, results);
  const byCustomId = new Map(results.map((r) => [r.custom_id, r]));

  let done = 0;
  let failed = 0;
  for (const job of jobs) {
    const line = byCustomId.get(job.custom_id);
    if (
      ended.processing_status === "ended" &&
      isClaudeBatchSuccess(
        ended.processing_status,
        ended.request_counts.errored,
        ended.request_counts.expired,
      ) &&
      line?.result?.type === "succeeded"
    ) {
      updateClaudeBatchJob(job.id, {
        status: "ended",
        outcome: "done",
        result_path: resultPath,
        error_message: null,
      });
      done += 1;
    } else {
      const err =
        line?.result?.error?.message ??
        `batch errored=${ended.request_counts.errored} expired=${ended.request_counts.expired}`;
      updateClaudeBatchJob(job.id, {
        status: ended.processing_status,
        outcome: "failed",
        result_path: resultPath,
        error_message: err,
      });
      failed += 1;
    }
  }
  return { done, failed };
}

/** Poll batches Claude pendentes registados em claude_batch_jobs. */
export async function syncClaudeBatchesOnce(input: {
  projectId?: number;
  projectPath?: string;
}): Promise<ClaudeSyncSummary> {
  const pending = listClaudeBatchJobsPending(input.projectId);
  const byBatch = new Map<string, ClaudeBatchJobRow[]>();
  for (const j of pending) {
    const list = byBatch.get(j.batch_id) ?? [];
    list.push(j);
    byBatch.set(j.batch_id, list);
  }

  let done = 0;
  let failed = 0;
  for (const [batchId, jobs] of byBatch) {
    const projectPath = input.projectPath ?? "";
    try {
      const r = await pollOneBatchGroup(batchId, jobs, projectPath);
      done += r.done;
      failed += r.failed;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const job of jobs) {
        updateClaudeBatchJob(job.id, { status: "error", outcome: "failed", error_message: msg });
        failed += 1;
      }
    }
  }
  return { polled: byBatch.size, done, failed };
}

export { extractTextFromBatchMessage };

import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { GEMINI_BATCH_POLL_INTERVAL_MS } from "../config.js";
import { applyGoogleBatchResults, pollGoogleBatchOnce, submitGoogleImageBatch } from "../integrations/gemini-batch.js";
import { runGenerateGetJson } from "../integrations/higgsfield-cli.js";
import {
  addProjectLog,
  countHfCliJobsByBlock,
  countHfCliJobsByBlockOutcome,
  countImageJobsByBlock,
  countImageJobsByBlockOutcome,
  getProjectByIdOrSlug,
  listDistinctGoogleBatchExternalIds,
  listImageJobsAwaitingGoogleBatchSubmit,
  listImageJobsPending,
  recomputeImagensVideosStage,
  updateImageJob,
  updateProjectAnyStageStatus,
  upsertMediaBlock,
} from "../repository.js";
import type { ImageJobProvider, ImageJobRow } from "../types/image-jobs.js";
import { processLocalImageBatch } from "./image-local-batch.js";

function extFromUrlOrType(url: string, contentType: string | null): string {
  if (contentType?.includes("image/png")) return ".png";
  if (contentType?.includes("image/jpeg")) return ".jpg";
  if (contentType?.includes("webp")) return ".webp";
  const clean = url.split("?")[0] ?? "";
  if (clean.endsWith(".png")) return ".png";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return ".jpg";
  if (clean.endsWith(".webp")) return ".webp";
  return ".png";
}

async function downloadToOutPath(mediaUrl: string, outPathNoExt: string): Promise<string> {
  const res = await fetch(mediaUrl);
  if (!res.ok) throw new Error(`Download midia falhou (${res.status})`);
  const arr = await res.arrayBuffer();
  const ext = extFromUrlOrType(mediaUrl, res.headers.get("content-type"));
  const finalPath = `${outPathNoExt}${ext}`;
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, Buffer.from(arr));
  return finalPath;
}

function hfTerminalFailure(status: string): boolean {
  const s = status.toLowerCase();
  return s === "failed" || s === "nsfw" || s === "cancelled" || s === "error";
}

function hfTerminalSuccess(status: string): boolean {
  return status.toLowerCase() === "completed";
}

async function processHfImageJob(row: ImageJobRow, idx: number, total: number): Promise<void> {
  const tag = chalk.dim(`[image-sync HF ${idx}/${total}]`);
  const jobId = row.external_id?.trim();
  if (!jobId) {
    updateImageJob(row.id, {
      outcome: "failed",
      status: "failed",
      error_message: "external_id HF ausente",
    });
    return;
  }
  const shortId = jobId.slice(0, 8);
  console.log(
    chalk.dim(`${tag} Consultando ${shortId}... (bloco ${row.block_number}, shot ${row.shot_id})`)
  );

  const payload = await runGenerateGetJson(jobId);
  const st = payload.status;
  const url = payload.result_url?.trim() ?? "";

  if (hfTerminalFailure(st)) {
    console.log(chalk.red(`${tag} Job ${shortId}... FALHOU (status=${st})`));
    updateImageJob(row.id, {
      status: st,
      outcome: "failed",
      error_message: `status=${st}`,
    });
    return;
  }

  if (hfTerminalSuccess(st) && url && /^https?:\/\//i.test(url)) {
    console.log(chalk.dim(`${tag} Job ${shortId}... completed, baixando...`));
    await downloadToOutPath(url, row.out_path_no_ext);
    const now = new Date().toISOString();
    updateImageJob(row.id, {
      status: st,
      outcome: "done",
      downloaded_at: now,
    });
    console.log(chalk.green(`${tag} Job ${shortId}... → ${path.basename(row.out_path_no_ext)}`));
    return;
  }

  console.log(chalk.yellow(`${tag} Job ${shortId}... pendente (status=${st})`));
  updateImageJob(row.id, { status: st });
}

function groupByBatchId(jobs: ImageJobRow[]): Map<string, ImageJobRow[]> {
  const map = new Map<string, ImageJobRow[]>();
  for (const job of jobs) {
    const key = job.batch_id ?? `job-${job.id}`;
    const list = map.get(key) ?? [];
    list.push(job);
    map.set(key, list);
  }
  return map;
}

export async function submitPendingGoogleBatches(projectId?: number): Promise<number> {
  const awaiting = listImageJobsAwaitingGoogleBatchSubmit(projectId);
  if (awaiting.length === 0) return 0;
  let submitted = 0;
  for (const [, jobs] of groupByBatchId(awaiting)) {
    await submitGoogleImageBatch(jobs);
    submitted += 1;
    console.log(chalk.cyan(`[image-sync] Google batch submetido (${jobs.length} imagens, bloco ${jobs[0]!.block_number})`));
  }
  return submitted;
}

async function pollGoogleBatchesOnce(projectId?: number): Promise<number> {
  const names = listDistinctGoogleBatchExternalIds(projectId);
  let polled = 0;
  for (const batchName of names) {
    const jobs = listImageJobsPending(projectId, "gemini", 500).filter(
      (j) => j.delivery_mode === "google_batch" && j.external_id === batchName
    );
    if (jobs.length === 0) continue;
    const { done, failed, state } = await pollGoogleBatchOnce(batchName);
    polled += 1;
    if (failed) {
      console.log(chalk.red(`[image-sync] Google batch FALHOU: ${batchName} (${state})`));
      await applyGoogleBatchResults(batchName, jobs);
      continue;
    }
    if (done) {
      console.log(chalk.green(`[image-sync] Google batch concluido: ${batchName}`));
      await applyGoogleBatchResults(batchName, jobs);
    } else {
      console.log(chalk.dim(`[image-sync] Google batch em andamento: ${batchName} (${state})`));
    }
  }
  return polled;
}

async function processPendingLocalBatches(projectId?: number): Promise<number> {
  const pending = listImageJobsPending(projectId, "gemini", 500).filter((j) => j.delivery_mode === "local_batch");
  const byBatch = groupByBatchId(pending);
  let batches = 0;
  for (const [batchId, jobs] of byBatch) {
    const unsubmitted = jobs.filter((j) => j.outcome === "pending");
    if (unsubmitted.length === 0) continue;
    batches += 1;
    console.log(chalk.cyan(`[image-sync] batch-local ${batchId.slice(0, 8)} (${unsubmitted.length} jobs)`));
    await processLocalImageBatch(unsubmitted);
  }
  return batches;
}

function resolveTotalBlocos(projectId: number): number {
  const p = getProjectByIdOrSlug(String(projectId));
  if (!p) return 1;
  const n = Number(p.total_blocos);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function finalizeBlockJobs(projectId: number, blockNumber: number, totalBlocos: number): void {
  const imgTotal = countImageJobsByBlock(projectId, blockNumber);
  const hfTotal = countHfCliJobsByBlock(projectId, blockNumber);
  const total = imgTotal + hfTotal;
  if (total === 0) return;

  const imgDone = countImageJobsByBlockOutcome(projectId, blockNumber, "done");
  const imgFailed = countImageJobsByBlockOutcome(projectId, blockNumber, "failed");
  const hfDone = countHfCliJobsByBlockOutcome(projectId, blockNumber, "done");
  const hfFailed = countHfCliJobsByBlockOutcome(projectId, blockNumber, "failed");
  const done = imgDone + hfDone;
  const failed = imgFailed + hfFailed;
  const pending = total - done - failed;

  const isThumbnail = blockNumber === 0;
  const stage = isThumbnail ? "thumbnails" : "imagens_videos";

  if (failed > 0 && pending === 0) {
    console.log(chalk.red(`[image-sync] Bloco ${blockNumber}: ${failed} job(s) falharam de ${total}`));
    if (isThumbnail) {
      updateProjectAnyStageStatus(projectId, "status_thumbnails", "error");
    } else {
      upsertMediaBlock(projectId, blockNumber, {
        renders_status: "error",
        plan_error: `Jobs de imagem/video falharam (bloco ${blockNumber}). Rode gentube image:sync.`,
        finished_at: new Date().toISOString(),
      });
      recomputeImagensVideosStage(projectId, totalBlocos);
    }
    addProjectLog(projectId, stage, "error", `Falha em job(s) do bloco ${blockNumber}`);
    return;
  }

  if (done === total) {
    console.log(chalk.green(`[image-sync] Bloco ${blockNumber}: CONCLUIDO (${done}/${total})`));
    if (isThumbnail) {
      updateProjectAnyStageStatus(projectId, "status_thumbnails", "success");
    } else {
      upsertMediaBlock(projectId, blockNumber, {
        renders_status: "success",
        renders_done_count: done,
        finished_at: new Date().toISOString(),
      });
      recomputeImagensVideosStage(projectId, totalBlocos);
    }
    addProjectLog(projectId, stage, "info", `Bloco ${blockNumber} concluido (${done} arquivos)`);
  } else {
    console.log(chalk.dim(`[image-sync] Bloco ${blockNumber}: ${done}/${total} concluidos, ${pending} pendente(s)`));
    if (!isThumbnail) {
      upsertMediaBlock(projectId, blockNumber, { renders_done_count: done });
    }
  }
}

export type ImageSyncProviderFilter = "all" | ImageJobProvider;

/**
 * Uma rodada: submete batches Google pendentes, poll HF/Gemini, processa local_batch.
 */
export async function syncImageJobsOnce(options: {
  projectId?: number;
  maxJobs?: number;
  provider?: ImageSyncProviderFilter;
}): Promise<{ processed: number; errors: string[] }> {
  const maxJobs = Math.max(1, options.maxJobs ?? 30);
  const provider = options.provider ?? "all";
  const errors: string[] = [];
  let processed = 0;
  const touched = new Set<string>();

  if (provider === "all" || provider === "gemini") {
    try {
      const submitted = await submitPendingGoogleBatches(options.projectId);
      processed += submitted;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`google batch submit: ${msg}`);
      console.log(chalk.red(`[image-sync] Falha ao submeter Google batch: ${msg}`));
    }

    try {
      const polled = await pollGoogleBatchesOnce(options.projectId);
      processed += polled;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`google batch poll: ${msg}`);
    }

    try {
      const localBatches = await processPendingLocalBatches(options.projectId);
      processed += localBatches;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`local batch: ${msg}`);
    }
  }

  if (provider === "all" || provider === "higgsfield") {
    const hfRows = listImageJobsPending(options.projectId, "higgsfield", maxJobs).filter(
      (j) => j.delivery_mode === "sync" && j.external_id?.trim()
    );
    if (hfRows.length > 0) {
      console.log(chalk.cyan(`[image-sync] ${hfRows.length} job(s) HF (image_jobs)...`));
    }
    for (let idx = 0; idx < hfRows.length; idx++) {
      const row = hfRows[idx]!;
      try {
        await processHfImageJob(row, idx + 1, hfRows.length);
        processed += 1;
        touched.add(`${row.project_id}:${row.block_number}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`hf image ${row.external_id}: ${msg}`);
        updateImageJob(row.id, { outcome: "failed", status: "failed", error_message: msg });
        touched.add(`${row.project_id}:${row.block_number}`);
      }
    }
  }

  for (const key of touched) {
    const [pid, bn] = key.split(":");
    finalizeBlockJobs(Number(pid), Number(bn), resolveTotalBlocos(Number(pid)));
  }

  if (touched.size === 0 && options.projectId !== undefined) {
    const blocks = new Set<number>();
    for (const row of listImageJobsPending(options.projectId, undefined, 500)) {
      blocks.add(row.block_number);
    }
    for (const bn of blocks) {
      finalizeBlockJobs(options.projectId, bn, resolveTotalBlocos(options.projectId));
    }
  }

  return { processed, errors };
}

export function countAllImageJobsPending(projectId?: number): number {
  return listImageJobsPending(projectId, undefined, 10_000).length;
}

/** Processa todos os batch-local pendentes do projeto (apos --enqueue-only). */
export async function flushPendingLocalBatchesForProject(projectId: number): Promise<number> {
  const pending = listImageJobsPending(projectId, "gemini", 10_000).filter(
    (j) => j.delivery_mode === "local_batch" && j.outcome === "pending"
  );
  if (pending.length === 0) return 0;
  let batches = 0;
  for (const [, jobs] of groupByBatchId(pending)) {
    await processLocalImageBatch(jobs);
    batches += 1;
  }
  return batches;
}

export { GEMINI_BATCH_POLL_INTERVAL_MS };

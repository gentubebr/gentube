import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { runGenerateGetJson } from "../integrations/higgsfield-cli.js";
import {
  addProjectLog,
  countHfCliJobsByBlock,
  countHfCliJobsByBlockOutcome,
  getProjectByIdOrSlug,
  listHfCliJobsPending,
  recomputeImagensVideosStage,
  updateHfCliJobPoll,
  updateProjectAnyStageStatus,
  upsertMediaBlock,
} from "../repository.js";
import type { HfCliJobRow } from "../repository.js";

function extFromUrlOrType(url: string, contentType: string | null, fallback: ".png" | ".mp4"): string {
  if (contentType?.includes("image/png")) return ".png";
  if (contentType?.includes("image/jpeg")) return ".jpg";
  if (contentType?.includes("video/mp4")) return ".mp4";
  const clean = url.split("?")[0] ?? "";
  if (clean.endsWith(".png")) return ".png";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return ".jpg";
  if (clean.endsWith(".mp4")) return ".mp4";
  return fallback;
}

async function downloadToOutPath(mediaUrl: string, outPathNoExt: string, fallbackExt: ".png" | ".mp4"): Promise<string> {
  const res = await fetch(mediaUrl);
  if (!res.ok) throw new Error(`Download midia falhou (${res.status})`);
  const arr = await res.arrayBuffer();
  const ext = extFromUrlOrType(mediaUrl, res.headers.get("content-type"), fallbackExt);
  const finalPath = `${outPathNoExt}${ext}`;
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, Buffer.from(arr));
  return finalPath;
}

function isTerminalFailure(status: string): boolean {
  const s = status.toLowerCase();
  return s === "failed" || s === "nsfw" || s === "cancelled" || s === "error";
}

function isTerminalSuccess(status: string): boolean {
  return status.toLowerCase() === "completed";
}

async function processOneJob(row: HfCliJobRow, idx: number, total: number): Promise<void> {
  const tag = chalk.dim(`[sync ${idx}/${total}]`);
  const shortId = row.hf_job_id.slice(0, 8);
  console.log(chalk.dim(`${tag} Consultando job ${shortId}... (bloco ${row.block_number}, ${row.asset_type}, shot ${row.shot_id})`));

  const payload = await runGenerateGetJson(row.hf_job_id);
  const st = payload.status;
  const url = payload.result_url?.trim() ?? "";

  if (isTerminalFailure(st)) {
    console.log(chalk.red(`${tag} Job ${shortId}... FALHOU (status=${st})`));
    updateHfCliJobPoll(row.id, {
      hf_status: st,
      outcome: "failed",
      error_message: `status=${st}`,
    });
    return;
  }

  if (isTerminalSuccess(st) && url && /^https?:\/\//i.test(url)) {
    const ext: ".png" | ".mp4" = row.asset_type === "video" ? ".mp4" : ".png";
    console.log(chalk.dim(`${tag} Job ${shortId}... completed, baixando ${row.asset_type}...`));
    await downloadToOutPath(url, row.out_path_no_ext, ext);
    const now = new Date().toISOString();
    updateHfCliJobPoll(row.id, {
      hf_status: st,
      result_url: url,
      outcome: "done",
      downloaded_at: now,
    });
    const baseName = path.basename(row.out_path_no_ext) + ext;
    console.log(chalk.green(`${tag} Job ${shortId}... baixado → ${baseName}`));
    return;
  }

  console.log(chalk.yellow(`${tag} Job ${shortId}... ainda em andamento (status=${st})`));
  updateHfCliJobPoll(row.id, { hf_status: st, result_url: url || null });
}

function resolveTotalBlocos(projectId: number): number {
  const p = getProjectByIdOrSlug(String(projectId));
  if (!p) return 1;
  const n = Number(p.total_blocos);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function finalizeBlockIfDone(projectId: number, blockNumber: number, totalBlocos: number): void {
  const total = countHfCliJobsByBlock(projectId, blockNumber);
  if (total === 0) return;
  const done = countHfCliJobsByBlockOutcome(projectId, blockNumber, "done");
  const failed = countHfCliJobsByBlockOutcome(projectId, blockNumber, "failed");
  const pending = total - done - failed;

  const isThumbnail = blockNumber === 0;
  const stage = isThumbnail ? "thumbnails" : "imagens_videos";

  if (failed > 0 && pending === 0) {
    console.log(chalk.red(`[sync] Bloco ${blockNumber}: ${failed} job(s) falharam de ${total} total`));
    if (isThumbnail) {
      updateProjectAnyStageStatus(projectId, "status_thumbnails", "error");
    } else {
      upsertMediaBlock(projectId, blockNumber, {
        renders_status: "error",
        plan_error: `Um ou mais jobs Higgsfield falharam (bloco ${blockNumber}). Rode gentube higgsfield:sync ou verifique hf_cli_jobs.`,
        finished_at: new Date().toISOString(),
      });
      recomputeImagensVideosStage(projectId, totalBlocos);
    }
    addProjectLog(projectId, stage, "error", `HF async: falha em job(s) do bloco ${blockNumber}`);
    return;
  }
  if (done === total) {
    console.log(chalk.green(`[sync] Bloco ${blockNumber}: CONCLUIDO (${done}/${total} arquivos baixados)`));
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
    addProjectLog(projectId, stage, "info", `HF async: bloco ${blockNumber} concluido (${done} arquivos)`);
  } else {
    console.log(chalk.dim(`[sync] Bloco ${blockNumber}: ${done}/${total} concluidos, ${pending} pendente(s)`));
    if (!isThumbnail) {
      upsertMediaBlock(projectId, blockNumber, { renders_done_count: done });
    }
  }
}

/**
 * Uma rodada de poll/download para jobs `hf_cli_jobs` pendentes (GENTUBE_HF_ASYNC).
 */
export async function syncHiggsfieldCliJobsOnce(options: {
  projectId?: number;
  maxJobs: number;
}): Promise<{ processed: number; errors: string[] }> {
  const rows = listHfCliJobsPending(options.projectId, options.maxJobs);
  if (rows.length === 0) {
    console.log(chalk.dim("[sync] Nenhum job pendente encontrado."));
  } else {
    console.log(chalk.cyan(`[sync] ${rows.length} job(s) pendentes para processar...`));
  }
  const errors: string[] = [];
  let processed = 0;
  const touched = new Set<string>();

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx]!;
    try {
      await processOneJob(row, idx + 1, rows.length);
      processed += 1;
      touched.add(`${row.project_id}:${row.block_number}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(chalk.red(`[sync] Erro no job ${row.hf_job_id.slice(0, 8)}...: ${msg}`));
      errors.push(`job ${row.hf_job_id}: ${msg}`);
      updateHfCliJobPoll(row.id, { outcome: "failed", error_message: msg });
      touched.add(`${row.project_id}:${row.block_number}`);
    }
  }

  for (const key of touched) {
    const [pid, bn] = key.split(":");
    const projectId = Number(pid);
    const blockNumber = Number(bn);
    finalizeBlockIfDone(projectId, blockNumber, resolveTotalBlocos(projectId));
  }

  return { processed, errors };
}

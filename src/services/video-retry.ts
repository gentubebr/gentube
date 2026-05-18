import path from "node:path";
import chalk from "chalk";
import {
  addProjectLog,
  countHfCliJobsByBlockOutcome,
  getMediaBlock,
  getProjectByIdOrSlug,
  listHfCliJobsByProject,
  recomputeImagensVideosStage,
  updateHfCliJobPoll,
  upsertMediaBlock,
} from "../repository.js";
import {
  buildVideoProjectStatus,
  listRetryableMissingVideos,
  type MissingVideoShot,
} from "./video-project-status.js";
import { loadSceneVideoMetaFromProject, renderVideoWithFallback } from "./video-generation.js";

export type VideoRetryResult = {
  attempted: number;
  succeeded: number;
  failed: Array<{ shot: MissingVideoShot; error: string }>;
};

async function refreshBlockAfterRetry(projectId: number, blockNumber: number, totalBlocos: number): Promise<void> {
  const pending = countHfCliJobsByBlockOutcome(projectId, blockNumber, "pending");
  const failed = countHfCliJobsByBlockOutcome(projectId, blockNumber, "failed");
  const done = countHfCliJobsByBlockOutcome(projectId, blockNumber, "done");
  const row = getMediaBlock(projectId, blockNumber);

  if (failed > 0 && pending === 0) {
    upsertMediaBlock(projectId, blockNumber, {
      renders_status: "error",
      plan_error: `${failed} job(s) HF ainda falharam apos retry. Rode: gentube video:status --project ${projectId}`,
    });
  } else if (pending === 0 && (done > 0 || (row?.renders_done_count ?? 0) > 0)) {
    upsertMediaBlock(projectId, blockNumber, {
      renders_status: failed > 0 ? "error" : "success",
      plan_error: failed > 0 ? `${failed} falha(s) restante(s)` : null,
      renders_done_count: row?.renders_done_count ?? 0,
      finished_at: new Date().toISOString(),
    });
  }
  recomputeImagensVideosStage(projectId, totalBlocos);
}

async function retryOneShot(
  projectPath: string,
  shot: MissingVideoShot
): Promise<{ provider: string; localPath: string }> {
  const meta = await loadSceneVideoMetaFromProject(projectPath, shot.blockNumber, shot.shotId);
  if (!meta) {
    throw new Error(`Metadados ausentes em block${String(shot.blockNumber).padStart(2, "0")}.assets.json`);
  }
  const pad = String(shot.blockNumber).padStart(2, "0");
  const outPathNoExt = path.join(
    projectPath,
    "03 - Imagens e Videos",
    "renders",
    `block${pad}`,
    shot.shotId
  );

  const skipHf =
    shot.reason === "no_file" ||
    shot.reason === "hf_failed_credits" ||
    shot.reason === "hf_failed_other" ||
    !meta.referenceImagePath;
  return renderVideoWithFallback({
    prompt: meta.prompt,
    outPathNoExt,
    referenceImageUrl: meta.referenceImagePath,
    magnificKeywords: meta.searchKeywords,
    skipHiggsfield: skipHf,
  });
}

export async function retryMissingVideos(options: {
  projectIdOrSlug: string;
  blockNumber?: number;
  creditsOnly?: boolean;
  dryRun?: boolean;
}): Promise<VideoRetryResult> {
  const project = getProjectByIdOrSlug(options.projectIdOrSlug.trim());
  if (!project) throw new Error("Projeto nao encontrado");
  const projectId = Number(project.id);
  const projectPath = String(project.project_path);
  const totalBlocos = Number(project.total_blocos) || 1;

  const report = await buildVideoProjectStatus(projectId, projectPath);
  const targets = listRetryableMissingVideos(report, {
    creditsOnly: options.creditsOnly,
    blockNumber: options.blockNumber,
  });

  const result: VideoRetryResult = { attempted: 0, succeeded: 0, failed: [] };

  if (targets.length === 0) {
    return result;
  }

  const touchedBlocks = new Set<number>();

  for (const shot of targets) {
    result.attempted += 1;
    const label = `bloco ${shot.blockNumber} ${shot.shotId}`;
    if (options.dryRun) {
      console.log(chalk.dim(`[dry-run] Retentaria ${label} (${shot.reason})`));
      continue;
    }

    console.log(chalk.cyan(`Retentando ${label} (${shot.reason})...`));
    try {
      const out = await retryOneShot(projectPath, shot);
      result.succeeded += 1;
      touchedBlocks.add(shot.blockNumber);

      const job = listHfCliJobsByProject(projectId, {
        blockNumber: shot.blockNumber,
        assetType: "video",
      }).find((j) => j.shot_id === shot.shotId);
      if (job) {
        updateHfCliJobPoll(job.id, {
          outcome: "done",
          error_message: `retry_ok; provider=${out.provider}`,
          downloaded_at: new Date().toISOString(),
        });
      }

      const row = getMediaBlock(projectId, shot.blockNumber);
      upsertMediaBlock(projectId, shot.blockNumber, {
        renders_done_count: (row?.renders_done_count ?? 0) + 1,
      });

      console.log(chalk.green(`  OK ${label} → ${out.provider} (${path.basename(out.localPath)})`));
      addProjectLog(projectId, "imagens_videos", "info", `Video retry OK bloco ${shot.blockNumber} ${shot.shotId}`, {
        provider: out.provider,
        reason: shot.reason,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failed.push({ shot, error: msg });
      console.log(chalk.red(`  FALHOU ${label}: ${msg}`));
      addProjectLog(projectId, "imagens_videos", "error", `Video retry falhou bloco ${shot.blockNumber} ${shot.shotId}`, {
        error: msg,
        reason: shot.reason,
      });
    }
  }

  if (!options.dryRun) {
    for (const bn of touchedBlocks) {
      await refreshBlockAfterRetry(projectId, bn, totalBlocos);
    }
  }

  return result;
}

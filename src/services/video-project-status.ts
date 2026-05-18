import fs from "node:fs/promises";
import path from "node:path";
import {
  countHfCliJobsByBlockOutcome,
  countHfCliJobsByProjectOutcome,
  listHfCliJobsByProject,
  listMediaBlocksDetailed,
  type HfCliJobRow,
  type MediaBlockDetailRow,
} from "../repository.js";
import { isHfCreditsOrQuotaError } from "../utils/provider-errors.js";
import { isBlockScenesPlanV2 } from "../utils/scenes-plan.js";
import { sceneRenderOutputExists } from "../utils/media-output.js";

export type MissingVideoShot = {
  blockNumber: number;
  shotId: string;
  reason: "no_file" | "hf_failed_credits" | "hf_failed_other" | "hf_pending";
  hfJobId?: string;
  errorMessage?: string;
};

export type VideoProjectStatusReport = {
  projectId: number;
  projectPath: string;
  lastActivityBlock: MediaBlockDetailRow | null;
  lastSuccessBlock: MediaBlockDetailRow | null;
  hfPending: number;
  hfFailedCredits: number;
  hfFailedOther: number;
  missingVideos: MissingVideoShot[];
  blocks: MediaBlockDetailRow[];
};

function isCreditRelatedFailure(row: HfCliJobRow): boolean {
  const msg = [row.error_message, row.hf_status].filter(Boolean).join(" ");
  return isHfCreditsOrQuotaError(msg);
}

export async function buildVideoProjectStatus(projectId: number, projectPath: string): Promise<VideoProjectStatusReport> {
  const blocks = listMediaBlocksDetailed(projectId);
  const withActivity = blocks.filter(
    (b) =>
      b.block_number > 0 &&
      (b.renders_status !== "pending" || b.renders_done_count > 0 || b.renders_total_count > 0)
  );
  const lastActivityBlock = withActivity.length > 0 ? withActivity[withActivity.length - 1]! : null;
  const successBlocks = blocks.filter((b) => b.block_number > 0 && b.renders_status === "success");
  const lastSuccessBlock = successBlocks.length > 0 ? successBlocks[successBlocks.length - 1]! : null;

  const hfPending = countHfCliJobsByProjectOutcome(projectId, "pending", "video");
  const allFailed = listHfCliJobsByProject(projectId, { outcome: "failed", assetType: "video" });
  const hfFailedCredits = allFailed.filter(isCreditRelatedFailure).length;
  const hfFailedOther = allFailed.length - hfFailedCredits;

  const missingVideos: MissingVideoShot[] = [];

  for (const block of blocks) {
    if (block.block_number <= 0) continue;
    const pad = String(block.block_number).padStart(2, "0");
    const jsonPath =
      block.assets_json_path ??
      path.join(projectPath, "03 - Imagens e Videos", `block${pad}.assets.json`);
    const rendersDir = path.join(projectPath, "03 - Imagens e Videos", "renders", `block${pad}`);

    let plan: unknown;
    try {
      plan = JSON.parse(await fs.readFile(jsonPath, "utf-8"));
    } catch {
      continue;
    }
    if (!isBlockScenesPlanV2(plan)) continue;

    const blockJobs = listHfCliJobsByProject(projectId, {
      blockNumber: block.block_number,
      assetType: "video",
    });
    const jobByShot = new Map(blockJobs.map((j) => [j.shot_id, j]));

    for (const scene of plan.scenes) {
      if (scene.visual.type !== "video") continue;
      if (scene.visual.source !== "ai_generated") continue;

      const hasFile = await sceneRenderOutputExists(rendersDir, scene.id, "video");
      if (hasFile) continue;

      const job = jobByShot.get(scene.id);
      if (job?.outcome === "pending") {
        missingVideos.push({
          blockNumber: block.block_number,
          shotId: scene.id,
          reason: "hf_pending",
          hfJobId: job.hf_job_id,
        });
        continue;
      }
      if (job?.outcome === "failed") {
        missingVideos.push({
          blockNumber: block.block_number,
          shotId: scene.id,
          reason: isCreditRelatedFailure(job) ? "hf_failed_credits" : "hf_failed_other",
          hfJobId: job.hf_job_id,
          errorMessage: job.error_message ?? undefined,
        });
        continue;
      }
      missingVideos.push({
        blockNumber: block.block_number,
        shotId: scene.id,
        reason: "no_file",
      });
    }
  }

  return {
    projectId,
    projectPath,
    lastActivityBlock,
    lastSuccessBlock,
    hfPending,
    hfFailedCredits,
    hfFailedOther,
    missingVideos,
    blocks: blocks.filter((b) => b.block_number > 0),
  };
}

export function listRetryableMissingVideos(
  report: VideoProjectStatusReport,
  options: { creditsOnly?: boolean; blockNumber?: number }
): MissingVideoShot[] {
  const creditsOnly = options.creditsOnly !== false;
  return report.missingVideos.filter((m) => {
    if (options.blockNumber !== undefined && m.blockNumber !== options.blockNumber) return false;
    if (m.reason === "hf_pending") return false;
    if (creditsOnly) {
      return m.reason === "hf_failed_credits" || m.reason === "no_file";
    }
    return m.reason === "hf_failed_credits" || m.reason === "hf_failed_other" || m.reason === "no_file";
  });
}

export function formatBlockLine(projectId: number, b: MediaBlockDetailRow): string {
  const jobs =
    b.renders_total_count > 0
      ? ` (${b.renders_done_count}/${b.renders_total_count} renders`
      : "";
  const hf =
    b.block_number > 0
      ? `, HF: ${countHfCliJobsByBlockOutcome(projectId, b.block_number, "done")} ok / ${countHfCliJobsByBlockOutcome(projectId, b.block_number, "failed")} falha / ${countHfCliJobsByBlockOutcome(projectId, b.block_number, "pending")} pend.`
      : "";
  const suffix = jobs ? `${jobs}${hf})` : hf ? ` (${hf.trim().slice(2)})` : "";
  return `  bloco ${String(b.block_number).padStart(2, "0")}: plan=${b.plan_status}, renders=${b.renders_status}${suffix}`;
}

import path from "node:path";
import chalk from "chalk";
import {
  higgsfieldDisabled,
  resolveImageDelivery,
  resolveVisualModality,
  roteiroStageBatchEnabled,
} from "../config.js";
import { classifyClaudeError, QUOTA_RETRY_DELAY_MS } from "../utils/provider-errors.js";
import { addProjectLog, getMediaBlock, getNarrationBlock, listScriptBlocks } from "../repository.js";
import {
  countImageJobsFailed,
  createPipelineRun,
  deleteFailedImageJobsForBlock,
  finishPipelineRunStep,
  getLatestPipelineRun,
  getPipelineRun,
  insertPipelineRunStep,
  listBlockNumbersWithFailedImageJobs,
  listPipelineRunSteps,
  startPipelineRunStep,
  updatePipelineRun,
  writePipelineRunReport,
  type PipelineRunStatus,
  type PipelineStepStatus,
} from "../repository-pipeline.js";
import type { ImagensVideosOptions } from "./pipeline.js";
import {
  runImagensVideosBlock,
  runNarracaoBlock,
  runQuotizadorBlock,
  runRoteiroBlock,
  runRoteiroBatchStage,
  runQualityGateBlock,
  runThumbnails,
} from "./pipeline.js";
import { stoicAllowAiMixEnabled, stoicOverlayModeEnabled } from "../utils/stoic-overlay-mode.js";
import { syncImageJobsOnce, countAllImageJobsPending } from "./image-sync.js";
import { runMontagem } from "./montagem.js";
import type { MontagemPhase } from "../config/montagem.js";
import type { Step3Limits } from "../types/step3-limits.js";
import { parseIntervalMs } from "../utils/parse-interval.js";

export type PipelineProfile = "wojak-images-only" | "stoic-patrol-stock";

export type PipelineStage =
  | "roteiro"
  | "quality_gate"
  | "quotizador"
  | "imagens"
  | "image_sync"
  | "imagens_retry"
  | "narracao"
  | "montagem"
  | "thumbnails";

const STAGE_ORDER: PipelineStage[] = [
  "roteiro",
  "quality_gate",
  "quotizador",
  "imagens",
  "image_sync",
  "imagens_retry",
  "narracao",
  "montagem",
  "thumbnails",
];

export type PipelineOrchestratorOptions = {
  profile: PipelineProfile;
  voiceId: string;
  continueOnError: boolean;
  maxRetriesPerBlock: number;
  avatarPath?: string;
  promptMatrix?: string;
  promptCanalVoice?: string;
  skipThumbnails?: boolean;
  fromStage?: PipelineStage;
  /** Para apos esta etapa (ex. imagens_retry = so roteiro + plano + batch, sem narracao/montagem). */
  throughStage?: PipelineStage;
  imageSyncIntervalMs: number;
  imageSyncMaxRounds: number;
  limits: Step3Limits;
  imagensOpts: ImagensVideosOptions;
  montagemPhase?: MontagemPhase;
  montagemForce?: boolean;
  thumbnailReferenceUrl?: string;
  thumbnailCount?: number;
  thumbnailPrompt?: string;
};

type ProjectRow = Record<string, unknown>;

type RunSummary = {
  runId: number;
  profile: string;
  projectId: number;
  slug: string;
  status: PipelineRunStatus;
  continueOnError: boolean;
  startedAt: string;
  finishedAt: string;
  stages: Record<string, { ok: number; error: number; skipped: number }>;
  blockErrors: Array<{ stage: string; blockNumber: number; error: string; attempts: number }>;
  imageJobs: { pending: number; failed: number };
  hints: string[];
};

function blockTag(n: number, total: number): string {
  return chalk.cyan(`[pipeline bloco ${n}/${total}]`);
}

function stageIndex(stage: PipelineStage): number {
  return STAGE_ORDER.indexOf(stage);
}

function shouldRunStage(
  fromStage: PipelineStage | undefined,
  stage: PipelineStage,
  throughStage?: PipelineStage,
): boolean {
  if (throughStage && stageIndex(stage) > stageIndex(throughStage)) return false;
  if (!fromStage) return true;
  return stageIndex(stage) >= stageIndex(fromStage);
}

function resolveWojakImagesOnlyLimits(limits: Step3Limits): Step3Limits {
  return {
    maxVideosBlock1: 0,
    maxVideosOtherBlocks: 0,
    maxImagesBlock1: limits.maxImagesBlock1,
    maxImagesOtherBlocks: limits.maxImagesOtherBlocks,
  };
}

function resolvePipelineLimits(profile: PipelineProfile, limits: Step3Limits): Step3Limits {
  if (profile === "wojak-images-only") return resolveWojakImagesOnlyLimits(limits);
  return limits;
}

export function assertPipelineProfileEnv(profile: PipelineProfile): string[] {
  const warnings: string[] = [];
  if (profile === "wojak-images-only") {
    if (resolveVisualModality() !== "wojak") {
      warnings.push("GENTUBE_VISUAL_MODALITY nao e wojak — defina wojak no .env para este perfil");
    }
    if (!["1", "true", "yes"].includes(String(process.env.GENTUBE_SCENE_PLAN_V2 ?? "").toLowerCase())) {
      warnings.push("GENTUBE_SCENE_PLAN_V2 recomendado (=1) para modo cenas");
    }
  }
  if (profile === "stoic-patrol-stock") {
    if (resolveVisualModality() !== "stoic_patrol") {
      warnings.push("GENTUBE_VISUAL_MODALITY nao e stoic_patrol — defina stoic_patrol no .env");
    }
    if (!["1", "true", "yes"].includes(String(process.env.GENTUBE_SCENE_PLAN_V2 ?? "").toLowerCase())) {
      warnings.push("GENTUBE_SCENE_PLAN_V2 recomendado (=1) para Stoic Patrol");
    }
    if (["1", "true", "yes"].includes(String(process.env.GENTUBE_HF_ASYNC ?? "").toLowerCase())) {
      warnings.push("GENTUBE_HF_ASYNC=1 nao recomendado para stoic_patrol (stock Magnific)");
    }
    if (!stoicOverlayModeEnabled()) {
      warnings.push(
        "Projetos novos Stoic overlay: GENTUBE_STOIC_OVERLAY_MODE=1 + GENTUBE_TTS_WITH_TIMESTAMPS=1",
      );
    }
    if (stoicAllowAiMixEnabled() && resolveImageDelivery() !== "google_batch") {
      warnings.push(
        "GENTUBE_STOIC_ALLOW_AI_MIX: cenas ai_generated exigem GENTUBE_IMAGE_DELIVERY=google_batch (ou local_batch)",
      );
    }
    if (higgsfieldDisabled()) {
      warnings.push("GENTUBE_DISABLE_HIGGSFIELD=1: imagens IA via Gemini; stoic_patrol usa apenas imagens IA");
    }
  }
  return warnings;
}

type RecordStepResult = { status: PipelineStepStatus; caughtError?: unknown };

async function recordStep(
  runId: number,
  stage: string,
  blockNumber: number | undefined,
  fn: () => Promise<void>,
  opts: { continueOnError: boolean; attempt?: number },
): Promise<RecordStepResult> {
  const stepId = insertPipelineRunStep({
    runId,
    stage,
    blockNumber,
    status: "pending",
    attempt: opts.attempt ?? 1,
  });
  startPipelineRunStep(stepId);
  try {
    await fn();
    finishPipelineRunStep(stepId, "success");
    return { status: "success" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    finishPipelineRunStep(stepId, "error", msg);
    if (!opts.continueOnError) throw e;
    return { status: "error", caughtError: e };
  }
}

export async function runFullPipeline(
  project: ProjectRow,
  options: PipelineOrchestratorOptions,
): Promise<RunSummary> {
  const projectId = Number(project.id);
  const totalBlocos = Number(project.total_blocos);
  const projectPath = path.resolve(String(project.project_path));
  const slug = String(project.slug);
  const limits = resolvePipelineLimits(options.profile, options.limits);

  if (!options.imagensOpts.scenePlanV2) {
    throw new Error(
      `run-pipeline (${options.profile}) exige plano por cenas: --scene-plan-v2 ou GENTUBE_SCENE_PLAN_V2=1`,
    );
  }

  const envWarnings = assertPipelineProfileEnv(options.profile);
  for (const w of envWarnings) {
    console.log(chalk.yellow(`[pipeline] ${w}`));
  }

  const runId = createPipelineRun({
    projectId,
    profile: options.profile,
    continueOnError: options.continueOnError,
  });

  const startedAt = new Date().toISOString();
  const blockErrors: RunSummary["blockErrors"] = [];
  const stageCounts: RunSummary["stages"] = {};
  const hints: string[] = [];

  const bumpStage = (stage: string, status: PipelineStepStatus) => {
    if (!stageCounts[stage]) stageCounts[stage] = { ok: 0, error: 0, skipped: 0 };
    if (status === "success") stageCounts[stage].ok += 1;
    else if (status === "error") stageCounts[stage].error += 1;
    else if (status === "skipped") stageCounts[stage].skipped += 1;
  };

  addProjectLog(projectId, "pipeline", "info", `Inicio run-pipeline #${runId}`, {
    profile: options.profile,
    continueOnError: options.continueOnError,
    fromStage: options.fromStage ?? null,
  });

  console.log(
    chalk.bold.cyan(
      `\n=== GenTube run-pipeline #${runId} ===\n` +
        `Projeto: ${slug} (id ${projectId}) · perfil ${options.profile} · ${totalBlocos} blocos\n` +
        `Rastreio: SQLite pipeline_runs / pipeline_run_steps + project_logs (stage=pipeline)\n` +
        `Relatorio: 05 - Modelagem/pipeline-run-${runId}.json\n`,
    ),
  );

  const roteiroOpts = {
    promptMatrix: options.promptMatrix?.trim() || undefined,
    promptCanalVoice: options.promptCanalVoice?.trim() || undefined,
  };

  // --- Roteiro ---
  if (shouldRunStage(options.fromStage, "roteiro", options.throughStage)) {
    updatePipelineRun(runId, { currentStage: "roteiro" });
    console.log(chalk.bold("\n--- Etapa: roteiro ---\n"));

    if (roteiroStageBatchEnabled()) {
      // Modo batch por etapa: submete todos os blocos pendentes em 1 unico Message Batch.
      // Tradeoff: sem contexto cruzado entre blocos; economiza latencia de API.
      const stepId = insertPipelineRunStep({ runId, stage: "roteiro", blockNumber: undefined, status: "pending" });
      startPipelineRunStep(stepId);
      try {
        await runRoteiroBatchStage(project, roteiroOpts);
        finishPipelineRunStep(stepId, "success");
        bumpStage("roteiro", "success");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        finishPipelineRunStep(stepId, "error", msg);
        bumpStage("roteiro", "error");
        blockErrors.push({ stage: "roteiro", blockNumber: 0, error: msg, attempts: 1 });
        if (!options.continueOnError) throw e;
      }
    } else {
      // Modo sequencial por bloco (default): 1 batch por bloco, contexto cruzado disponivel.
      for (let bn = 1; bn <= totalBlocos; bn += 1) {
        const scriptRow = listScriptBlocks(projectId).find((b) => b.block_number === bn);
        if (scriptRow?.status === "success" && options.fromStage !== "roteiro") {
          const stepId = insertPipelineRunStep({ runId, stage: "roteiro", blockNumber: bn, status: "skipped" });
          finishPipelineRunStep(stepId, "skipped", undefined, { reason: "script_blocks ja success" });
          bumpStage("roteiro", "skipped");
          console.log(chalk.dim(`${blockTag(bn, totalBlocos)} Roteiro ja OK, pulando`));
          continue;
        }
        let lastErr: string | undefined;
        let finalStatus: PipelineStepStatus = "error";
        let attemptsUsed = 0;
        for (let attempt = 1; attempt <= options.maxRetriesPerBlock; attempt += 1) {
          attemptsUsed = attempt;
          const { status, caughtError } = await recordStep(
            runId,
            "roteiro",
            bn,
            () => runRoteiroBlock(project, bn, roteiroOpts),
            { continueOnError: true, attempt },
          );
          finalStatus = status;
          if (finalStatus === "success") break;
          const kind = classifyClaudeError(caughtError);
          if (kind === "permanent") {
            lastErr = `erro permanente (sem retry): ${caughtError instanceof Error ? caughtError.message : String(caughtError)}`;
            console.log(chalk.red(`${blockTag(bn, totalBlocos)} Roteiro — erro permanente, sem retry`));
            break;
          }
          lastErr = `tentativa ${attempt}/${options.maxRetriesPerBlock} falhou`;
          if (attempt < options.maxRetriesPerBlock) {
            if (kind === "quota") {
              console.log(chalk.yellow(`${blockTag(bn, totalBlocos)} Roteiro — rate limit, aguardando ${QUOTA_RETRY_DELAY_MS / 1000}s...`));
              await new Promise((r) => setTimeout(r, QUOTA_RETRY_DELAY_MS));
            } else {
              console.log(chalk.yellow(`${blockTag(bn, totalBlocos)} Retry roteiro (${attempt + 1})...`));
            }
          }
        }
        bumpStage("roteiro", finalStatus);
        if (finalStatus === "error") {
          blockErrors.push({ stage: "roteiro", blockNumber: bn, error: lastErr ?? "erro", attempts: attemptsUsed });
          if (!options.continueOnError) break;
        }
      }
    }
  }

  // --- QualityGate (avaliacao + regeneracao dirigida por bloco) ---
  if (shouldRunStage(options.fromStage, "quality_gate", options.throughStage)) {
    updatePipelineRun(runId, { currentStage: "quality_gate" });
    console.log(chalk.bold("\n--- Etapa: quality_gate (avaliacao de qualidade do roteiro) ---\n"));
    for (let bn = 1; bn <= totalBlocos; bn += 1) {
      const stepId = insertPipelineRunStep({ runId, stage: "quality_gate", blockNumber: bn, status: "pending" });
      startPipelineRunStep(stepId);
      try {
        const result = await runQualityGateBlock(project, bn, roteiroOpts);
        const details = { score: result.score, attempts: result.attempts, skipped: result.skipped };
        finishPipelineRunStep(stepId, "success", undefined, details);
        bumpStage("quality_gate", "success");
        if (!result.skipped) {
          console.log(chalk.dim(`${blockTag(bn, totalBlocos)} QualityGate score=${result.score} (${result.attempts} iteracao(oes))`));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        finishPipelineRunStep(stepId, "error", msg);
        bumpStage("quality_gate", "error");
        blockErrors.push({ stage: "quality_gate", blockNumber: bn, error: msg, attempts: 1 });
        if (!options.continueOnError) throw e;
      }
    }
  }

  // --- Quotizador (Stoic overlay: blockNN.quotes.json) ---
  if (stoicOverlayModeEnabled() && shouldRunStage(options.fromStage, "quotizador", options.throughStage)) {
    updatePipelineRun(runId, { currentStage: "quotizador" });
    console.log(chalk.bold("\n--- Etapa: quotizador (Stoic Patrol overlays) ---\n"));
    for (let bn = 1; bn <= totalBlocos; bn += 1) {
      const scriptRow = listScriptBlocks(projectId).find((b) => b.block_number === bn);
      if (scriptRow?.status !== "success") {
        console.log(chalk.yellow(`${blockTag(bn, totalBlocos)} Roteiro incompleto, pulando quotizador`));
        continue;
      }
      const { status } = await recordStep(
        runId,
        "quotizador",
        bn,
        () => runQuotizadorBlock(project, bn),
        { continueOnError: options.continueOnError },
      );
      bumpStage("quotizador", status);
    }
  }

  // --- Imagens (plano + batch por bloco) ---
  if (shouldRunStage(options.fromStage, "imagens", options.throughStage)) {
    updatePipelineRun(runId, { currentStage: "imagens" });
    console.log(chalk.bold("\n--- Etapa: imagens (plano v2 + Google batch) ---\n"));
    for (let bn = 1; bn <= totalBlocos; bn += 1) {
      const media = getMediaBlock(projectId, bn);
      if (media?.renders_status === "success" && media?.plan_status === "success") {
        const stepId = insertPipelineRunStep({ runId, stage: "imagens", blockNumber: bn, status: "skipped" });
        finishPipelineRunStep(stepId, "skipped", undefined, { reason: "media_blocks success" });
        bumpStage("imagens", "skipped");
        console.log(chalk.dim(`${blockTag(bn, totalBlocos)} Imagens ja OK, pulando`));
        continue;
      }
      let finalStatus: PipelineStepStatus = "error";
      let attemptsUsed = 0;
      for (let attempt = 1; attempt <= options.maxRetriesPerBlock; attempt += 1) {
        attemptsUsed = attempt;
        const { status, caughtError } = await recordStep(
          runId,
          "imagens",
          bn,
          async () => {
            await runImagensVideosBlock(project, bn, options.avatarPath, limits, options.imagensOpts);
          },
          { continueOnError: true, attempt },
        );
        finalStatus = status;
        if (finalStatus === "success") break;
        const kind = classifyClaudeError(caughtError);
        if (kind === "permanent") {
          console.log(chalk.red(`${blockTag(bn, totalBlocos)} Imagens — erro permanente, sem retry`));
          break;
        }
        if (attempt < options.maxRetriesPerBlock) {
          if (kind === "quota") {
            console.log(chalk.yellow(`${blockTag(bn, totalBlocos)} Imagens — rate limit, aguardando ${QUOTA_RETRY_DELAY_MS / 1000}s...`));
            await new Promise((r) => setTimeout(r, QUOTA_RETRY_DELAY_MS));
          } else {
            console.log(chalk.yellow(`${blockTag(bn, totalBlocos)} Retry imagens (${attempt + 1})...`));
          }
        }
      }
      bumpStage("imagens", finalStatus);
      if (finalStatus === "error") {
        blockErrors.push({
          stage: "imagens",
          blockNumber: bn,
          error: "falha plano/render",
          attempts: attemptsUsed,
        });
      }
    }
  }

  // --- image:sync watch ---
  if (shouldRunStage(options.fromStage, "image_sync", options.throughStage)) {
    updatePipelineRun(runId, { currentStage: "image_sync" });
    console.log(chalk.bold("\n--- Etapa: image_sync (batch Google) ---\n"));
    const stepId = insertPipelineRunStep({ runId, stage: "image_sync", status: "pending" });
    startPipelineRunStep(stepId);
    const syncErrors: string[] = [];
    let rounds = 0;
    try {
      while (rounds < options.imageSyncMaxRounds) {
        const pending = countAllImageJobsPending(projectId);
        if (pending === 0) break;
        rounds += 1;
        const { processed, errors } = await syncImageJobsOnce({ projectId, maxJobs: 50, provider: "gemini" });
        console.log(
          chalk.cyan(`[pipeline image_sync] rodada ${rounds}: processados=${processed}, pendentes≈${countAllImageJobsPending(projectId)}`),
        );
        syncErrors.push(...errors);
        if (countAllImageJobsPending(projectId) === 0) break;
        await new Promise((r) => setTimeout(r, options.imageSyncIntervalMs));
      }
      const pendingAfter = countAllImageJobsPending(projectId);
      const failedAfter = countImageJobsFailed(projectId);
      finishPipelineRunStep(stepId, pendingAfter === 0 ? "success" : "error", undefined, {
        rounds,
        pending: pendingAfter,
        failed: failedAfter,
        syncErrors,
      });
      bumpStage("image_sync", pendingAfter === 0 ? "success" : "error");
      if (pendingAfter > 0) {
        hints.push(`image_jobs pendentes: ${pendingAfter} — rode: gentube image:sync --project ${slug} --watch`);
      }
      if (failedAfter > 0) {
        hints.push(`${failedAfter} image_jobs failed — etapa imagens_retry ou retry manual por bloco`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      finishPipelineRunStep(stepId, "error", msg);
      bumpStage("image_sync", "error");
      if (!options.continueOnError) throw e;
    }
  }

  // --- imagens_retry (blocos com jobs failed) ---
  if (shouldRunStage(options.fromStage, "imagens_retry", options.throughStage)) {
    const failedBlocks = listBlockNumbersWithFailedImageJobs(projectId);
    if (failedBlocks.length > 0) {
      updatePipelineRun(runId, { currentStage: "imagens_retry" });
      console.log(chalk.bold(`\n--- Etapa: imagens_retry (${failedBlocks.length} bloco(s)) ---\n`));
      for (const bn of failedBlocks) {
        const deleted = deleteFailedImageJobsForBlock(projectId, bn);
        console.log(chalk.dim(`${blockTag(bn, totalBlocos)} Removidos ${deleted} image_jobs failed; re-render...`));
        const { status: st } = await recordStep(
          runId,
          "imagens_retry",
          bn,
          () => runImagensVideosBlock(project, bn, options.avatarPath, limits, options.imagensOpts),
          { continueOnError: options.continueOnError, attempt: 1 },
        );
        bumpStage("imagens_retry", st);
        if (st === "error") {
          blockErrors.push({ stage: "imagens_retry", blockNumber: bn, error: "retry apos batch failed", attempts: 1 });
        }
      }
      // segunda rodada sync curta
      for (let r = 0; r < 20 && countAllImageJobsPending(projectId) > 0; r += 1) {
        await syncImageJobsOnce({ projectId, maxJobs: 50, provider: "gemini" });
        await new Promise((res) => setTimeout(res, options.imageSyncIntervalMs));
      }
    } else {
      const stepId = insertPipelineRunStep({ runId, stage: "imagens_retry", status: "skipped" });
      finishPipelineRunStep(stepId, "skipped", undefined, { reason: "nenhum image_job failed" });
      bumpStage("imagens_retry", "skipped");
    }
  }

  // --- Narracao ---
  if (shouldRunStage(options.fromStage, "narracao", options.throughStage)) {
    updatePipelineRun(runId, { currentStage: "narracao" });
    console.log(chalk.bold("\n--- Etapa: narracao (ElevenLabs por cena) ---\n"));
    for (let bn = 1; bn <= totalBlocos; bn += 1) {
      const narr = getNarrationBlock(projectId, bn);
      if (narr?.status === "success") {
        const stepId = insertPipelineRunStep({ runId, stage: "narracao", blockNumber: bn, status: "skipped" });
        finishPipelineRunStep(stepId, "skipped", undefined, { reason: "narration_blocks success" });
        bumpStage("narracao", "skipped");
        console.log(chalk.dim(`${blockTag(bn, totalBlocos)} Narracao ja OK, pulando`));
        continue;
      }
      let finalStatus: PipelineStepStatus = "error";
      let attemptsUsed = 0;
      for (let attempt = 1; attempt <= options.maxRetriesPerBlock; attempt += 1) {
        attemptsUsed = attempt;
        const { status, caughtError } = await recordStep(
          runId,
          "narracao",
          bn,
          () => runNarracaoBlock(project, options.voiceId, bn),
          { continueOnError: true, attempt },
        );
        finalStatus = status;
        if (finalStatus === "success") break;
        const kind = classifyClaudeError(caughtError);
        if (kind === "permanent") {
          console.log(chalk.red(`${blockTag(bn, totalBlocos)} Narracao — erro permanente, sem retry`));
          break;
        }
        if (attempt < options.maxRetriesPerBlock) {
          if (kind === "quota") {
            console.log(chalk.yellow(`${blockTag(bn, totalBlocos)} Narracao — rate limit, aguardando ${QUOTA_RETRY_DELAY_MS / 1000}s...`));
            await new Promise((r) => setTimeout(r, QUOTA_RETRY_DELAY_MS));
          } else {
            console.log(chalk.yellow(`${blockTag(bn, totalBlocos)} Retry narracao (${attempt + 1})...`));
          }
        }
      }
      bumpStage("narracao", finalStatus);
      if (finalStatus === "error") {
        blockErrors.push({ stage: "narracao", blockNumber: bn, error: "ElevenLabs/ffmpeg", attempts: attemptsUsed });
      }
    }
  }

  // --- Montagem ---
  if (shouldRunStage(options.fromStage, "montagem", options.throughStage)) {
    updatePipelineRun(runId, { currentStage: "montagem" });
    console.log(chalk.bold("\n--- Etapa: montagem ---\n"));
    const stepId = insertPipelineRunStep({ runId, stage: "montagem", status: "pending" });
    startPipelineRunStep(stepId);
    try {
      await runMontagem(project, {
        force: options.montagemForce,
        montagemPhase: options.montagemPhase,
      });
      finishPipelineRunStep(stepId, "success");
      bumpStage("montagem", "success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      finishPipelineRunStep(stepId, "error", msg);
      bumpStage("montagem", "error");
      blockErrors.push({ stage: "montagem", blockNumber: 0, error: msg, attempts: 1 });
      hints.push("Verifique 06 - Montagem/blocks/*.err.txt e cenas sem MP3/PNG");
      if (!options.continueOnError) throw e;
    }
  }

  // --- Thumbnails ---
  if (!options.skipThumbnails && shouldRunStage(options.fromStage, "thumbnails", options.throughStage)) {
    updatePipelineRun(runId, { currentStage: "thumbnails" });
    console.log(chalk.bold("\n--- Etapa: thumbnails ---\n"));
    const stepId = insertPipelineRunStep({ runId, stage: "thumbnails", status: "pending" });
    startPipelineRunStep(stepId);
    try {
      await runThumbnails(project, {
        referenceUrl: options.thumbnailReferenceUrl,
        avatarPath: options.avatarPath,
        count: options.thumbnailCount ?? 2,
        prompt: options.thumbnailPrompt,
        imageFlags: options.imagensOpts.imageFlags,
      });
      finishPipelineRunStep(stepId, "success");
      bumpStage("thumbnails", "success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      finishPipelineRunStep(stepId, "error", msg);
      bumpStage("thumbnails", "error");
      blockErrors.push({ stage: "thumbnails", blockNumber: 0, error: msg, attempts: 1 });
      if (!options.continueOnError) throw e;
    }
  } else if (options.skipThumbnails) {
    const stepId = insertPipelineRunStep({ runId, stage: "thumbnails", status: "skipped" });
    finishPipelineRunStep(stepId, "skipped", undefined, { reason: "--skip-thumbnails" });
    bumpStage("thumbnails", "skipped");
  }

  const finishedAt = new Date().toISOString();
  const pendingJobs = countAllImageJobsPending(projectId);
  const failedJobs = countImageJobsFailed(projectId);

  let runStatus: PipelineRunStatus = "success";
  if (blockErrors.length > 0 || failedJobs > 0 || pendingJobs > 0) {
    runStatus = blockErrors.length > 0 && stageCounts.roteiro?.error === totalBlocos ? "failed" : "partial";
  }

  const steps = listPipelineRunSteps(runId);
  const summary: RunSummary = {
    runId,
    profile: options.profile,
    projectId,
    slug,
    status: runStatus,
    continueOnError: options.continueOnError,
    startedAt,
    finishedAt,
    stages: stageCounts,
    blockErrors,
    imageJobs: { pending: pendingJobs, failed: failedJobs },
    hints,
  };

  const reportPayload = {
    ...summary,
    steps: steps.map((s) => ({
      id: s.id,
      stage: s.stage,
      block_number: s.block_number,
      status: s.status,
      attempt: s.attempt,
      error_message: s.error_message,
      started_at: s.started_at,
      finished_at: s.finished_at,
      details: s.details_json ? JSON.parse(s.details_json) : null,
    })),
    project_status: {
      roteiro: project.status_roteiro,
      narracao: project.status_narracao,
      imagens: project.status_imagens_videos,
      montagem: project.status_montagem,
      thumbnails: project.status_thumbnails,
    },
  };

  const reportPath = await writePipelineRunReport(projectPath, runId, reportPayload);
  updatePipelineRun(runId, {
    status: runStatus,
    currentStage: null,
    finishedAt,
    summaryJson: summary,
    reportPath,
  });

  addProjectLog(projectId, "pipeline", runStatus === "success" ? "info" : "error", `Fim run-pipeline #${runId}: ${runStatus}`, {
    reportPath,
    blockErrors: blockErrors.length,
    failedJobs,
    pendingJobs,
  });

  console.log(chalk.bold(`\n=== Pipeline #${runId} finalizado: ${runStatus.toUpperCase()} ===`));
  console.log(chalk.dim(`Relatorio: ${reportPath}`));
  console.log(chalk.dim(`Consulta: npm run gentube -- pipeline-report --project ${slug}`));
  if (blockErrors.length > 0) {
    console.log(chalk.yellow("\nBlocos com erro (corrigir manualmente depois):"));
    for (const e of blockErrors) {
      console.log(chalk.yellow(`  - ${e.stage} bloco ${e.blockNumber}: ${e.error}`));
    }
  }
  for (const h of hints) {
    console.log(chalk.cyan(`  → ${h}`));
  }

  return summary;
}

export function printPipelineReport(projectId: number, runId?: number): void {
  const run = runId !== undefined ? getPipelineRun(runId) : getLatestPipelineRun(projectId);
  if (!run) {
    console.log(chalk.yellow("Nenhuma execucao pipeline_runs para este projeto."));
    return;
  }
  const steps = listPipelineRunSteps(run.id);
  console.log(chalk.cyan.bold(`\nPipeline run #${run.id} · perfil ${run.profile} · status ${run.status}`));
  console.log(chalk.dim(`Inicio: ${run.started_at} · Fim: ${run.finished_at ?? "(em curso)"}`));
  if (run.report_path) console.log(chalk.dim(`Relatorio: ${run.report_path}`));
  if (run.summary_json) {
    try {
      const s = JSON.parse(run.summary_json) as RunSummary;
      if (s.imageJobs) {
        console.log(chalk.dim(`image_jobs: pending=${s.imageJobs.pending} failed=${s.imageJobs.failed}`));
      }
      if (s.hints?.length) {
        console.log(chalk.yellow("Dicas:"));
        for (const h of s.hints) console.log(chalk.yellow(`  ${h}`));
      }
    } catch {
      /* ignore */
    }
  }
  console.log(chalk.bold("\nPassos:"));
  for (const st of steps) {
    const bn = st.block_number != null ? ` bloco ${st.block_number}` : "";
    const err = st.error_message ? chalk.red(` — ${st.error_message}`) : "";
    const color =
      st.status === "success"
        ? chalk.green
        : st.status === "error"
          ? chalk.red
          : st.status === "skipped"
            ? chalk.dim
            : chalk.yellow;
    console.log(color(`  [${st.status}] ${st.stage}${bn} (tentativa ${st.attempt})${err}`));
  }
  console.log(chalk.dim("\nLogs detalhados: SELECT * FROM project_logs WHERE stage='pipeline' ORDER BY id DESC LIMIT 50;\n"));
}

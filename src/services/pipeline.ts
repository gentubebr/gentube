import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import {
  DEFAULT_MAX_IMAGES_BLOCK1,
  DEFAULT_MAX_IMAGES_OTHER_BLOCKS,
  DEFAULT_MAX_VIDEOS_BLOCK1,
  DEFAULT_MAX_VIDEOS_OTHER_BLOCKS,
  MANUAL_CAPTURE_PLACEHOLDER_PATH,
  PROMPT_MATRIX02_PATH,
  PROMPT_SEGMENTA01_PATH,
  resolveImageDelivery,
  resolveSceneImageDelivery,
  resolveStockRatioForBlock,
  resolveVisualModality,
  resolveVisualizaPromptContent,
  resolvePromptMatrixPath,
  resolveCanalVoicePath,
  ROOT_DIR,
  ROTEIRO_PREV_CONTEXT_MAX_CHARS,
  roteiroPrevContextEnabled,
  qualityGateEnabled,
  QUALITY_GATE_THRESHOLD,
  QUALITY_GATE_MAX_REGEN,
  type ImageRunFlags,
} from "../config.js";
import {
  generateAssetsPlanJson,
  generateScriptBlock,
  generateSegmentationPlanJson,
  generateVisualizationPlanJson,
  evaluateScriptQuality,
  type QualityGateResult,
} from "../integrations/claude.js";
import { runRoteiroBatchAll } from "../integrations/claude-stage-batch.js";
import { extractVideoId, downloadYoutubeThumbnail } from "../utils/youtube.js";
import { cachedTextToSpeech } from "./tts-cache.js";
import {
  enqueueImageWithDefaultsCli,
  enqueueThumbnailCli,
  enqueueVideoWithDefaultsCli,
  generateImageWithDefaultsCli,
  generateThumbnailCli,
} from "../integrations/higgsfield-cli.js";
import { renderVideoWithFallback } from "./video-generation.js";
import {
  addProjectLog,
  countBlocksByStatus,
  countHfCliJobsByBlockOutcome,
  countImageJobsByBlockOutcome,
  deleteHfCliJobsForBlock,
  deleteImageJobsForBlock,
  getMediaBlock,
  getNarrationBlock,
  getScriptBlock,
  insertHfCliJob,
  listScriptBlocks,
  recomputeImagensVideosStage,
  recomputeStageFromBlocks,
  updateProjectAnyStageStatus,
  updateScriptBlockQualityGate,
  upsertNarrationBlock,
  upsertMediaBlock,
  upsertScriptBlock,
} from "../repository.js";
import {
  flushPendingGoogleBatches,
  flushPendingLocalBatches,
  isGoogleBatchMode,
  renderSceneImage,
} from "./image-generation.js";
import {
  flushPendingLocalBatchesForProject,
  submitPendingGoogleBatches,
} from "./image-sync.js";
import { parseAndValidateAssetsPlan } from "../utils/assets-plan.js";
import { tryConcatMp3WithFfmpeg } from "../utils/mp3-concat.js";
import {
  clearPlanParseError,
  loadVisualizationErrorResume,
  mergeVisualizationRawHalves,
  parseSegmentationJson,
  parseVisualizationMerge,
  isBlockScenesPlanV2,
  unwrapJsonFromModel,
  writePlanParseError,
} from "../utils/scenes-plan.js";
import {
  resolveSceneCapsForBlock,
  splitScenesForVisualization,
  step3LimitsFromSceneCaps,
  visualizationShouldSplit,
} from "../utils/max-scenes.js";
import { searchAndDownload } from "../integrations/magnific.js";
import { sceneRenderOutputExists } from "../utils/media-output.js";
import { Step3Limits } from "../types/step3-limits.js";
import type { BlockScenesPlanV2, SegmentationPlanV2 } from "../types/scenes-plan.js";
import { assertWojakBlockPlan, prepareSceneVisualRender } from "../utils/wojak-prompt.js";

type ProjectRow = Record<string, unknown>;

function blockTag(blockNumber: number, totalBlocks: number): string {
  return chalk.dim(`[bloco ${blockNumber}/${totalBlocks}]`);
}

async function tryLoadPlanFromAssetsJson(jsonPath: string): Promise<BlockScenesPlanV2 | null> {
  try {
    const raw = await fs.readFile(jsonPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isBlockScenesPlanV2(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function tryLoadBlockScenesPlanV2(projectPath: string, blockNumber: number): Promise<BlockScenesPlanV2 | null> {
  const pad = String(blockNumber).padStart(2, "0");
  const jsonPath = path.join(projectPath, "03 - Imagens e Videos", `block${pad}.assets.json`);
  const plan = await tryLoadPlanFromAssetsJson(jsonPath);
  if (!plan || plan.block_number !== blockNumber) return null;
  return plan;
}


function forceScenePlanVizRegen(): boolean {
  return ["1", "true", "yes"].includes(String(process.env.GENTUBE_FORCE_VIZ_REGEN ?? "").toLowerCase());
}

/** Minimo de bytes para considerar um MP3 de cena reutilizavel (evita novo ElevenLabs). */
const MIN_SCENE_MP3_BYTES = 1024;

async function narrationSceneMp3Cached(sceneMp3Path: string): Promise<boolean> {
  try {
    const st = await fs.stat(sceneMp3Path);
    return st.isFile() && st.size >= MIN_SCENE_MP3_BYTES;
  } catch {
    return false;
  }
}

export type NarracaoOptions = {
  /** Regenera todos os scXX.mp3 do plano v2 (ignora MP3 >= 1 KiB no disco). */
  forceRegenScenes?: boolean;
};

function narracaoForceRegen(opts?: NarracaoOptions): boolean {
  return Boolean(opts?.forceRegenScenes);
}

/** Nao voltar a gerar plano/renders se o bloco ja esta concluido no SQLite (e, em async HF, sem jobs pendentes). */
function shouldSkipCompletedImagensBlock(projectId: number, blockNumber: number): boolean {
  const row = getMediaBlock(projectId, blockNumber);
  if (!row || row.plan_status !== "success") return false;
  if (row.renders_status === "success") return true;
  if (row.renders_status === "awaiting_hf") {
    const pendingHf = countHfCliJobsByBlockOutcome(projectId, blockNumber, "pending");
    const pendingImg = countImageJobsByBlockOutcome(projectId, blockNumber, "pending");
    // So saltar se ainda ha jobs; se zero, reprocessar (ex.: plan-only deixou awaiting_hf sem fila).
    return pendingHf + pendingImg > 0;
  }
  return false;
}

const GENTUBE_HF_ASYNC = ["1", "true", "yes"].includes(
  String(process.env.GENTUBE_HF_ASYNC ?? "").toLowerCase()
);

export type ImagensVideosOptions = {
  scenePlanV2?: boolean;
  imageFlags?: ImageRunFlags;
  /** So Claude v2 → blockNN.assets.json; sem stock, filas nem submit. */
  planOnly?: boolean;
  /** Plano existente → stock/filas; submit Google/local no fim do run (nao por bloco). */
  enqueueOnly?: boolean;
};

function assertImagensPhaseRequiresV2(opts?: ImagensVideosOptions): void {
  if ((opts?.planOnly || opts?.enqueueOnly) && !scenePlanV2Enabled(opts)) {
    throw new Error("--plan-only e --enqueue-only exigem --scene-plan-v2 (ou GENTUBE_SCENE_PLAN_V2=1)");
  }
}

function shouldSkipImagensBlock(projectId: number, blockNumber: number, opts?: ImagensVideosOptions): boolean {
  if (opts?.planOnly) {
    if (forceScenePlanVizRegen()) return false;
    const row = getMediaBlock(projectId, blockNumber);
    return row?.plan_status === "success";
  }
  if (opts?.enqueueOnly) {
    const row = getMediaBlock(projectId, blockNumber);
    if (row?.renders_status === "success") return true;
    if (row?.renders_status === "awaiting_hf") {
      const pendingImg = countImageJobsByBlockOutcome(projectId, blockNumber, "pending");
      const pendingHf = countHfCliJobsByBlockOutcome(projectId, blockNumber, "pending");
      if (pendingImg + pendingHf > 0) return true;
    }
    return false;
  }
  return shouldSkipCompletedImagensBlock(projectId, blockNumber);
}

async function finalizeDeferredBatchSubmits(
  projectId: number,
  imageFlags?: ImageRunFlags,
  opts?: ImagensVideosOptions
): Promise<void> {
  if (!opts?.enqueueOnly) return;
  const delivery = resolveImageDelivery(imageFlags);
  if (isGoogleBatchMode(imageFlags)) {
    const submitted = await submitPendingGoogleBatches(projectId);
    console.log(
      chalk.bold.cyan(
        `Submit diferido: ${submitted} batch(es) Google submetido(s) para o projeto. ` +
          `Rode: npm run gentube -- image:sync --project ${projectId} --watch`
      )
    );
    addProjectLog(
      projectId,
      "imagens_videos",
      "info",
      `Enqueue-only: ${submitted} batch(es) Google submetidos (scope=block)`,
      { submitted }
    );
  }
  if (delivery === "local_batch") {
    const batches = await flushPendingLocalBatchesForProject(projectId);
    console.log(chalk.bold.cyan(`Batch local: ${batches} lote(s) processado(s) no projeto.`));
    addProjectLog(projectId, "imagens_videos", "info", `Enqueue-only: batch-local concluido`, { batches });
  }
}

function imagensUsesAsyncQueue(opts?: ImagensVideosOptions): boolean {
  const delivery = resolveSceneImageDelivery(opts?.imageFlags);
  if (delivery === "google_batch" || delivery === "local_batch") return true;
  if (isGoogleBatchMode(opts?.imageFlags)) return true;
  return GENTUBE_HF_ASYNC;
}

function scenePlanV2Enabled(opts?: ImagensVideosOptions): boolean {
  if (opts?.scenePlanV2 === true) return true;
  return ["1", "true", "yes"].includes(String(process.env.GENTUBE_SCENE_PLAN_V2 ?? "").toLowerCase());
}

export type RoteiroPromptOptions = {
  promptMatrix?: string;
  promptCanalVoice?: string;
  /** Feedback do QualityGateAgent da iteracao anterior; injetado no prompt para regeneracao dirigida. */
  qualityFeedback?: string;
};

function truncateRoteiroPrevContext(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars === 0 || text.length <= maxChars) return { text, truncated: false };
  const marker =
    "[... inicio do contexto dos blocos anteriores omitido (GENTUBE_ROTEIRO_PREV_CONTEXT_CHARS) ...]\n\n";
  const budget = Math.max(0, maxChars - marker.length);
  return { text: marker + text.slice(-budget), truncated: true };
}

/** Le `01 - Roteiro/blockXX.md` para blocos 1 .. beforeBlock-1 (ficheiros ja existentes). */
async function loadPreviousRoteiroBlocksJoined(roteiroDir: string, beforeBlock: number): Promise<string> {
  if (beforeBlock <= 1) return "";
  const parts: string[] = [];
  for (let b = 1; b < beforeBlock; b += 1) {
    const fn = `block${String(b).padStart(2, "0")}.md`;
    const p = path.join(roteiroDir, fn);
    try {
      const raw = (await fs.readFile(p, "utf-8")).trim();
      if (raw) parts.push(`### Bloco ${b}\n\n${raw}`);
    } catch {
      /* ficheiro ausente — bloco ainda nao gerado ou caminho diferente */
    }
  }
  return parts.join("\n\n---\n\n").trim();
}

async function previousRoteiroContextForBlock(
  roteiroDir: string,
  blockNumber: number,
  projectId: number
): Promise<{ text: string; truncated: boolean }> {
  if (!roteiroPrevContextEnabled() || blockNumber <= 1) {
    return { text: "", truncated: false };
  }
  const joined = await loadPreviousRoteiroBlocksJoined(roteiroDir, blockNumber);
  if (!joined) {
    addProjectLog(
      projectId,
      "roteiro",
      "info",
      `Contexto de blocos anteriores vazio para bloco ${blockNumber} (ficheiros .md anteriores nao encontrados ou vazios)`
    );
    return { text: "", truncated: false };
  }
  const { text, truncated } = truncateRoteiroPrevContext(joined, ROTEIRO_PREV_CONTEXT_MAX_CHARS);
  if (truncated) {
    addProjectLog(projectId, "roteiro", "info", `Contexto dos blocos anteriores truncado a ${ROTEIRO_PREV_CONTEXT_MAX_CHARS} caracteres (mantido o fim)`);
  }
  return { text, truncated };
}

async function loadCanalVoiceForBlock1(
  blockNumber: number,
  projectId: number,
  cliOverride?: string
): Promise<string | undefined> {
  if (blockNumber !== 1) return undefined;
  const resolved = resolveCanalVoicePath(cliOverride);
  if (!resolved) return undefined;
  try {
    const raw = (await fs.readFile(resolved, "utf-8")).trim();
    if (!raw) return undefined;
    addProjectLog(
      projectId,
      "roteiro",
      "info",
      `Voz do canal (bloco 1): ${path.relative(ROOT_DIR, resolved) || resolved}`
    );
    return raw;
  } catch {
    addProjectLog(
      projectId,
      "roteiro",
      "info",
      `Ficheiro de voz do canal nao lido (bloco 1): ${path.relative(ROOT_DIR, resolved) || resolved}`
    );
    return undefined;
  }
}

export async function runRoteiro(project: ProjectRow, opts?: RoteiroPromptOptions): Promise<void> {
  const projectId = Number(project.id);
  const totalBlocos = Number(project.total_blocos);
  const promptPath = resolvePromptMatrixPath(opts?.promptMatrix);
  const promptBase = await fs.readFile(promptPath, "utf-8");
  addProjectLog(projectId, "roteiro", "info", `Prompt de roteiro: ${path.relative(ROOT_DIR, promptPath) || promptPath}`);
  const roteiroDir = path.join(String(project.project_path), "01 - Roteiro");

  updateProjectAnyStageStatus(projectId, "status_roteiro", "processing");
  addProjectLog(projectId, "roteiro", "info", "Iniciando geracao de roteiro");

  for (let i = 1; i <= totalBlocos; i += 1) {
    const existing = getScriptBlock(projectId, i);
    if (existing?.status === "success") {
      console.log(chalk.dim(`${blockTag(i, totalBlocos)} Roteiro ja concluido, pulando`));
      continue;
    }

    const blockFileName = `block${String(i).padStart(2, "0")}.md`;
    const blockPath = path.join(roteiroDir, blockFileName);
    const startedAt = new Date().toISOString();

    console.log(chalk.cyan(`${blockTag(i, totalBlocos)} Gerando roteiro...`));
    try {
      upsertScriptBlock(projectId, i, { status: "processing", started_at: startedAt, error_message: null });
      const { text: previousBlocksText } = await previousRoteiroContextForBlock(roteiroDir, i, projectId);
      const channelVoiceContext = await loadCanalVoiceForBlock1(i, projectId, opts?.promptCanalVoice);
      const content = await generateScriptBlock({
        promptBase,
        title: String(project.titulo),
        niche: String(project.niche),
        audience: String(project.audience),
        transcript: (project.transcript as string | null) ?? undefined,
        channelVoiceContext,
        previousBlocksText: previousBlocksText || undefined,
        blockNumber: i,
        totalBlocks: totalBlocos,
        projectId,
      });

      await fs.writeFile(blockPath, content, "utf-8");
      upsertScriptBlock(projectId, i, {
        status: "success",
        file_path_md: blockPath,
        content_md: content,
        finished_at: new Date().toISOString(),
      });
      console.log(chalk.green(`${blockTag(i, totalBlocos)} Roteiro salvo → ${blockFileName}`));
      addProjectLog(projectId, "roteiro", "info", `Bloco ${i} gerado com sucesso`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      console.log(chalk.red(`${blockTag(i, totalBlocos)} ERRO roteiro: ${message}`));
      upsertScriptBlock(projectId, i, { status: "error", error_message: message, finished_at: new Date().toISOString() });
      addProjectLog(projectId, "roteiro", "error", `Erro ao gerar bloco ${i}`, { error: message });
      updateProjectAnyStageStatus(projectId, "status_roteiro", "error");
      throw error;
    }
  }

  const totalSuccess = countBlocksByStatus("script_blocks", projectId, "success");
  if (totalSuccess === totalBlocos) {
    recomputeStageFromBlocks(projectId, totalBlocos, "script_blocks", "status_roteiro");
  } else {
    updateProjectAnyStageStatus(projectId, "status_roteiro", "error");
    throw new Error("Nem todos os blocos de roteiro foram gerados com sucesso");
  }
}

/** Gera apenas um bloco de roteiro e recalcula o status da etapa. */
export async function runRoteiroBlock(project: ProjectRow, blockNumber: number, opts?: RoteiroPromptOptions): Promise<void> {
  const projectId = Number(project.id);
  const totalBlocos = Number(project.total_blocos);
  if (blockNumber < 1 || blockNumber > totalBlocos) {
    throw new Error(`Bloco invalido: ${blockNumber} (esperado entre 1 e ${totalBlocos})`);
  }

  const promptPath = resolvePromptMatrixPath(opts?.promptMatrix);
  const promptBase = await fs.readFile(promptPath, "utf-8");
  addProjectLog(projectId, "roteiro", "info", `Prompt de roteiro (bloco ${blockNumber}): ${path.relative(ROOT_DIR, promptPath) || promptPath}`);
  const roteiroDir = path.join(String(project.project_path), "01 - Roteiro");
  const blockFileName = `block${String(blockNumber).padStart(2, "0")}.md`;
  const blockPath = path.join(roteiroDir, blockFileName);
  const startedAt = new Date().toISOString();

  addProjectLog(projectId, "roteiro", "info", `Reprocessando bloco ${blockNumber} do roteiro`);

  try {
    upsertScriptBlock(projectId, blockNumber, { status: "processing", started_at: startedAt, error_message: null });
    const { text: previousBlocksText } = await previousRoteiroContextForBlock(roteiroDir, blockNumber, projectId);
    const channelVoiceContext = await loadCanalVoiceForBlock1(blockNumber, projectId, opts?.promptCanalVoice);
    const content = await generateScriptBlock({
      promptBase,
      title: String(project.titulo),
      niche: String(project.niche),
      audience: String(project.audience),
      transcript: (project.transcript as string | null) ?? undefined,
      channelVoiceContext,
      previousBlocksText: previousBlocksText || undefined,
      blockNumber,
      totalBlocks: totalBlocos,
      projectId,
      qualityFeedback: opts?.qualityFeedback,
    });

    await fs.writeFile(blockPath, content, "utf-8");
    upsertScriptBlock(projectId, blockNumber, {
      status: "success",
      file_path_md: blockPath,
      content_md: content,
      finished_at: new Date().toISOString(),
    });
    addProjectLog(projectId, "roteiro", "info", `Bloco ${blockNumber} do roteiro gerado com sucesso`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    upsertScriptBlock(projectId, blockNumber, { status: "error", error_message: message, finished_at: new Date().toISOString() });
    addProjectLog(projectId, "roteiro", "error", `Erro ao gerar bloco ${blockNumber} do roteiro`, { error: message });
    recomputeStageFromBlocks(projectId, totalBlocos, "script_blocks", "status_roteiro");
    throw error;
  }

  recomputeStageFromBlocks(projectId, totalBlocos, "script_blocks", "status_roteiro");
}

/**
 * Gera todos os blocos de roteiro pendentes em um unico Message Batch da Anthropic.
 * Tradeoff: blocos sao submetidos em paralelo, entao nao ha contexto cruzado entre blocos
 * (previousBlocksText carregado do disco — vazio em execucao inicial). Economiza ~50% do custo.
 * Usar apenas quando GENTUBE_HF_ASYNC=1 ou configuracao explicita de batch.
 */
export async function runRoteiroBatchStage(project: ProjectRow, opts?: RoteiroPromptOptions): Promise<void> {
  const projectId = Number(project.id);
  const totalBlocos = Number(project.total_blocos);
  const promptPath = resolvePromptMatrixPath(opts?.promptMatrix);
  const promptBase = await fs.readFile(promptPath, "utf-8");
  addProjectLog(projectId, "roteiro", "info", `Prompt de roteiro (batch): ${path.relative(ROOT_DIR, promptPath) || promptPath}`);
  const roteiroDir = path.join(String(project.project_path), "01 - Roteiro");

  updateProjectAnyStageStatus(projectId, "status_roteiro", "processing");

  // Coletar blocos pendentes
  const pendingBlocks: number[] = [];
  for (let i = 1; i <= totalBlocos; i += 1) {
    const existing = getScriptBlock(projectId, i);
    if (existing?.status !== "success") {
      pendingBlocks.push(i);
    } else {
      console.log(chalk.dim(`${blockTag(i, totalBlocos)} Roteiro ja concluido, pulando`));
    }
  }

  if (pendingBlocks.length === 0) {
    addProjectLog(projectId, "roteiro", "info", "Todos os blocos ja concluidos, nada a fazer");
    recomputeStageFromBlocks(projectId, totalBlocos, "script_blocks", "status_roteiro");
    return;
  }

  // Preparar items do batch — previousBlocksText vem do disco (vazio em execucao inicial)
  const items = await Promise.all(
    pendingBlocks.map(async (blockNumber) => {
      const { text: previousBlocksText } = await previousRoteiroContextForBlock(roteiroDir, blockNumber, projectId);
      const channelVoiceContext = await loadCanalVoiceForBlock1(blockNumber, projectId, opts?.promptCanalVoice);
      upsertScriptBlock(projectId, blockNumber, {
        status: "processing",
        started_at: new Date().toISOString(),
        error_message: null,
      });
      return {
        projectId,
        promptBase,
        title: String(project.titulo),
        niche: String(project.niche),
        audience: String(project.audience),
        transcript: (project.transcript as string | null) ?? undefined,
        channelVoiceContext,
        previousBlocksText: previousBlocksText || undefined,
        blockNumber,
        totalBlocks: totalBlocos,
        qualityFeedback: opts?.qualityFeedback,
      };
    }),
  );

  addProjectLog(projectId, "roteiro", "info", `Submetendo batch com ${items.length} bloco(s)`);
  console.log(chalk.cyan(`Submetendo batch de roteiro: ${items.length} bloco(s)...`));

  let results: Map<number, string>;
  try {
    results = await runRoteiroBatchAll(items, {
      onStatus: (status, batchId) => {
        console.log(chalk.dim(`Batch roteiro [${batchId}] status: ${status}`));
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    for (const blockNumber of pendingBlocks) {
      upsertScriptBlock(projectId, blockNumber, {
        status: "error",
        error_message: message,
        finished_at: new Date().toISOString(),
      });
    }
    addProjectLog(projectId, "roteiro", "error", `Batch de roteiro falhou: ${message}`);
    updateProjectAnyStageStatus(projectId, "status_roteiro", "error");
    throw error;
  }

  // Persistir resultados
  for (const [blockNumber, content] of results) {
    const blockFileName = `block${String(blockNumber).padStart(2, "0")}.md`;
    const blockPath = path.join(roteiroDir, blockFileName);
    await fs.writeFile(blockPath, content, "utf-8");
    upsertScriptBlock(projectId, blockNumber, {
      status: "success",
      file_path_md: blockPath,
      content_md: content,
      finished_at: new Date().toISOString(),
    });
    console.log(chalk.green(`${blockTag(blockNumber, totalBlocos)} Roteiro (batch) salvo → ${blockFileName}`));
    addProjectLog(projectId, "roteiro", "info", `Bloco ${blockNumber} gerado via batch`);
  }

  const totalSuccess = countBlocksByStatus("script_blocks", projectId, "success");
  if (totalSuccess === totalBlocos) {
    recomputeStageFromBlocks(projectId, totalBlocos, "script_blocks", "status_roteiro");
  } else {
    updateProjectAnyStageStatus(projectId, "status_roteiro", "error");
    throw new Error("Nem todos os blocos de roteiro batch foram gerados com sucesso");
  }
}

export type QualityGateBlockResult = {
  score: number;
  attempts: number;
  passed: boolean;
  suggestions: string[];
  skipped: boolean;
};

/**
 * Avalia a qualidade do roteiro de um bloco e, se necessario, solicita regeneracao dirigida.
 * Sempre passa apos maxRegen iteracoes (nao bloqueia o pipeline).
 */
export async function runQualityGateBlock(
  project: ProjectRow,
  blockNumber: number,
  opts?: RoteiroPromptOptions & { threshold?: number; maxRegen?: number },
): Promise<QualityGateBlockResult> {
  const projectId = Number(project.id);
  const totalBlocos = Number(project.total_blocos);
  const threshold = opts?.threshold ?? QUALITY_GATE_THRESHOLD;
  const maxRegen = opts?.maxRegen ?? QUALITY_GATE_MAX_REGEN;

  if (!qualityGateEnabled()) {
    addProjectLog(projectId, "quality_gate", "info", `QualityGate desativado (bloco ${blockNumber})`);
    return { score: -1, attempts: 0, passed: true, suggestions: [], skipped: true };
  }

  const roteiroDir = path.join(String(project.project_path), "01 - Roteiro");
  const blockFileName = `block${String(blockNumber).padStart(2, "0")}.md`;
  const blockPath = path.join(roteiroDir, blockFileName);

  let blockText: string;
  try {
    blockText = await fs.readFile(blockPath, "utf-8");
  } catch {
    addProjectLog(projectId, "quality_gate", "error", `Bloco ${blockNumber} nao encontrado em disco; pulando QualityGate`);
    return { score: -1, attempts: 0, passed: true, suggestions: [], skipped: true };
  }

  let lastResult: QualityGateResult | null = null;
  let attempts = 0;

  for (let iter = 0; iter <= maxRegen; iter += 1) {
    addProjectLog(projectId, "quality_gate", "info", `Avaliando bloco ${blockNumber} (iteracao ${iter + 1}/${maxRegen + 1})`);

    lastResult = await evaluateScriptQuality({ blockText, blockNumber, totalBlocks: totalBlocos });
    attempts = iter + 1;

    const scoreLabel = lastResult.score_total >= threshold ? chalk.green(`${lastResult.score_total}`) : chalk.yellow(`${lastResult.score_total}`);
    console.log(chalk.cyan(`[quality_gate] bloco ${blockNumber}/${totalBlocos} score=${scoreLabel}/${threshold} (iter ${iter + 1})`));

    addProjectLog(projectId, "quality_gate", "info", `Score bloco ${blockNumber}: ${lastResult.score_total}`, {
      criteria: lastResult.criteria,
      blockers: lastResult.blockers,
      suggestions: lastResult.suggestions,
      threshold,
      iter,
    });

    if (lastResult.score_total >= threshold || iter >= maxRegen) break;

    // Score insuficiente e ainda ha regeneracoes disponíveis — regenera com feedback
    const feedbackLines = [
      ...lastResult.blockers.map((b) => `PROBLEMA: ${b}`),
      ...lastResult.suggestions.map((s) => `MELHORIA: ${s}`),
    ].join("\n");

    console.log(chalk.yellow(`[quality_gate] bloco ${blockNumber} score abaixo de ${threshold} — regenerando com feedback`));
    addProjectLog(projectId, "quality_gate", "info", `Regenerando bloco ${blockNumber} com feedback de qualidade`, { feedback: feedbackLines });

    await runRoteiroBlock(project, blockNumber, { ...opts, qualityFeedback: feedbackLines });

    blockText = await fs.readFile(blockPath, "utf-8");
  }

  const finalScore = lastResult?.score_total ?? 0;
  const passed = finalScore >= threshold || maxRegen === 0;

  updateScriptBlockQualityGate(projectId, blockNumber, finalScore, attempts);

  const resultLabel = passed ? chalk.green("APROVADO") : chalk.yellow("PASSOU (max regen atingido)");
  console.log(chalk.cyan(`[quality_gate] bloco ${blockNumber}/${totalBlocos} ${resultLabel} — score final ${finalScore}`));

  return {
    score: finalScore,
    attempts,
    passed: true, // nunca bloqueia o pipeline
    suggestions: lastResult?.suggestions ?? [],
    skipped: false,
  };
}

async function synthesizeBlockNarration(input: {
  projectId: number;
  projectPath: string;
  blockNumber: number;
  totalBlocos: number;
  voiceId: string;
  sourceText: string;
  narracaoDir: string;
  opts?: NarracaoOptions;
}): Promise<void> {
  const { projectId, blockNumber, totalBlocos, voiceId, sourceText, narracaoDir, opts } = input;
  const force = narracaoForceRegen(opts);
  const startedAt = new Date().toISOString();
  const audioPath = path.join(narracaoDir, `block${String(blockNumber).padStart(2, "0")}.mp3`);

  console.log(chalk.cyan(`${blockTag(blockNumber, totalBlocos)} Gerando narracao...`));
  if (force) {
    console.log(chalk.dim(`${blockTag(blockNumber, totalBlocos)} --force-narracao: regenerando MP3 por cena`));
  }

  upsertNarrationBlock(projectId, blockNumber, { status: "processing", started_at: startedAt, error_message: null });
  const pad = String(blockNumber).padStart(2, "0");
  let primaryMp3Path = audioPath;

  const planV2 = await tryLoadBlockScenesPlanV2(input.projectPath, blockNumber);
  if (planV2) {
    const blockSubDir = path.join(narracaoDir, `block${pad}`);
    await fs.mkdir(blockSubDir, { recursive: true });
    const scenePaths: string[] = [];
    for (const scene of planV2.scenes) {
      const p = path.join(blockSubDir, `${scene.id}.mp3`);
      if (!force && (await narrationSceneMp3Cached(p))) {
        console.log(chalk.dim(`${blockTag(blockNumber, totalBlocos)} Reutilizando ${scene.id}.mp3`));
        scenePaths.push(p);
        continue;
      }
      console.log(chalk.dim(`${blockTag(blockNumber, totalBlocos)} ElevenLabs ${scene.id}...`));
      const { cacheHit } = await cachedTextToSpeech({ text: scene.narration_text, voiceId }, p);
      if (cacheHit) {
        console.log(chalk.dim(`${blockTag(blockNumber, totalBlocos)} ${scene.id} — TTS cache hit`));
      }
      scenePaths.push(p);
    }
    const concatOk = await tryConcatMp3WithFfmpeg(scenePaths, audioPath);
    if (!concatOk) {
      console.log(
        chalk.yellow(
          `${blockTag(blockNumber, totalBlocos)} ffmpeg ausente ou concat falhou: block${pad}.mp3 nao criado. Use os MP3 por cena em block${pad}/.`,
        ),
      );
      primaryMp3Path = scenePaths[0]!;
    }
  } else {
    await cachedTextToSpeech({ text: sourceText, voiceId }, audioPath);
  }

  upsertNarrationBlock(projectId, blockNumber, {
    status: "success",
    file_path_mp3: primaryMp3Path,
    finished_at: new Date().toISOString(),
  });

  if (planV2) {
    let monolithicOk = false;
    try {
      const st = await fs.stat(audioPath);
      monolithicOk = st.isFile();
    } catch {
      monolithicOk = false;
    }
    if (monolithicOk) {
      console.log(
        chalk.green(`${blockTag(blockNumber, totalBlocos)} Por cena → block${pad}/ + block${pad}.mp3 (concat)`),
      );
    } else {
      console.log(
        chalk.green(
          `${blockTag(blockNumber, totalBlocos)} Por cena → block${pad}/ (${planV2.scenes.length} MP3); sem block${pad}.mp3 ate ter ffmpeg`,
        ),
      );
    }
  } else {
    console.log(chalk.green(`${blockTag(blockNumber, totalBlocos)} Audio salvo → block${pad}.mp3`));
  }
  addProjectLog(projectId, "narracao", "info", `Audio do bloco ${blockNumber} gerado com sucesso`);
}

export async function runNarracao(project: ProjectRow, voiceId: string, opts?: NarracaoOptions): Promise<void> {
  const projectId = Number(project.id);
  const totalBlocos = Number(project.total_blocos);
  const narracaoDir = path.join(String(project.project_path), "02 - Narracao");

  updateProjectAnyStageStatus(projectId, "status_narracao", "processing");
  addProjectLog(projectId, "narracao", "info", "Iniciando geracao de narracao");

  const scriptBlocks = listScriptBlocks(projectId);
  if (scriptBlocks.length !== totalBlocos) {
    throw new Error("Quantidade de blocos de roteiro nao bate com o total esperado do projeto");
  }

  for (const block of scriptBlocks) {
    if (block.status !== "success" || !block.file_path_md) {
      throw new Error(`Bloco ${block.block_number} nao esta pronto para narracao`);
    }
    const blockNumber = block.block_number;

    const existingNarration = getNarrationBlock(projectId, blockNumber);
    if (!narracaoForceRegen(opts) && existingNarration?.status === "success") {
      console.log(chalk.dim(`${blockTag(blockNumber, totalBlocos)} Narracao ja concluida, pulando`));
      continue;
    }

    const sourceText = await fs.readFile(block.file_path_md, "utf-8");
    try {
      await synthesizeBlockNarration({
        projectId,
        projectPath: String(project.project_path),
        blockNumber,
        totalBlocos,
        voiceId,
        sourceText,
        narracaoDir,
        opts,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      console.log(chalk.red(`${blockTag(blockNumber, totalBlocos)} ERRO narracao: ${message}`));
      upsertNarrationBlock(projectId, blockNumber, {
        status: "error",
        error_message: message,
        finished_at: new Date().toISOString(),
      });
      addProjectLog(projectId, "narracao", "error", `Erro ao gerar audio do bloco ${blockNumber}`, { error: message });
      updateProjectAnyStageStatus(projectId, "status_narracao", "error");
      throw error;
    }
  }

  const totalSuccess = countBlocksByStatus("narration_blocks", projectId, "success");
  if (totalSuccess === totalBlocos) {
    recomputeStageFromBlocks(projectId, totalBlocos, "narration_blocks", "status_narracao");
  } else {
    updateProjectAnyStageStatus(projectId, "status_narracao", "error");
    throw new Error("Nem todos os audios foram gerados com sucesso");
  }
}

/** Gera apenas o audio de um bloco e recalcula o status da etapa. */
export async function runNarracaoBlock(
  project: ProjectRow,
  voiceId: string,
  blockNumber: number,
  opts?: NarracaoOptions,
): Promise<void> {
  const projectId = Number(project.id);
  const totalBlocos = Number(project.total_blocos);
  if (blockNumber < 1 || blockNumber > totalBlocos) {
    throw new Error(`Bloco invalido: ${blockNumber} (esperado entre 1 e ${totalBlocos})`);
  }

  const narracaoDir = path.join(String(project.project_path), "02 - Narracao");
  const scriptBlocks = listScriptBlocks(projectId);
  const scriptRow = scriptBlocks.find((b) => b.block_number === blockNumber);
  if (!scriptRow || scriptRow.status !== "success" || !scriptRow.file_path_md) {
    throw new Error(`Bloco ${blockNumber} do roteiro nao esta pronto para narracao`);
  }

  const sourceText = await fs.readFile(scriptRow.file_path_md, "utf-8");

  addProjectLog(projectId, "narracao", "info", `Reprocessando audio do bloco ${blockNumber}`);

  try {
    await synthesizeBlockNarration({
      projectId,
      projectPath: String(project.project_path),
      blockNumber,
      totalBlocos,
      voiceId,
      sourceText,
      narracaoDir,
      opts,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    upsertNarrationBlock(projectId, blockNumber, {
      status: "error",
      error_message: message,
      finished_at: new Date().toISOString(),
    });
    addProjectLog(projectId, "narracao", "error", `Erro ao gerar audio do bloco ${blockNumber}`, { error: message });
    recomputeStageFromBlocks(projectId, totalBlocos, "narration_blocks", "status_narracao");
    throw error;
  }

  recomputeStageFromBlocks(projectId, totalBlocos, "narration_blocks", "status_narracao");
}

function extFromUrlOrType(url: string, contentType: string | null, fallback: ".bin" | ".png" | ".mp4"): string {
  if (contentType?.includes("image/png")) return ".png";
  if (contentType?.includes("image/jpeg")) return ".jpg";
  if (contentType?.includes("video/mp4")) return ".mp4";
  const clean = url.split("?")[0] ?? "";
  if (clean.endsWith(".png")) return ".png";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return ".jpg";
  if (clean.endsWith(".mp4")) return ".mp4";
  return fallback;
}

async function downloadMedia(mediaUrl: string, outPathNoExt: string, fallbackExt: ".png" | ".mp4"): Promise<string> {
  const res = await fetch(mediaUrl);
  if (!res.ok) throw new Error(`Falha no download da midia (${res.status})`);
  const arr = await res.arrayBuffer();
  const ext = extFromUrlOrType(mediaUrl, res.headers.get("content-type"), fallbackExt);
  const finalPath = `${outPathNoExt}${ext}`;
  await fs.writeFile(finalPath, Buffer.from(arr));
  return finalPath;
}

async function enqueueRenderShotTracked(
  projectId: number,
  blockNumber: number,
  shotId: string,
  params: {
    type: "image" | "video";
    prompt: string;
    outPathNoExt: string;
    referenceImageUrl?: string;
  }
): Promise<{ hfJobId: string; chainRef?: string }> {
  const hfJobId =
    params.type === "image"
      ? await enqueueImageWithDefaultsCli({
          prompt: params.prompt,
          referenceImageUrl: params.referenceImageUrl,
        })
      : await enqueueVideoWithDefaultsCli({
          prompt: params.prompt,
          referenceImageUrl: params.referenceImageUrl ?? "",
        });
  insertHfCliJob({
    projectId,
    blockNumber,
    shotId,
    assetType: params.type,
    outPathNoExt: params.outPathNoExt,
    hfJobId,
  });
  return { hfJobId, chainRef: params.type === "image" ? hfJobId : undefined };
}

async function generateAndRenderShot(params: {
  type: "image" | "video";
  prompt: string;
  outPathNoExt: string;
  referenceImageUrl?: string;
  magnificKeywords?: string | null;
}): Promise<{ localPath: string; mediaUrl?: string; provider?: string }> {
  if (params.type === "video") {
    const out = await renderVideoWithFallback({
      prompt: params.prompt,
      outPathNoExt: params.outPathNoExt,
      referenceImageUrl: params.referenceImageUrl,
      magnificKeywords: params.magnificKeywords,
    });
    return { localPath: out.localPath, mediaUrl: out.mediaUrl, provider: out.provider };
  }

  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const out = await generateImageWithDefaultsCli({
        prompt: params.prompt,
        referenceImageUrl: params.referenceImageUrl,
      });
      const localPath = await downloadMedia(out.mediaUrl, params.outPathNoExt, ".png");
      return { localPath, mediaUrl: out.mediaUrl, provider: "higgsfield" };
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
    }
  }
  const msg = lastError instanceof Error ? lastError.message : "Erro desconhecido";
  throw new Error(`Falhou apos 3 tentativas: ${msg}`);
}

async function parseSegmentationWithErrorFile(
  assetsJsonPath: string,
  raw: string,
  blockNumber: number,
  totalBlocks: number,
  blockText: string,
  maxScenes: number
): Promise<SegmentationPlanV2> {
  try {
    return parseSegmentationJson(raw, blockNumber, totalBlocks, blockText, { maxScenes });
  } catch (e) {
    const parseError = e instanceof Error ? e.message : String(e);
    const errorPath = await writePlanParseError(assetsJsonPath, {
      stage: "segmentation",
      parse_error: parseError,
      raw_response: raw,
      unwrapped_for_json_parse: unwrapJsonFromModel(raw),
    });
    console.log(chalk.red(`Resposta Claude (segmentacao) gravada em: ${errorPath}`));
    throw new Error(`${parseError} — inspecione ${errorPath} (sem retry automatico; evita gastar creditos)`);
  }
}

async function parseVisualizationWithErrorFile(
  assetsJsonPath: string,
  raw: string,
  segmentation: SegmentationPlanV2,
  blockText: string,
  limits?: Step3Limits
): Promise<BlockScenesPlanV2> {
  try {
    return parseVisualizationMerge(raw, segmentation, blockText, limits);
  } catch (e) {
    const parseError = e instanceof Error ? e.message : String(e);
    const errorPath = await writePlanParseError(assetsJsonPath, {
      stage: "visualization",
      parse_error: parseError,
      raw_response: raw,
      unwrapped_for_json_parse: unwrapJsonFromModel(raw),
      segmentation_json: segmentation,
    });
    console.log(chalk.red(`Resposta Claude (visualizacao) gravada em: ${errorPath}`));
    throw new Error(`${parseError} — inspecione ${errorPath} (sem retry automatico; evita gastar creditos)`);
  }
}

async function imagensBlockPlanAndRenderV2(input: {
  projectId: number;
  blockNumber: number;
  totalBlocos: number;
  project: ProjectRow;
  scriptText: string;
  jsonPath: string;
  rendersDir: string;
  avatarPath?: string;
  limits?: Step3Limits;
  stockRatio: number;
  manualCaptureSignals: string[];
  imageFlags?: ImageRunFlags;
  planOnly?: boolean;
  enqueueOnly?: boolean;
}): Promise<{
  hfJobTotal: number;
  sceneCount: number;
  doneSync: number;
  planImages: number;
  planVideos: number;
}> {
  await fs.access(MANUAL_CAPTURE_PLACEHOLDER_PATH).catch(() => {
    throw new Error(`Placeholder manual_capture ausente: ${MANUAL_CAPTURE_PLACEHOLDER_PATH}`);
  });

  const bn = input.blockNumber;
  const tb = input.totalBlocos;
  const caps = resolveSceneCapsForBlock(input.scriptText, bn, input.limits);
  const maxScenes = caps.maxScenes;
  const maxImages = caps.maxImages;
  const maxVideos = caps.maxVideos;
  if (caps.dynamic) {
    console.log(
      chalk.dim(
        `${blockTag(bn, tb)} max_scenes=${maxScenes} (${caps.wordCount} palavras, formula dinamica)`,
      ),
    );
  }

  const forceVizRegen = forceScenePlanVizRegen();
  const existingPlan = forceVizRegen ? null : await tryLoadPlanFromAssetsJson(input.jsonPath);
  const errorResume =
    forceVizRegen || existingPlan ? null : await loadVisualizationErrorResume(input.jsonPath);

  let plan: BlockScenesPlanV2;

  if (input.enqueueOnly && !existingPlan && !errorResume) {
    throw new Error(
      `--enqueue-only: plano ausente em ${path.basename(input.jsonPath)}. Rode antes com --plan-only.`
    );
  }

  if (input.enqueueOnly && existingPlan) {
    console.log(
      chalk.yellow(
        `${blockTag(input.blockNumber, input.totalBlocos)} Enqueue-only: plano existente em ${path.basename(input.jsonPath)}`
      )
    );
    plan = existingPlan;
  } else if (input.enqueueOnly && errorResume) {
    throw new Error(
      `--enqueue-only: existe ${path.basename(input.jsonPath)}.error — resolva ou use GENTUBE_FORCE_VIZ_REGEN=1 com --plan-only`
    );
  } else if (existingPlan) {
    console.log(
      chalk.yellow(
        `${blockTag(input.blockNumber, input.totalBlocos)} Reutilizando plano em ${path.basename(input.jsonPath)} (sem Claude). GENTUBE_FORCE_VIZ_REGEN=1 para regerar.`
      )
    );
    addProjectLog(input.projectId, "imagens_videos", "info", `Bloco ${input.blockNumber}: plano existente em disco`, {
      assets_json: path.basename(input.jsonPath),
    });
    plan = existingPlan;
  } else {
    const segPrompt = await fs.readFile(PROMPT_SEGMENTA01_PATH, "utf-8");
    const vizPrompt = await resolveVisualizaPromptContent();

    let seg: SegmentationPlanV2;
    let rawViz: string;

    if (errorResume) {
      const errPath = `${input.jsonPath}.error`;
      console.log(
        chalk.yellow(
          `${blockTag(input.blockNumber, input.totalBlocos)} Reutilizando segmentacao + visualizacao em ${path.basename(errPath)} (sem novo Claude). Defina GENTUBE_FORCE_VIZ_REGEN=1 para regerar.`
        )
      );
      addProjectLog(input.projectId, "imagens_videos", "info", `Bloco ${input.blockNumber}: resume de ${path.basename(errPath)}`, {
        prior_error: errorResume.parse_error,
      });
      seg = errorResume.segmentation_json;
      rawViz = errorResume.raw_response;
    } else {
      const rawSeg = await generateSegmentationPlanJson({
        promptBase: segPrompt,
        blockNumber: input.blockNumber,
        totalBlocks: input.totalBlocos,
        blockText: input.scriptText,
        maxScenes,
        projectId: input.projectId,
      });
      seg = await parseSegmentationWithErrorFile(
        input.jsonPath,
        rawSeg,
        input.blockNumber,
        input.totalBlocos,
        input.scriptText,
        maxScenes
      );

      const visualModality = resolveVisualModality();
      const segJsonFull = JSON.stringify(seg, null, 2);
      if (visualizationShouldSplit(seg.scenes.length)) {
        const [partA, partB] = splitScenesForVisualization(seg.scenes);
        const segA: SegmentationPlanV2 = { ...seg, scenes: partA };
        const segB: SegmentationPlanV2 = { ...seg, scenes: partB };
        console.log(
          chalk.dim(
            `${blockTag(bn, tb)} Visualizacao em 2 pedidos (${partA.length}+${partB.length} cenas)`,
          ),
        );
        const rawVizA = await generateVisualizationPlanJson({
          promptBase: vizPrompt,
          blockNumber: input.blockNumber,
          totalBlocks: input.totalBlocos,
          audience: String(input.project.audience),
          stockRatio: input.stockRatio,
          manualCaptureSignals: input.manualCaptureSignals,
          segmentationJson: JSON.stringify(segA, null, 2),
          maxVideos,
          maxImages,
          visualModality,
          projectId: input.projectId,
          customIdSuffix: "viz-a",
        });
        const rawVizB = await generateVisualizationPlanJson({
          promptBase: vizPrompt,
          blockNumber: input.blockNumber,
          totalBlocks: input.totalBlocos,
          audience: String(input.project.audience),
          stockRatio: input.stockRatio,
          manualCaptureSignals: input.manualCaptureSignals,
          segmentationJson: JSON.stringify(segB, null, 2),
          maxVideos,
          maxImages,
          visualModality,
          projectId: input.projectId,
          customIdSuffix: "viz-b",
        });
        rawViz = mergeVisualizationRawHalves(rawVizA, rawVizB);
      } else {
        rawViz = await generateVisualizationPlanJson({
          promptBase: vizPrompt,
          blockNumber: input.blockNumber,
          totalBlocks: input.totalBlocos,
          audience: String(input.project.audience),
          stockRatio: input.stockRatio,
          manualCaptureSignals: input.manualCaptureSignals,
          segmentationJson: segJsonFull,
          maxVideos,
          maxImages,
          visualModality,
          projectId: input.projectId,
        });
      }
    }

    plan = await parseVisualizationWithErrorFile(
      input.jsonPath,
      rawViz,
      seg,
      input.scriptText,
      step3LimitsFromSceneCaps(bn, caps, input.limits),
    );

    await clearPlanParseError(input.jsonPath);
    await fs.mkdir(path.dirname(input.jsonPath), { recursive: true });
    await fs.writeFile(input.jsonPath, JSON.stringify(plan, null, 2), "utf-8");
  }

  assertWojakBlockPlan(plan);

  const planImages = plan.scenes.filter((s) => s.visual.type === "image").length;
  const planVideos = plan.scenes.filter((s) => s.visual.type === "video").length;

  if (input.planOnly) {
    upsertMediaBlock(input.projectId, input.blockNumber, {
      assets_json_path: input.jsonPath,
      plan_status: "success",
      plan_error: null,
      renders_status: "pending",
      renders_total_count: plan.scenes.length,
      renders_done_count: 0,
    });
    console.log(
      chalk.green(
        `${blockTag(input.blockNumber, input.totalBlocos)} Plano v2 gravado (plan-only): ` +
          `${planImages} imagens + ${planVideos} videos → ${path.basename(input.jsonPath)}`
      )
    );
    addProjectLog(input.projectId, "imagens_videos", "info", `Bloco ${input.blockNumber}: plan-only concluido`, {
      planImages,
      planVideos,
      sceneCount: plan.scenes.length,
    });
    return {
      hfJobTotal: 0,
      sceneCount: plan.scenes.length,
      doneSync: 0,
      planImages,
      planVideos,
    };
  }

  upsertMediaBlock(input.projectId, input.blockNumber, {
    assets_json_path: input.jsonPath,
    plan_status: "success",
    plan_error: null,
    renders_status: "processing",
    renders_total_count: plan.scenes.length,
    ...(existingPlan && !input.enqueueOnly ? {} : { renders_done_count: 0 }),
  });

  await fs.mkdir(input.rendersDir, { recursive: true });

  const delivery = resolveSceneImageDelivery(input.imageFlags);
  const blockBatchId =
    delivery === "google_batch" || delivery === "local_batch" ? crypto.randomUUID() : undefined;
  const batchIds: string[] = blockBatchId ? [blockBatchId] : [];

  let done = 0;
  let hfJobTotal = 0;
  let lastImageRef: string | undefined;
  let lastImageRefLocal: string | undefined;
  const visualModality = resolveVisualModality();
  if (visualModality === "wojak") {
    console.log(
      chalk.cyan(
        `  ${blockTag(bn, tb)} Modalidade visual: wojak (Gemini + Veo; sem stock/HF — ver wojak.md)`
      )
    );
  }
  const useHfVideoQueue = GENTUBE_HF_ASYNC && visualModality !== "wojak";
  const avatarRef =
    input.avatarPath && String(input.avatarPath).trim()
      ? /^https?:\/\//i.test(String(input.avatarPath))
        ? String(input.avatarPath).trim()
        : path.resolve(String(input.avatarPath))
      : undefined;

  for (const scene of plan.scenes) {
    const v = scene.visual;
    if (await sceneRenderOutputExists(input.rendersDir, scene.id, v.type)) {
      console.log(chalk.dim(`  ${blockTag(bn, tb)} ${scene.id} ja no disco, pulando`));
      continue;
    }
    let effectiveSource = v.source;

    if (effectiveSource === "stock") {
      if (visualModality === "wojak") {
        throw new Error(
          `Cena ${scene.id}: source stock no plano em modo wojak. Regerar com GENTUBE_FORCE_VIZ_REGEN=1 e --plan-only.`
        );
      }
      if (v.search_keywords?.trim()) {
        console.log(chalk.dim(`  ${blockTag(bn, tb)} Stock ${scene.id} (${v.type}): "${v.search_keywords.trim()}"...`));
        try {
          const localPath = await searchAndDownload({
            type: v.type,
            keywords: v.search_keywords.trim(),
            destPathNoExt: path.join(input.rendersDir, scene.id),
          });
          done += 1;
          console.log(chalk.green(`  ${blockTag(bn, tb)} Stock baixado: ${scene.id} → ${path.basename(localPath)}`));
          addProjectLog(input.projectId, "imagens_videos", "info", `Stock baixado bloco ${bn} cena ${scene.id}`, {
            mediaPath: localPath,
            keywords: v.search_keywords.trim(),
          });
          upsertMediaBlock(input.projectId, bn, { renders_done_count: done });
        } catch (stockErr) {
          const msg = stockErr instanceof Error ? stockErr.message : "Erro stock";
          console.log(chalk.yellow(`  ${blockTag(bn, tb)} Stock falhou ${scene.id}: ${msg} — fallback IA`));
          addProjectLog(input.projectId, "imagens_videos", "info", `Stock falhou bloco ${bn} cena ${scene.id}, fallback IA`, {
            error: msg,
          });
          effectiveSource = "ai_generated";
        }
      }
      if (effectiveSource === "stock") continue;
    }

    if (effectiveSource === "manual_capture") {
      if (visualModality === "wojak") {
        throw new Error(`Cena ${scene.id}: manual_capture proibido em modo wojak`);
      }
      const dest = path.join(input.rendersDir, `${scene.id}.png`);
      await fs.copyFile(MANUAL_CAPTURE_PLACEHOLDER_PATH, dest);
      done += 1;
      console.log(chalk.green(`  ${blockTag(bn, tb)} manual_capture placeholder → ${path.basename(dest)}`));
      addProjectLog(input.projectId, "imagens_videos", "info", `Placeholder manual_capture ${scene.id}`, { mediaPath: dest });
      upsertMediaBlock(input.projectId, bn, { renders_done_count: done });
      continue;
    }

    if (effectiveSource !== "ai_generated") continue;

    const renderPrep = prepareSceneVisualRender(v, scene.narration_text, visualModality, avatarRef);
    const hfPrompt = renderPrep.hfPrompt;
    const bootstrapPrompt = renderPrep.bootstrapPrompt ?? hfPrompt;
    const veoPrompt = renderPrep.veoPrompt ?? hfPrompt;
    let referenceImageUrl = renderPrep.referenceImageUrl;
    if (renderPrep.wojakReferenceLabel) {
      console.log(chalk.dim(`  ${blockTag(bn, tb)} Ref Wojak: ${renderPrep.wojakReferenceLabel}`));
    }

    if (v.type === "video" && !referenceImageUrl && !renderPrep.wojakVideoBootstrap) {
      if (GENTUBE_HF_ASYNC) {
        referenceImageUrl = avatarRef ?? lastImageRefLocal;
      } else {
        referenceImageUrl = lastImageRef;
      }
    }

    const needsVideoBootstrap =
      v.type === "video" && (renderPrep.wojakVideoBootstrap || !referenceImageUrl);

    if (needsVideoBootstrap) {
      console.log(chalk.dim(`  ${blockTag(bn, tb)} Bootstrap imagem para video ${scene.id}...`));
      const bootstrap = await renderSceneImage(
        {
          projectId: input.projectId,
          blockNumber: bn,
          shotId: `${scene.id}__bootstrap`,
          prompt: bootstrapPrompt,
          outPathNoExt: path.join(input.rendersDir, `${scene.id}__bootstrap`),
          referenceImageUrl: renderPrep.wojakVideoBootstrap ? renderPrep.referenceImageUrl : avatarRef,
          flags: input.imageFlags,
          forceSync: true,
        },
        blockBatchId
      );
      if (!bootstrap.doneSync || !bootstrap.localPath) {
        throw new Error(`Bootstrap imagem nao concluiu em sync para cena ${scene.id}`);
      }
      lastImageRefLocal = bootstrap.localPath;
      lastImageRef = bootstrap.localPath;
      referenceImageUrl = bootstrap.localPath;
      console.log(chalk.dim(`  ${blockTag(bn, tb)} Bootstrap pronto → ${path.basename(bootstrap.localPath)}`));
      addProjectLog(input.projectId, "imagens_videos", "info", `Bootstrap imagem video cena ${scene.id}`, {
        mediaPath: bootstrap.localPath,
        provider: bootstrap.provider,
      });
    }

    if (v.type === "video" && maxVideos === 0) {
      done += 1;
      console.log(
        chalk.green(
          `  ${blockTag(bn, tb)} ${scene.id} imagens-only (bootstrap PNG, sem Veo) (${done}/${plan.scenes.length})`,
        ),
      );
      upsertMediaBlock(input.projectId, bn, { renders_done_count: done });
      continue;
    }

    if (v.type === "image") {
      const imgResult = await renderSceneImage(
        {
          projectId: input.projectId,
          blockNumber: bn,
          shotId: scene.id,
          prompt: hfPrompt,
          outPathNoExt: path.join(input.rendersDir, scene.id),
          referenceImageUrl,
          flags: input.imageFlags,
        },
        blockBatchId
      );
      if (imgResult.queued) {
        hfJobTotal += 1;
        const refNote =
          visualModality === "wojak" && referenceImageUrl
            ? `, ref ${path.basename(String(referenceImageUrl))}`
            : "";
        console.log(
          chalk.dim(
            `  ${blockTag(bn, tb)} Imagem enfileirada (google_batch${refNote}): ${scene.id} (${imgResult.provider})`
          )
        );
        addProjectLog(input.projectId, "imagens_videos", "info", `Job imagem enfileirado bloco ${bn} cena ${scene.id}`, {
          provider: imgResult.provider,
          batchId: imgResult.batchId,
        });
      } else if (imgResult.localPath) {
        lastImageRefLocal = imgResult.localPath;
        lastImageRef = imgResult.localPath;
        done += 1;
        console.log(
          chalk.green(
            `  ${blockTag(bn, tb)} ${scene.id} concluido → ${path.basename(imgResult.localPath)} (${done}/${plan.scenes.length})`
          )
        );
        addProjectLog(input.projectId, "imagens_videos", "info", `Render imagem bloco ${bn} cena ${scene.id}`, {
          mediaPath: imgResult.localPath,
          provider: imgResult.provider,
        });
        upsertMediaBlock(input.projectId, bn, { renders_done_count: done });
      }
      continue;
    }

    if (useHfVideoQueue) {
      try {
        const enq = await enqueueRenderShotTracked(input.projectId, bn, scene.id, {
          type: v.type,
          prompt: hfPrompt,
          outPathNoExt: path.join(input.rendersDir, scene.id),
          referenceImageUrl,
        });
        hfJobTotal += 1;
        console.log(chalk.dim(`  ${blockTag(bn, tb)} HF enfileirado: ${scene.id} (${v.type}) → ${enq.hfJobId.slice(0, 8)}...`));
        addProjectLog(input.projectId, "imagens_videos", "info", `HF job enfileirado bloco ${bn} cena ${scene.id}`, {
          hfJobId: enq.hfJobId,
        });
      } catch (hfEnqErr) {
        const msg = hfEnqErr instanceof Error ? hfEnqErr.message : String(hfEnqErr);
        console.log(chalk.yellow(`  ${blockTag(bn, tb)} HF nao enfileirou ${scene.id} (video): ${msg} — tentando sync (Veo/Magnific)...`));
        addProjectLog(input.projectId, "imagens_videos", "info", `HF enqueue falhou bloco ${bn} cena ${scene.id}`, {
          error: msg,
        });
        try {
          const out = await generateAndRenderShot({
            type: "video",
            prompt: hfPrompt,
            outPathNoExt: path.join(input.rendersDir, scene.id),
            referenceImageUrl,
            magnificKeywords: v.search_keywords,
          });
          done += 1;
          console.log(
            chalk.green(
              `  ${blockTag(bn, tb)} ${scene.id} (${out.provider ?? "?"}) → ${path.basename(out.localPath)} (${done}/${plan.scenes.length})`
            )
          );
          addProjectLog(input.projectId, "imagens_videos", "info", `Render video fallback bloco ${bn} cena ${scene.id}`, {
            mediaPath: out.localPath,
            provider: out.provider,
          });
          upsertMediaBlock(input.projectId, bn, { renders_done_count: done });
        } catch (syncErr) {
          const sMsg = syncErr instanceof Error ? syncErr.message : String(syncErr);
          console.log(chalk.red(`  ${blockTag(bn, tb)} Fallback video ${scene.id} falhou: ${sMsg}`));
        }
      }
    } else {
      const videoRef =
        visualModality === "wojak" && v.type === "video" ? undefined : referenceImageUrl;
      if (visualModality === "wojak" && v.type === "video") {
        console.log(
          chalk.dim(`  ${blockTag(bn, tb)} Veo ${scene.id}: text-to-video (sem ref PNG; bootstrap em disco se montagem precisar)`)
        );
      } else {
        console.log(chalk.dim(`  ${blockTag(bn, tb)} Renderizando ${scene.id} (${v.type}, --wait)...`));
      }
      const out = await generateAndRenderShot({
        type: v.type,
        prompt: v.type === "video" && visualModality === "wojak" ? veoPrompt : hfPrompt,
        outPathNoExt: path.join(input.rendersDir, scene.id),
        referenceImageUrl: videoRef,
        magnificKeywords: v.search_keywords,
      });
      done += 1;
      console.log(chalk.green(`  ${blockTag(bn, tb)} ${scene.id} concluido → ${path.basename(out.localPath)} (${done}/${plan.scenes.length})`));
      addProjectLog(input.projectId, "imagens_videos", "info", `Render concluido bloco ${bn} cena ${scene.id}`, {
        mediaPath: out.localPath,
        provider: out.provider,
      });
      upsertMediaBlock(input.projectId, bn, { renders_done_count: done });
    }
  }

  if (!input.enqueueOnly) {
    if (isGoogleBatchMode(input.imageFlags) && batchIds.length > 0) {
      await flushPendingGoogleBatches(batchIds);
    }
    if (delivery === "local_batch" && batchIds.length > 0) {
      await flushPendingLocalBatches(batchIds);
    }
  }

  const asyncQueue = imagensUsesAsyncQueue({ imageFlags: input.imageFlags }) || hfJobTotal > 0;
  if (!asyncQueue) {
    upsertMediaBlock(input.projectId, input.blockNumber, {
      renders_status: "success",
      renders_done_count: done,
      finished_at: new Date().toISOString(),
    });
  }

  return {
    hfJobTotal,
    sceneCount: plan.scenes.length,
    doneSync: done,
    planImages,
    planVideos,
  };
}

export async function runImagensVideos(project: ProjectRow, avatarPath?: string, limits?: Step3Limits, opts?: ImagensVideosOptions): Promise<void> {
  const projectId = Number(project.id);
  const totalBlocos = Number(project.total_blocos);
  const imagesDir = path.join(String(project.project_path), "03 - Imagens e Videos");
  const roteiroDir = path.join(String(project.project_path), "01 - Roteiro");
  const promptBase = await fs.readFile(PROMPT_MATRIX02_PATH, "utf-8");

  assertImagensPhaseRequiresV2(opts);

  updateProjectAnyStageStatus(projectId, "status_imagens_videos", "processing");
  const asyncQueue = imagensUsesAsyncQueue(opts);
  if (opts?.planOnly) {
    console.log(chalk.bold.cyan(`Step 3 — plan-only (${totalBlocos} blocos): so Claude → blockNN.assets.json`));
    addProjectLog(projectId, "imagens_videos", "info", "Step 3 plan-only (schema 2.0)");
  } else if (opts?.enqueueOnly) {
    console.log(
      chalk.bold.cyan(
        `Step 3 — enqueue-only (${totalBlocos} blocos): stock/filas; submit Google no fim (1 batch/bloco)`
      )
    );
    addProjectLog(projectId, "imagens_videos", "info", "Step 3 enqueue-only; submit batch diferido no fim");
  } else {
    console.log(
      chalk.bold.cyan(
        asyncQueue
          ? `Step 3 — modo assincrono (${totalBlocos} blocos). Jobs enfileirados; depois rode image:sync`
          : `Step 3 — modo sincrono (${totalBlocos} blocos)`
      )
    );
    addProjectLog(
      projectId,
      "imagens_videos",
      "info",
      asyncQueue
        ? "Iniciando step 3 (direcao + producao) — modo assincrono; depois rode gentube image:sync"
        : "Iniciando step 3 (direcao + producao)"
    );
  }

  let grandTotalJobs = 0;
  for (let i = 1; i <= totalBlocos; i += 1) {
    if (shouldSkipImagensBlock(projectId, i, opts)) {
      const skipReason = opts?.planOnly ? "plano ja existe" : opts?.enqueueOnly ? "ja enfileirado/concluido" : "ja concluido";
      console.log(chalk.dim(`${blockTag(i, totalBlocos)} Saltando bloco (${skipReason})`));
      addProjectLog(projectId, "imagens_videos", "info", `Bloco ${i} saltado (${skipReason})`);
      continue;
    }
    const maxVideos = limits ? (i === 1 ? limits.maxVideosBlock1 : limits.maxVideosOtherBlocks) : 999;
    const maxImages = limits ? (i === 1 ? limits.maxImagesBlock1 : limits.maxImagesOtherBlocks) : 999;
    const block = String(i).padStart(2, "0");
    const scriptPath = path.join(roteiroDir, `block${block}.md`);
    const jsonPath = path.join(imagesDir, `block${block}.assets.json`);
    const rendersDir = path.join(imagesDir, "renders", `block${block}`);
    const startedAt = new Date().toISOString();

    console.log(chalk.cyan(`\n${blockTag(i, totalBlocos)} Gerando plano de direcao (Claude)...`));
    try {
      const scriptText = await fs.readFile(scriptPath, "utf-8");
      upsertMediaBlock(projectId, i, { plan_status: "processing", started_at: startedAt, plan_error: null });

      const stockRatio = resolveStockRatioForBlock(i);

      if (scenePlanV2Enabled(opts)) {
        if (imagensUsesAsyncQueue(opts) && forceScenePlanVizRegen()) {
          deleteHfCliJobsForBlock(projectId, i);
          deleteImageJobsForBlock(projectId, i);
        }
        const r = await imagensBlockPlanAndRenderV2({
          projectId,
          blockNumber: i,
          totalBlocos,
          project,
          scriptText,
          jsonPath,
          rendersDir,
          avatarPath,
          limits,
          stockRatio,
          manualCaptureSignals: [],
          imageFlags: opts?.imageFlags,
          planOnly: opts?.planOnly,
          enqueueOnly: opts?.enqueueOnly,
        });
        console.log(
          chalk.green(
            `${blockTag(i, totalBlocos)} Plano v2: ${r.planImages} imagens + ${r.planVideos} videos (${r.sceneCount} cenas) → ${path.basename(jsonPath)}`
          )
        );
        addProjectLog(projectId, "imagens_videos", "info", `Bloco ${i}: plano por cenas (schema 2.0) gravado`);
        if (imagensUsesAsyncQueue(opts) || r.hfJobTotal > 0) {
          upsertMediaBlock(projectId, i, {
            renders_total_count: r.hfJobTotal,
            renders_done_count: 0,
            renders_status: "awaiting_hf",
            finished_at: null,
          });
          grandTotalJobs += r.hfJobTotal;
          console.log(chalk.yellow(`${blockTag(i, totalBlocos)} ${r.hfJobTotal} jobs enfileirados (total acumulado: ${grandTotalJobs})`));
          addProjectLog(
            projectId,
            "imagens_videos",
            "info",
            `Bloco ${i}: jobs enfileirados. Rode: npm run gentube -- image:sync --project ${projectId}`
          );
        } else {
          console.log(chalk.green(`${blockTag(i, totalBlocos)} Bloco finalizado (${r.doneSync} renders)`));
          addProjectLog(projectId, "imagens_videos", "info", `Bloco ${i} finalizado no step 3 (plano v2)`);
        }
        continue;
      }

      const rawPlan = await generateAssetsPlanJson({
        promptBase,
        blockNumber: i,
        totalBlocks: totalBlocos,
        scriptText,
        audience: String(project.audience),
        avatarPath,
        maxVideos,
        maxImages,
        stockRatio,
      });
      const plan = parseAndValidateAssetsPlan(rawPlan, i, limits);
      await fs.mkdir(path.dirname(jsonPath), { recursive: true });
      await fs.writeFile(jsonPath, JSON.stringify(plan, null, 2), "utf-8");

      const planImages = plan.shots.filter((s) => s.type === "image").length;
      const planVideos = plan.shots.filter((s) => s.type === "video").length;
      console.log(
        chalk.green(`${blockTag(i, totalBlocos)} Plano: ${planImages} imagens + ${planVideos} videos → ${path.basename(jsonPath)}`)
      );

      upsertMediaBlock(projectId, i, {
        assets_json_path: jsonPath,
        plan_status: "success",
        renders_status: "processing",
        renders_total_count: plan.shots.length,
        renders_done_count: 0,
      });

      if (GENTUBE_HF_ASYNC) {
        deleteHfCliJobsForBlock(projectId, i);
      }

      await fs.mkdir(rendersDir, { recursive: true });
      let done = 0;
      let hfJobTotal = 0;
      let lastImageRef: string | undefined;
      let lastImageRefLocal: string | undefined;
      const avatarRef =
        avatarPath && String(avatarPath).trim()
          ? /^https?:\/\//i.test(String(avatarPath))
            ? String(avatarPath).trim()
            : path.resolve(String(avatarPath))
          : undefined;
      let stockDone = 0;
      for (const shot of plan.shots) {
        if (shot.source === "stock" && shot.search_keywords) {
          console.log(chalk.dim(`  ${blockTag(i, totalBlocos)} Stock ${shot.id} (${shot.type}): "${shot.search_keywords}"...`));
          try {
            const localPath = await searchAndDownload({
              type: shot.type,
              keywords: shot.search_keywords,
              destPathNoExt: path.join(rendersDir, shot.id),
            });
            stockDone += 1;
            done += 1;
            console.log(chalk.green(`  ${blockTag(i, totalBlocos)} Stock baixado: ${shot.id} → ${path.basename(localPath)}`));
            addProjectLog(projectId, "imagens_videos", "info", `Stock baixado bloco ${i} shot ${shot.id}`, {
              mediaPath: localPath,
              keywords: shot.search_keywords,
            });
            upsertMediaBlock(projectId, i, { renders_done_count: done });
          } catch (stockErr) {
            const msg = stockErr instanceof Error ? stockErr.message : "Erro stock";
            console.log(chalk.yellow(`  ${blockTag(i, totalBlocos)} Stock falhou para ${shot.id}: ${msg} — fallback para IA`));
            addProjectLog(projectId, "imagens_videos", "info", `Stock falhou bloco ${i} shot ${shot.id}, fallback IA`, { error: msg });
            shot.source = "ai_generated";
          }
        }

        if (shot.source === "ai_generated") {
          let referenceImageUrl = shot.character_required ? avatarRef : undefined;

          if (shot.type === "video" && !referenceImageUrl) {
            if (GENTUBE_HF_ASYNC) {
              referenceImageUrl = avatarRef ?? lastImageRefLocal;
            } else {
              referenceImageUrl = lastImageRef;
            }
          }
          if (shot.type === "video" && !referenceImageUrl) {
            if (GENTUBE_HF_ASYNC) {
              console.log(chalk.dim(`  ${blockTag(i, totalBlocos)} Bootstrap sincrono para video ${shot.id} (--wait)...`));
              const bootstrap = await generateAndRenderShot({
                type: "image",
                prompt: shot.description,
                outPathNoExt: path.join(rendersDir, `${shot.id}__bootstrap`),
                referenceImageUrl: avatarRef,
              });
              lastImageRefLocal = bootstrap.localPath;
              referenceImageUrl = bootstrap.localPath;
              console.log(chalk.dim(`  ${blockTag(i, totalBlocos)} Bootstrap pronto → ${path.basename(bootstrap.localPath)}`));
              addProjectLog(projectId, "imagens_videos", "info", `Bootstrap sincrono para video ${shot.id}`, {
                mediaPath: bootstrap.localPath,
              });
            } else {
              console.log(chalk.dim(`  ${blockTag(i, totalBlocos)} Bootstrap img para video ${shot.id} (--wait)...`));
              const bootstrap = await generateAndRenderShot({
                type: "image",
                prompt: shot.description,
                outPathNoExt: path.join(rendersDir, `${shot.id}__bootstrap`),
                referenceImageUrl: avatarRef,
              });
              lastImageRef = bootstrap.mediaUrl;
              referenceImageUrl = bootstrap.mediaUrl;
              addProjectLog(projectId, "imagens_videos", "info", `Bootstrap de imagem para video ${shot.id}`, {
                mediaPath: bootstrap.localPath,
              });
            }
          }

          if (GENTUBE_HF_ASYNC) {
            const enq = await enqueueRenderShotTracked(projectId, i, shot.id, {
              type: shot.type,
              prompt: shot.description,
              outPathNoExt: path.join(rendersDir, shot.id),
              referenceImageUrl,
            });
            hfJobTotal += 1;
            console.log(
              chalk.dim(`  ${blockTag(i, totalBlocos)} HF enfileirado: ${shot.id} (${shot.type}) → ${enq.hfJobId.slice(0, 8)}...`)
            );
            addProjectLog(projectId, "imagens_videos", "info", `HF job enfileirado bloco ${i} shot ${shot.id}`, {
              hfJobId: enq.hfJobId,
            });
          } else {
            console.log(chalk.dim(`  ${blockTag(i, totalBlocos)} Renderizando ${shot.id} (${shot.type}, --wait)...`));
            const out = await generateAndRenderShot({
              type: shot.type,
              prompt: shot.description,
              outPathNoExt: path.join(rendersDir, shot.id),
              referenceImageUrl,
              magnificKeywords: shot.search_keywords,
            });
            if (shot.type === "image") lastImageRef = out.mediaUrl ?? out.localPath;
            done += 1;
            console.log(chalk.green(`  ${blockTag(i, totalBlocos)} ${shot.id} concluido → ${path.basename(out.localPath)} (${done}/${plan.shots.length})`));
            addProjectLog(projectId, "imagens_videos", "info", `Render concluido bloco ${i} shot ${shot.id}`, {
              mediaPath: out.localPath,
              provider: out.provider,
            });
            upsertMediaBlock(projectId, i, { renders_done_count: done });
          }
        }
      }

      if (GENTUBE_HF_ASYNC) {
        upsertMediaBlock(projectId, i, {
          renders_total_count: hfJobTotal,
          renders_done_count: 0,
          renders_status: "awaiting_hf",
          finished_at: null,
        });
        grandTotalJobs += hfJobTotal;
        console.log(chalk.yellow(`${blockTag(i, totalBlocos)} ${hfJobTotal} jobs HF enfileirados (total acumulado: ${grandTotalJobs})`));
        addProjectLog(
          projectId,
          "imagens_videos",
          "info",
          `Bloco ${i}: jobs HF enfileirados. Rode: npm run gentube -- higgsfield:sync --project ${projectId}`
        );
      } else {
        upsertMediaBlock(projectId, i, {
          renders_status: "success",
          finished_at: new Date().toISOString(),
        });
        console.log(chalk.green(`${blockTag(i, totalBlocos)} Bloco finalizado (${done} renders)`));
        addProjectLog(projectId, "imagens_videos", "info", `Bloco ${i} finalizado no step 3`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      console.log(chalk.red(`${blockTag(i, totalBlocos)} ERRO step 3: ${message}`));
      upsertMediaBlock(projectId, i, {
        plan_status: "error",
        plan_error: message,
        renders_status: "error",
        finished_at: new Date().toISOString(),
      });
      addProjectLog(projectId, "imagens_videos", "error", `Falha no bloco ${i} do step 3`, { error: message });
      recomputeImagensVideosStage(projectId, totalBlocos);
      throw error;
    }
  }

  await finalizeDeferredBatchSubmits(projectId, opts?.imageFlags, opts);

  if (!opts?.planOnly && imagensUsesAsyncQueue(opts) && grandTotalJobs > 0) {
    const syncHint = opts?.enqueueOnly
      ? "image:sync (batches ja submetidos no fim do enqueue-only)"
      : "image:sync";
    console.log(
      chalk.bold.yellow(
        `\nStep 3 concluido: ${grandTotalJobs} jobs enfileirados. Rode:\n` +
          `  npm run gentube -- ${syncHint} --project ${projectId} --watch --interval 30s`
      )
    );
  }
  if (opts?.planOnly) {
    console.log(
      chalk.bold.green(
        `\nPlan-only concluido. Proximo passo:\n` +
          `  npm run gentube -- run-step --project ${projectId} --step imagens --scene-plan-v2 --google-batch-mode --enqueue-only`
      )
    );
  }
  recomputeImagensVideosStage(projectId, totalBlocos);
}

export async function runImagensVideosBlock(
  project: ProjectRow,
  blockNumber: number,
  avatarPath?: string,
  limits?: Step3Limits,
  opts?: ImagensVideosOptions,
): Promise<void> {
  const projectId = Number(project.id);
  const totalBlocos = Number(project.total_blocos);
  if (blockNumber < 1 || blockNumber > totalBlocos) {
    throw new Error(`Bloco invalido: ${blockNumber} (esperado entre 1 e ${totalBlocos})`);
  }
  assertImagensPhaseRequiresV2(opts);

  if (shouldSkipImagensBlock(projectId, blockNumber, opts)) {
    console.log(chalk.dim(`${blockTag(blockNumber, totalBlocos)} Bloco saltado (ja concluido ou plano existente)`));
    addProjectLog(projectId, "imagens_videos", "info", `Bloco ${blockNumber} saltado`);
    recomputeImagensVideosStage(projectId, totalBlocos);
    return;
  }
  const imagesDir = path.join(String(project.project_path), "03 - Imagens e Videos");
  const roteiroDir = path.join(String(project.project_path), "01 - Roteiro");
  const promptBase = await fs.readFile(PROMPT_MATRIX02_PATH, "utf-8");
  const block = String(blockNumber).padStart(2, "0");
  const scriptPath = path.join(roteiroDir, `block${block}.md`);
  const jsonPath = path.join(imagesDir, `block${block}.assets.json`);
  const rendersDir = path.join(imagesDir, "renders", `block${block}`);
  const startedAt = new Date().toISOString();

  const asyncQueue = imagensUsesAsyncQueue(opts);
  updateProjectAnyStageStatus(projectId, "status_imagens_videos", "processing");
  console.log(
    chalk.bold.cyan(
      asyncQueue
        ? `Step 3 — bloco ${blockNumber} (modo assincrono)`
        : `Step 3 — bloco ${blockNumber} (modo sincrono)`
    )
  );
  addProjectLog(
    projectId,
    "imagens_videos",
    "info",
    asyncQueue
      ? `Reprocessando bloco ${blockNumber} (assincrono; depois image:sync)`
      : `Reprocessando bloco ${blockNumber} do step 3`
  );

  try {
    console.log(chalk.cyan(`${blockTag(blockNumber, totalBlocos)} Gerando plano de direcao (Claude)...`));
    const scriptText = await fs.readFile(scriptPath, "utf-8");
    upsertMediaBlock(projectId, blockNumber, { plan_status: "processing", started_at: startedAt, plan_error: null });
    const stockRatio = resolveStockRatioForBlock(blockNumber);

    if (scenePlanV2Enabled(opts)) {
      if (asyncQueue && forceScenePlanVizRegen()) {
        deleteHfCliJobsForBlock(projectId, blockNumber);
        deleteImageJobsForBlock(projectId, blockNumber);
      }
      const r = await imagensBlockPlanAndRenderV2({
        projectId,
        blockNumber,
        totalBlocos,
        project,
        scriptText,
        jsonPath,
        rendersDir,
        avatarPath,
        limits,
        stockRatio,
        manualCaptureSignals: [],
        imageFlags: opts?.imageFlags,
        planOnly: opts?.planOnly,
        enqueueOnly: opts?.enqueueOnly,
      });
      console.log(
        chalk.green(
          `${blockTag(blockNumber, totalBlocos)} Plano v2: ${r.planImages} imagens + ${r.planVideos} videos (${r.sceneCount} cenas)`
        )
      );
      await finalizeDeferredBatchSubmits(projectId, opts?.imageFlags, opts);
      if (asyncQueue || r.hfJobTotal > 0) {
        const pendingHf = countHfCliJobsByBlockOutcome(projectId, blockNumber, "pending");
        const pendingImg = countImageJobsByBlockOutcome(projectId, blockNumber, "pending");
        upsertMediaBlock(projectId, blockNumber, {
          renders_total_count: Math.max(r.hfJobTotal, pendingHf + pendingImg),
          renders_status: "awaiting_hf",
          finished_at: null,
        });
        console.log(chalk.yellow(`${blockTag(blockNumber, totalBlocos)} ${r.hfJobTotal} jobs enfileirados`));
        console.log(
          chalk.bold.yellow(`Rode: npm run gentube -- image:sync --project ${projectId} --watch --interval 30s`)
        );
        addProjectLog(
          projectId,
          "imagens_videos",
          "info",
          `Bloco ${blockNumber}: jobs enfileirados. Rode: npm run gentube -- image:sync --project ${projectId}`
        );
      } else {
        console.log(chalk.green(`${blockTag(blockNumber, totalBlocos)} Bloco finalizado (${r.doneSync} renders)`));
      }
      recomputeImagensVideosStage(projectId, totalBlocos);
      return;
    }

    const rawPlan = await generateAssetsPlanJson({
      promptBase,
      blockNumber,
      totalBlocks: totalBlocos,
      scriptText,
      audience: String(project.audience),
      avatarPath,
      maxVideos: limits ? (blockNumber === 1 ? limits.maxVideosBlock1 : limits.maxVideosOtherBlocks) : 999,
      maxImages: limits ? (blockNumber === 1 ? limits.maxImagesBlock1 : limits.maxImagesOtherBlocks) : 999,
      stockRatio,
    });
    const plan = parseAndValidateAssetsPlan(rawPlan, blockNumber, limits);
    await fs.mkdir(path.dirname(jsonPath), { recursive: true });
    await fs.writeFile(jsonPath, JSON.stringify(plan, null, 2), "utf-8");

    const planImages = plan.shots.filter((s) => s.type === "image").length;
    const planVideos = plan.shots.filter((s) => s.type === "video").length;
    console.log(chalk.green(`${blockTag(blockNumber, totalBlocos)} Plano: ${planImages} imagens + ${planVideos} videos`));

    upsertMediaBlock(projectId, blockNumber, {
      assets_json_path: jsonPath,
      plan_status: "success",
      renders_status: "processing",
      renders_total_count: plan.shots.length,
      renders_done_count: 0,
    });

    if (GENTUBE_HF_ASYNC) {
      deleteHfCliJobsForBlock(projectId, blockNumber);
    }

    await fs.mkdir(rendersDir, { recursive: true });
    let done = 0;
    let hfJobTotal = 0;
    let lastImageRef: string | undefined;
    let lastImageRefLocal: string | undefined;
    const avatarRef =
      avatarPath && String(avatarPath).trim()
        ? /^https?:\/\//i.test(String(avatarPath))
          ? String(avatarPath).trim()
          : path.resolve(String(avatarPath))
        : undefined;
    for (const shot of plan.shots) {
      if (shot.source === "stock" && shot.search_keywords) {
        console.log(chalk.dim(`  ${blockTag(blockNumber, totalBlocos)} Stock ${shot.id} (${shot.type}): "${shot.search_keywords}"...`));
        try {
          const localPath = await searchAndDownload({
            type: shot.type,
            keywords: shot.search_keywords,
            destPathNoExt: path.join(rendersDir, shot.id),
          });
          done += 1;
          console.log(chalk.green(`  ${blockTag(blockNumber, totalBlocos)} Stock baixado: ${shot.id} → ${path.basename(localPath)}`));
          addProjectLog(projectId, "imagens_videos", "info", `Stock baixado bloco ${blockNumber} shot ${shot.id}`, {
            mediaPath: localPath,
            keywords: shot.search_keywords,
          });
          upsertMediaBlock(projectId, blockNumber, { renders_done_count: done });
        } catch (stockErr) {
          const msg = stockErr instanceof Error ? stockErr.message : "Erro stock";
          console.log(chalk.yellow(`  ${blockTag(blockNumber, totalBlocos)} Stock falhou para ${shot.id}: ${msg} — fallback para IA`));
          addProjectLog(projectId, "imagens_videos", "info", `Stock falhou bloco ${blockNumber} shot ${shot.id}, fallback IA`, { error: msg });
          shot.source = "ai_generated";
        }
      }

      if (shot.source === "ai_generated") {
        let referenceImageUrl = shot.character_required ? avatarRef : undefined;
        if (shot.type === "video" && !referenceImageUrl) {
          if (GENTUBE_HF_ASYNC) {
            referenceImageUrl = avatarRef ?? lastImageRefLocal;
          } else {
            referenceImageUrl = lastImageRef;
          }
        }
        if (shot.type === "video" && !referenceImageUrl) {
          if (GENTUBE_HF_ASYNC) {
            console.log(chalk.dim(`  ${blockTag(blockNumber, totalBlocos)} Bootstrap sincrono para video ${shot.id} (--wait)...`));
            const bootstrap = await generateAndRenderShot({
              type: "image",
              prompt: shot.description,
              outPathNoExt: path.join(rendersDir, `${shot.id}__bootstrap`),
              referenceImageUrl: avatarRef,
            });
            lastImageRefLocal = bootstrap.localPath;
            referenceImageUrl = bootstrap.localPath;
            console.log(chalk.dim(`  ${blockTag(blockNumber, totalBlocos)} Bootstrap pronto → ${path.basename(bootstrap.localPath)}`));
          } else {
            console.log(chalk.dim(`  ${blockTag(blockNumber, totalBlocos)} Bootstrap img para video ${shot.id} (--wait)...`));
            const bootstrap = await generateAndRenderShot({
              type: "image",
              prompt: shot.description,
              outPathNoExt: path.join(rendersDir, `${shot.id}__bootstrap`),
              referenceImageUrl: avatarRef,
            });
            lastImageRef = bootstrap.mediaUrl;
            referenceImageUrl = bootstrap.mediaUrl;
          }
        }
        if (GENTUBE_HF_ASYNC) {
          const enq = await enqueueRenderShotTracked(projectId, blockNumber, shot.id, {
            type: shot.type,
            prompt: shot.description,
            outPathNoExt: path.join(rendersDir, shot.id),
            referenceImageUrl,
          });
          hfJobTotal += 1;
          console.log(chalk.dim(`  ${blockTag(blockNumber, totalBlocos)} HF enfileirado: ${shot.id} (${shot.type}) → ${enq.hfJobId.slice(0, 8)}...`));
        } else {
          console.log(chalk.dim(`  ${blockTag(blockNumber, totalBlocos)} Renderizando ${shot.id} (${shot.type}, --wait)...`));
          const out = await generateAndRenderShot({
            type: shot.type,
            prompt: shot.description,
            outPathNoExt: path.join(rendersDir, shot.id),
            referenceImageUrl,
            magnificKeywords: shot.search_keywords,
          });
          if (shot.type === "image") lastImageRef = out.mediaUrl ?? out.localPath;
          done += 1;
          console.log(chalk.green(`  ${blockTag(blockNumber, totalBlocos)} ${shot.id} concluido (${done}/${plan.shots.length})`));
          upsertMediaBlock(projectId, blockNumber, { renders_done_count: done });
        }
      }
    }

    if (GENTUBE_HF_ASYNC) {
      upsertMediaBlock(projectId, blockNumber, {
        renders_total_count: hfJobTotal,
        renders_done_count: 0,
        renders_status: "awaiting_hf",
        finished_at: null,
      });
      console.log(chalk.yellow(`${blockTag(blockNumber, totalBlocos)} ${hfJobTotal} jobs HF enfileirados`));
      console.log(
        chalk.bold.yellow(`Rode: npm run gentube -- higgsfield:sync --project ${projectId} --watch --interval 30s`)
      );
      addProjectLog(
        projectId,
        "imagens_videos",
        "info",
        `Bloco ${blockNumber}: jobs HF enfileirados. Rode: npm run gentube -- higgsfield:sync --project ${projectId}`
      );
    } else {
      upsertMediaBlock(projectId, blockNumber, { renders_status: "success", finished_at: new Date().toISOString() });
      console.log(chalk.green(`${blockTag(blockNumber, totalBlocos)} Bloco finalizado (${done} renders)`));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    console.log(chalk.red(`${blockTag(blockNumber, totalBlocos)} ERRO step 3: ${message}`));
    upsertMediaBlock(projectId, blockNumber, {
      plan_status: "error",
      plan_error: message,
      renders_status: "error",
      finished_at: new Date().toISOString(),
    });
    addProjectLog(projectId, "imagens_videos", "error", `Falha no bloco ${blockNumber} do step 3`, { error: message });
    recomputeImagensVideosStage(projectId, totalBlocos);
    throw error;
  }

  recomputeImagensVideosStage(projectId, totalBlocos);
}

export async function runThumbnails(
  project: ProjectRow,
  opts: {
    referenceUrl?: string;
    avatarPath?: string;
    count: number;
    prompt?: string;
    imageFlags?: ImageRunFlags;
  }
): Promise<void> {
  const projectId = Number(project.id);
  const thumbnailsDir = path.join(String(project.project_path), "04 - Thumbnails");
  const modelagemDir = path.join(String(project.project_path), "05 - Modelagem");

  updateProjectAnyStageStatus(projectId, "status_thumbnails", "processing");
  addProjectLog(projectId, "thumbnails", "info", "Iniciando geracao de thumbnails");

  let referenceImagePath: string | undefined;

  if (opts.referenceUrl) {
    const videoId = extractVideoId(opts.referenceUrl);
    console.log(chalk.cyan(`Thumbnail de referencia: video ID = ${videoId}`));
    console.log(chalk.dim(`URL: https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`));

    referenceImagePath = await downloadYoutubeThumbnail(videoId, modelagemDir);
    console.log(chalk.green(`Referencia baixada → ${path.basename(referenceImagePath)}`));
    addProjectLog(projectId, "thumbnails", "info", `Thumbnail de referencia baixada`, {
      videoId,
      path: referenceImagePath,
    });
  } else {
    console.log(chalk.cyan("Sem referencia — thumbnails geradas apenas com prompt + avatar"));
  }

  const avatarRef = opts.avatarPath?.trim()
    ? /^https?:\/\//i.test(opts.avatarPath)
      ? opts.avatarPath.trim()
      : path.resolve(opts.avatarPath)
    : undefined;

  const imageFiles: string[] = [];
  if (referenceImagePath) imageFiles.push(referenceImagePath);
  if (avatarRef) imageFiles.push(avatarRef);

  const prompt =
    opts.prompt?.trim() ||
    `generate a new thumbnail image for my youtube video with title "${String(project.titulo)}" based on the image I am sharing with you here`;

  console.log(chalk.dim(`Prompt: ${prompt}`));
  if (imageFiles.length > 0) {
    console.log(chalk.dim(`Imagens: ${imageFiles.map((f) => path.basename(f)).join(", ")}`));
  }

  await fs.mkdir(thumbnailsDir, { recursive: true });

  const delivery = resolveImageDelivery(opts.imageFlags);
  const thumbBatchId =
    delivery === "google_batch" || delivery === "local_batch" ? crypto.randomUUID() : undefined;
  const batchIds: string[] = thumbBatchId ? [thumbBatchId] : [];
  const thumbRef = referenceImagePath ?? avatarRef;
  const useLegacyHfThumb =
    imageFiles.length > 1 && delivery === "sync" && !isGoogleBatchMode(opts.imageFlags) && GENTUBE_HF_ASYNC;

  const generated: string[] = [];
  let queuedCount = 0;
  for (let i = 1; i <= opts.count; i += 1) {
    const tag = chalk.dim(`[thumb ${i}/${opts.count}]`);
    console.log(chalk.cyan(`${tag} Gerando thumbnail...`));

    try {
      const suffix = referenceImagePath ? "ref" : "gen";
      const shotId = `thumb_${suffix}_${String(i).padStart(2, "0")}`;
      const outPathNoExt = path.join(thumbnailsDir, shotId);

      if (useLegacyHfThumb) {
        const hfJobId = await enqueueThumbnailCli({ prompt, imageFiles });
        insertHfCliJob({
          projectId,
          blockNumber: 0,
          shotId,
          assetType: "image",
          outPathNoExt,
          hfJobId,
        });
        console.log(chalk.dim(`${tag} HF enfileirado → ${hfJobId.slice(0, 8)}...`));
        addProjectLog(projectId, "thumbnails", "info", `HF job enfileirado thumb #${i}`, { hfJobId });
        generated.push(shotId);
        queuedCount += 1;
      } else {
        const result = await renderSceneImage(
          {
            projectId,
            blockNumber: 0,
            shotId,
            prompt,
            outPathNoExt,
            referenceImageUrl: thumbRef,
            flags: opts.imageFlags,
          },
          thumbBatchId
        );
        if (result.queued) {
          queuedCount += 1;
          generated.push(shotId);
          console.log(chalk.dim(`${tag} enfileirado (${result.provider})`));
          addProjectLog(projectId, "thumbnails", "info", `Thumb #${i} enfileirada`, { provider: result.provider });
        } else if (result.localPath) {
          console.log(chalk.green(`${tag} Thumbnail salva → ${path.basename(result.localPath)}`));
          addProjectLog(projectId, "thumbnails", "info", `Thumbnail #${i} gerada`, { path: result.localPath });
          generated.push(result.localPath);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      console.log(chalk.red(`${tag} ERRO thumbnail: ${message}`));
      addProjectLog(projectId, "thumbnails", "error", `Falha na thumbnail #${i}`, { error: message });
      updateProjectAnyStageStatus(projectId, "status_thumbnails", "error");
      throw error;
    }
  }

  if (isGoogleBatchMode(opts.imageFlags) && batchIds.length > 0) {
    await flushPendingGoogleBatches(batchIds);
  }
  if (delivery === "local_batch" && batchIds.length > 0) {
    await flushPendingLocalBatches(batchIds);
  }

  const asyncThumb = queuedCount > 0 || imagensUsesAsyncQueue({ imageFlags: opts.imageFlags });
  if (asyncThumb && queuedCount > 0) {
    console.log(
      chalk.bold.yellow(
        `\nThumbnails: ${queuedCount} job(s) enfileirados. Rode:\n` +
          `  npm run gentube -- image:sync --project ${projectId} --watch --interval 30s`
      )
    );
    updateProjectAnyStageStatus(projectId, "status_thumbnails", "processing");
  } else if (!asyncThumb) {
    console.log(chalk.green.bold(`\n${generated.length} thumbnail(s) gerada(s) com sucesso.`));
    updateProjectAnyStageStatus(projectId, "status_thumbnails", "success");
  }
}

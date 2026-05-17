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
  PROMPT_VISUALIZA01_PATH,
  resolvePromptMatrixPath,
  resolveCanalVoicePath,
  ROOT_DIR,
  ROTEIRO_PREV_CONTEXT_MAX_CHARS,
  roteiroPrevContextEnabled,
  STOCK_RATIO_BLOCK1,
  STOCK_RATIO_OTHER,
} from "../config.js";
import {
  generateAssetsPlanJson,
  generateScriptBlock,
  generateSegmentationPlanJson,
  generateVisualizationPlanJson,
} from "../integrations/claude.js";
import { extractVideoId, downloadYoutubeThumbnail } from "../utils/youtube.js";
import { textToSpeechMp3 } from "../integrations/elevenlabs.js";
import {
  enqueueImageWithDefaultsCli,
  enqueueThumbnailCli,
  enqueueVideoWithDefaultsCli,
  generateImageWithDefaultsCli,
  generateThumbnailCli,
  generateVideoWithDefaultsCli,
} from "../integrations/higgsfield-cli.js";
import {
  addProjectLog,
  countBlocksByStatus,
  countHfCliJobsByBlockOutcome,
  deleteHfCliJobsForBlock,
  getMediaBlock,
  getNarrationBlock,
  getScriptBlock,
  insertHfCliJob,
  listScriptBlocks,
  recomputeImagensVideosStage,
  recomputeStageFromBlocks,
  updateProjectAnyStageStatus,
  upsertNarrationBlock,
  upsertMediaBlock,
  upsertScriptBlock,
} from "../repository.js";
import { parseAndValidateAssetsPlan } from "../utils/assets-plan.js";
import { tryConcatMp3WithFfmpeg } from "../utils/mp3-concat.js";
import {
  clearPlanParseError,
  loadVisualizationErrorResume,
  parseSegmentationJson,
  parseVisualizationMerge,
  isBlockScenesPlanV2,
  unwrapJsonFromModel,
  writePlanParseError,
} from "../utils/scenes-plan.js";
import { searchAndDownload } from "../integrations/magnific.js";
import { Step3Limits } from "../types/step3-limits.js";
import type { BlockScenesPlanV2, SceneVisualPlanV2, SegmentationPlanV2 } from "../types/scenes-plan.js";

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

async function sceneRenderOutputExists(
  rendersDir: string,
  sceneId: string,
  type: "image" | "video"
): Promise<boolean> {
  const exts = type === "image" ? [".jpg", ".jpeg", ".png", ".webp"] : [".mp4", ".mov"];
  for (const ext of exts) {
    try {
      await fs.access(path.join(rendersDir, `${sceneId}${ext}`));
      return true;
    } catch {
      /* ausente */
    }
  }
  return false;
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

/** Nao voltar a gerar plano/renders se o bloco ja esta concluido no SQLite (e, em async HF, sem jobs pendentes). */
function shouldSkipCompletedImagensBlock(projectId: number, blockNumber: number): boolean {
  const row = getMediaBlock(projectId, blockNumber);
  if (!row || row.plan_status !== "success") return false;
  if (row.renders_status === "success") return true;
  if (row.renders_status === "awaiting_hf") {
    const pending = countHfCliJobsByBlockOutcome(projectId, blockNumber, "pending");
    return pending === 0;
  }
  return false;
}

const GENTUBE_HF_ASYNC = ["1", "true", "yes"].includes(
  String(process.env.GENTUBE_HF_ASYNC ?? "").toLowerCase()
);

export type ImagensVideosOptions = { scenePlanV2?: boolean };

function scenePlanV2Enabled(opts?: ImagensVideosOptions): boolean {
  if (opts?.scenePlanV2 === true) return true;
  return ["1", "true", "yes"].includes(String(process.env.GENTUBE_SCENE_PLAN_V2 ?? "").toLowerCase());
}

function promptForSceneVisual(v: SceneVisualPlanV2): string {
  let p = v.description.trim();
  const neg = v.negative_prompt?.trim();
  if (neg) p += ` Avoid: ${neg}`;
  return p;
}

export type RoteiroPromptOptions = { promptMatrix?: string; promptCanalVoice?: string };

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

export async function runNarracao(project: ProjectRow, voiceId: string): Promise<void> {
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
    if (existingNarration?.status === "success") {
      console.log(chalk.dim(`${blockTag(blockNumber, totalBlocos)} Narracao ja concluida, pulando`));
      continue;
    }

    const startedAt = new Date().toISOString();
    const sourceText = await fs.readFile(block.file_path_md, "utf-8");
    const audioPath = path.join(narracaoDir, `block${String(blockNumber).padStart(2, "0")}.mp3`);

    console.log(chalk.cyan(`${blockTag(blockNumber, totalBlocos)} Gerando narracao...`));
    try {
      upsertNarrationBlock(projectId, blockNumber, { status: "processing", started_at: startedAt, error_message: null });
      const pad = String(blockNumber).padStart(2, "0");
      let primaryMp3Path = audioPath;

      const planV2 = await tryLoadBlockScenesPlanV2(String(project.project_path), blockNumber);
      if (planV2) {
        const blockSubDir = path.join(narracaoDir, `block${pad}`);
        await fs.mkdir(blockSubDir, { recursive: true });
        const scenePaths: string[] = [];
        for (const scene of planV2.scenes) {
          const p = path.join(blockSubDir, `${scene.id}.mp3`);
          if (await narrationSceneMp3Cached(p)) {
            console.log(chalk.dim(`${blockTag(blockNumber, totalBlocos)} Reutilizando ${scene.id}.mp3`));
            scenePaths.push(p);
            continue;
          }
          const audioBuffer = await textToSpeechMp3({ text: scene.narration_text, voiceId });
          await fs.writeFile(p, audioBuffer);
          scenePaths.push(p);
        }
        const concatOk = await tryConcatMp3WithFfmpeg(scenePaths, audioPath);
        if (!concatOk) {
          console.log(
            chalk.yellow(
              `${blockTag(blockNumber, totalBlocos)} ffmpeg ausente ou concat falhou: block${pad}.mp3 nao criado. Use os MP3 por cena em block${pad}/ (sem novo ElevenLabs).`,
            ),
          );
          primaryMp3Path = scenePaths[0]!;
        }
      } else {
        const audioBuffer = await textToSpeechMp3({ text: sourceText, voiceId });
        await fs.writeFile(audioPath, audioBuffer);
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
            chalk.green(
              `${blockTag(blockNumber, totalBlocos)} Por cena → block${pad}/ + block${pad}.mp3 (concat)`
            )
          );
        } else {
          console.log(
            chalk.green(
              `${blockTag(blockNumber, totalBlocos)} Por cena → block${pad}/ (${planV2.scenes.length} MP3); sem block${pad}.mp3 ate ter ffmpeg`
            )
          );
        }
      } else {
        console.log(chalk.green(`${blockTag(blockNumber, totalBlocos)} Audio salvo → block${pad}.mp3`));
      }
      addProjectLog(projectId, "narracao", "info", `Audio do bloco ${blockNumber} gerado com sucesso`);
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
export async function runNarracaoBlock(project: ProjectRow, voiceId: string, blockNumber: number): Promise<void> {
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

  const startedAt = new Date().toISOString();
  const sourceText = await fs.readFile(scriptRow.file_path_md, "utf-8");
  const audioPath = path.join(narracaoDir, `block${String(blockNumber).padStart(2, "0")}.mp3`);

  addProjectLog(projectId, "narracao", "info", `Reprocessando audio do bloco ${blockNumber}`);

  try {
    upsertNarrationBlock(projectId, blockNumber, { status: "processing", started_at: startedAt, error_message: null });
    const pad = String(blockNumber).padStart(2, "0");
    let primaryMp3Path = audioPath;

    const planV2 = await tryLoadBlockScenesPlanV2(String(project.project_path), blockNumber);
    if (planV2) {
      const blockSubDir = path.join(narracaoDir, `block${pad}`);
      await fs.mkdir(blockSubDir, { recursive: true });
      const scenePaths: string[] = [];
      for (const scene of planV2.scenes) {
        const p = path.join(blockSubDir, `${scene.id}.mp3`);
        if (await narrationSceneMp3Cached(p)) {
          console.log(chalk.dim(`${blockTag(blockNumber, totalBlocos)} Reutilizando ${scene.id}.mp3`));
          scenePaths.push(p);
          continue;
        }
        const audioBuffer = await textToSpeechMp3({ text: scene.narration_text, voiceId });
        await fs.writeFile(p, audioBuffer);
        scenePaths.push(p);
      }
      const concatOk = await tryConcatMp3WithFfmpeg(scenePaths, audioPath);
      if (!concatOk) {
        console.log(
          chalk.yellow(
            `${blockTag(blockNumber, totalBlocos)} ffmpeg ausente ou concat falhou: block${pad}.mp3 nao criado. Use os MP3 por cena em block${pad}/ (sem novo ElevenLabs).`,
          ),
        );
        primaryMp3Path = scenePaths[0]!;
      }
    } else {
      const audioBuffer = await textToSpeechMp3({ text: sourceText, voiceId });
      await fs.writeFile(audioPath, audioBuffer);
    }
    upsertNarrationBlock(projectId, blockNumber, {
      status: "success",
      file_path_mp3: primaryMp3Path,
      finished_at: new Date().toISOString(),
    });
    addProjectLog(projectId, "narracao", "info", `Audio do bloco ${blockNumber} gerado com sucesso`);
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
}): Promise<{ localPath: string; mediaUrl: string }> {
  const maxAttempts = 3; // inicial + 2 retries (mesmo payload)
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (params.type === "image") {
        const out = await generateImageWithDefaultsCli({
          prompt: params.prompt,
          referenceImageUrl: params.referenceImageUrl,
        });
        const localPath = await downloadMedia(out.mediaUrl, params.outPathNoExt, ".png");
        return { localPath, mediaUrl: out.mediaUrl };
      }
      const out = await generateVideoWithDefaultsCli({
        prompt: params.prompt,
        referenceImageUrl: params.referenceImageUrl ?? "",
      });
      const localPath = await downloadMedia(out.mediaUrl, params.outPathNoExt, ".mp4");
      return { localPath, mediaUrl: out.mediaUrl };
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
  const maxVideos = input.limits
    ? bn === 1
      ? input.limits.maxVideosBlock1
      : input.limits.maxVideosOtherBlocks
    : bn === 1
      ? DEFAULT_MAX_VIDEOS_BLOCK1
      : DEFAULT_MAX_VIDEOS_OTHER_BLOCKS;
  const maxImages = input.limits
    ? bn === 1
      ? input.limits.maxImagesBlock1
      : input.limits.maxImagesOtherBlocks
    : bn === 1
      ? DEFAULT_MAX_IMAGES_BLOCK1
      : DEFAULT_MAX_IMAGES_OTHER_BLOCKS;
  const maxScenes = maxVideos + maxImages;

  const forceVizRegen = forceScenePlanVizRegen();
  const existingPlan = forceVizRegen ? null : await tryLoadPlanFromAssetsJson(input.jsonPath);
  const errorResume =
    forceVizRegen || existingPlan ? null : await loadVisualizationErrorResume(input.jsonPath);

  let plan: BlockScenesPlanV2;

  if (existingPlan) {
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
    const vizPrompt = await fs.readFile(PROMPT_VISUALIZA01_PATH, "utf-8");

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
      });
      seg = await parseSegmentationWithErrorFile(
        input.jsonPath,
        rawSeg,
        input.blockNumber,
        input.totalBlocos,
        input.scriptText,
        maxScenes
      );

      rawViz = await generateVisualizationPlanJson({
        promptBase: vizPrompt,
        blockNumber: input.blockNumber,
        totalBlocks: input.totalBlocos,
        audience: String(input.project.audience),
        stockRatio: input.stockRatio,
        manualCaptureSignals: input.manualCaptureSignals,
        segmentationJson: JSON.stringify(seg, null, 2),
        maxVideos,
        maxImages,
      });
    }

    plan = await parseVisualizationWithErrorFile(
      input.jsonPath,
      rawViz,
      seg,
      input.scriptText,
      input.limits
    );

    await clearPlanParseError(input.jsonPath);
    await fs.mkdir(path.dirname(input.jsonPath), { recursive: true });
    await fs.writeFile(input.jsonPath, JSON.stringify(plan, null, 2), "utf-8");
  }

  const planImages = plan.scenes.filter((s) => s.visual.type === "image").length;
  const planVideos = plan.scenes.filter((s) => s.visual.type === "video").length;

  upsertMediaBlock(input.projectId, input.blockNumber, {
    assets_json_path: input.jsonPath,
    plan_status: "success",
    plan_error: null,
    renders_status: "processing",
    renders_total_count: plan.scenes.length,
    ...(existingPlan ? {} : { renders_done_count: 0 }),
  });

  await fs.mkdir(input.rendersDir, { recursive: true });

  let done = 0;
  let hfJobTotal = 0;
  let lastImageRef: string | undefined;
  let lastImageRefLocal: string | undefined;
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

    if (effectiveSource === "stock" && v.search_keywords?.trim()) {
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

    if (effectiveSource === "manual_capture") {
      const dest = path.join(input.rendersDir, `${scene.id}.png`);
      await fs.copyFile(MANUAL_CAPTURE_PLACEHOLDER_PATH, dest);
      done += 1;
      console.log(chalk.green(`  ${blockTag(bn, tb)} manual_capture placeholder → ${path.basename(dest)}`));
      addProjectLog(input.projectId, "imagens_videos", "info", `Placeholder manual_capture ${scene.id}`, { mediaPath: dest });
      upsertMediaBlock(input.projectId, bn, { renders_done_count: done });
      continue;
    }

    if (effectiveSource !== "ai_generated") continue;

    const hfPrompt = promptForSceneVisual(v);
    let referenceImageUrl = v.character_required ? avatarRef : undefined;

    if (v.type === "video" && !referenceImageUrl) {
      if (GENTUBE_HF_ASYNC) {
        referenceImageUrl = avatarRef ?? lastImageRefLocal;
      } else {
        referenceImageUrl = lastImageRef;
      }
    }

    if (v.type === "video" && !referenceImageUrl) {
      if (GENTUBE_HF_ASYNC) {
        console.log(chalk.dim(`  ${blockTag(bn, tb)} Bootstrap sincrono para video ${scene.id} (--wait)...`));
        const bootstrap = await generateAndRenderShot({
          type: "image",
          prompt: hfPrompt,
          outPathNoExt: path.join(input.rendersDir, `${scene.id}__bootstrap`),
          referenceImageUrl: avatarRef,
        });
        lastImageRefLocal = bootstrap.localPath;
        referenceImageUrl = bootstrap.localPath;
        console.log(chalk.dim(`  ${blockTag(bn, tb)} Bootstrap pronto → ${path.basename(bootstrap.localPath)}`));
        addProjectLog(input.projectId, "imagens_videos", "info", `Bootstrap sincrono video cena ${scene.id}`, {
          mediaPath: bootstrap.localPath,
        });
      } else {
        console.log(chalk.dim(`  ${blockTag(bn, tb)} Bootstrap img para video ${scene.id} (--wait)...`));
        const bootstrap = await generateAndRenderShot({
          type: "image",
          prompt: hfPrompt,
          outPathNoExt: path.join(input.rendersDir, `${scene.id}__bootstrap`),
          referenceImageUrl: avatarRef,
        });
        lastImageRef = bootstrap.mediaUrl;
        referenceImageUrl = bootstrap.mediaUrl;
        addProjectLog(input.projectId, "imagens_videos", "info", `Bootstrap imagem video cena ${scene.id}`, {
          mediaPath: bootstrap.localPath,
        });
      }
    }

    if (GENTUBE_HF_ASYNC) {
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
    } else {
      console.log(chalk.dim(`  ${blockTag(bn, tb)} Renderizando ${scene.id} (${v.type}, --wait)...`));
      const out = await generateAndRenderShot({
        type: v.type,
        prompt: hfPrompt,
        outPathNoExt: path.join(input.rendersDir, scene.id),
        referenceImageUrl,
      });
      if (v.type === "image") lastImageRef = out.mediaUrl;
      done += 1;
      console.log(chalk.green(`  ${blockTag(bn, tb)} ${scene.id} concluido → ${path.basename(out.localPath)} (${done}/${plan.scenes.length})`));
      addProjectLog(input.projectId, "imagens_videos", "info", `Render concluido bloco ${bn} cena ${scene.id}`, {
        mediaPath: out.localPath,
      });
      upsertMediaBlock(input.projectId, bn, { renders_done_count: done });
    }
  }

  if (!GENTUBE_HF_ASYNC) {
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

  updateProjectAnyStageStatus(projectId, "status_imagens_videos", "processing");
  console.log(
    chalk.bold.cyan(
      GENTUBE_HF_ASYNC
        ? `Step 3 — modo assincrono (${totalBlocos} blocos). Jobs serao enfileirados; depois rode higgsfield:sync`
        : `Step 3 — modo sincrono (${totalBlocos} blocos)`
    )
  );
  addProjectLog(
    projectId,
    "imagens_videos",
    "info",
    GENTUBE_HF_ASYNC
      ? "Iniciando step 3 (direcao + producao) — modo assincrono HF (GENTUBE_HF_ASYNC=1); depois rode gentube higgsfield:sync"
      : "Iniciando step 3 (direcao + producao)"
  );

  let grandTotalJobs = 0;
  for (let i = 1; i <= totalBlocos; i += 1) {
    if (shouldSkipCompletedImagensBlock(projectId, i)) {
      console.log(chalk.dim(`${blockTag(i, totalBlocos)} Step 3 completo no registo, pulando bloco`));
      addProjectLog(projectId, "imagens_videos", "info", `Bloco ${i} do step 3 saltado (ja concluido)`);
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

      const stockRatio = i === 1 ? STOCK_RATIO_BLOCK1 : STOCK_RATIO_OTHER;

      if (scenePlanV2Enabled(opts)) {
        if (GENTUBE_HF_ASYNC && forceScenePlanVizRegen()) {
          deleteHfCliJobsForBlock(projectId, i);
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
        });
        console.log(
          chalk.green(
            `${blockTag(i, totalBlocos)} Plano v2: ${r.planImages} imagens + ${r.planVideos} videos (${r.sceneCount} cenas) → ${path.basename(jsonPath)}`
          )
        );
        addProjectLog(projectId, "imagens_videos", "info", `Bloco ${i}: plano por cenas (schema 2.0) gravado`);
        if (GENTUBE_HF_ASYNC) {
          upsertMediaBlock(projectId, i, {
            renders_total_count: r.hfJobTotal,
            renders_done_count: 0,
            renders_status: "awaiting_hf",
            finished_at: null,
          });
          grandTotalJobs += r.hfJobTotal;
          console.log(chalk.yellow(`${blockTag(i, totalBlocos)} ${r.hfJobTotal} jobs HF enfileirados (total acumulado: ${grandTotalJobs})`));
          addProjectLog(
            projectId,
            "imagens_videos",
            "info",
            `Bloco ${i}: jobs HF enfileirados. Rode: npm run gentube -- higgsfield:sync --project ${projectId}`
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
            });
            if (shot.type === "image") lastImageRef = out.mediaUrl;
            done += 1;
            console.log(chalk.green(`  ${blockTag(i, totalBlocos)} ${shot.id} concluido → ${path.basename(out.localPath)} (${done}/${plan.shots.length})`));
            addProjectLog(projectId, "imagens_videos", "info", `Render concluido bloco ${i} shot ${shot.id}`, {
              mediaPath: out.localPath,
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

  if (GENTUBE_HF_ASYNC && grandTotalJobs > 0) {
    console.log(
      chalk.bold.yellow(
        `\nStep 3 concluido: ${grandTotalJobs} jobs HF enfileirados. Rode:\n` +
          `  npm run gentube -- higgsfield:sync --project ${projectId} --watch --interval 30s`
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
  if (shouldSkipCompletedImagensBlock(projectId, blockNumber)) {
    console.log(chalk.dim(`${blockTag(blockNumber, totalBlocos)} Step 3 completo no registo, pulando bloco`));
    addProjectLog(projectId, "imagens_videos", "info", `Bloco ${blockNumber} saltado (ja concluido)`);
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

  updateProjectAnyStageStatus(projectId, "status_imagens_videos", "processing");
  console.log(
    chalk.bold.cyan(
      GENTUBE_HF_ASYNC
        ? `Step 3 — bloco ${blockNumber} (modo assincrono)`
        : `Step 3 — bloco ${blockNumber} (modo sincrono)`
    )
  );
  addProjectLog(
    projectId,
    "imagens_videos",
    "info",
    GENTUBE_HF_ASYNC
      ? `Reprocessando bloco ${blockNumber} (HF assincrono; depois higgsfield:sync)`
      : `Reprocessando bloco ${blockNumber} do step 3`
  );

  try {
    console.log(chalk.cyan(`${blockTag(blockNumber, totalBlocos)} Gerando plano de direcao (Claude)...`));
    const scriptText = await fs.readFile(scriptPath, "utf-8");
    upsertMediaBlock(projectId, blockNumber, { plan_status: "processing", started_at: startedAt, plan_error: null });
    const stockRatio = blockNumber === 1 ? STOCK_RATIO_BLOCK1 : STOCK_RATIO_OTHER;

    if (scenePlanV2Enabled(opts)) {
      if (GENTUBE_HF_ASYNC && forceScenePlanVizRegen()) {
        deleteHfCliJobsForBlock(projectId, blockNumber);
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
      });
      console.log(
        chalk.green(
          `${blockTag(blockNumber, totalBlocos)} Plano v2: ${r.planImages} imagens + ${r.planVideos} videos (${r.sceneCount} cenas)`
        )
      );
      if (GENTUBE_HF_ASYNC) {
        const pending = countHfCliJobsByBlockOutcome(projectId, blockNumber, "pending");
        upsertMediaBlock(projectId, blockNumber, {
          renders_total_count: Math.max(r.hfJobTotal, pending),
          renders_status: "awaiting_hf",
          finished_at: null,
        });
        console.log(chalk.yellow(`${blockTag(blockNumber, totalBlocos)} ${r.hfJobTotal} jobs HF enfileirados`));
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
          });
          if (shot.type === "image") lastImageRef = out.mediaUrl;
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

  const generated: string[] = [];
  for (let i = 1; i <= opts.count; i += 1) {
    const tag = chalk.dim(`[thumb ${i}/${opts.count}]`);
    console.log(chalk.cyan(`${tag} Gerando thumbnail via Higgsfield...`));

    try {
      const suffix = referenceImagePath ? "ref" : "gen";
      const shotId = `thumb_${suffix}_${String(i).padStart(2, "0")}`;
      const outPathNoExt = path.join(thumbnailsDir, shotId);

      if (GENTUBE_HF_ASYNC) {
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
      } else {
        const out = await generateThumbnailCli({ prompt, imageFiles });
        const localPath = await downloadMedia(out.mediaUrl, outPathNoExt, ".png");
        console.log(chalk.green(`${tag} Thumbnail salva → ${path.basename(localPath)}`));
        addProjectLog(projectId, "thumbnails", "info", `Thumbnail #${i} gerada`, { path: localPath });
        generated.push(localPath);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      console.log(chalk.red(`${tag} ERRO thumbnail: ${message}`));
      addProjectLog(projectId, "thumbnails", "error", `Falha na thumbnail #${i}`, { error: message });
      updateProjectAnyStageStatus(projectId, "status_thumbnails", "error");
      throw error;
    }
  }

  if (GENTUBE_HF_ASYNC) {
    console.log(
      chalk.bold.yellow(
        `\nThumbnails: ${generated.length} job(s) HF enfileirados. Rode:\n` +
          `  npm run gentube -- higgsfield:sync --project ${projectId} --watch --interval 30s`
      )
    );
    updateProjectAnyStageStatus(projectId, "status_thumbnails", "processing");
  } else {
    console.log(chalk.green.bold(`\n${generated.length} thumbnail(s) gerada(s) com sucesso.`));
    updateProjectAnyStageStatus(projectId, "status_thumbnails", "success");
  }
}

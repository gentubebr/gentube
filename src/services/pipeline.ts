import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { PROMPT_MATRIX_PATH, PROMPT_MATRIX02_PATH } from "../config.js";
import { generateAssetsPlanJson, generateScriptBlock } from "../integrations/claude.js";
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
  deleteHfCliJobsForBlock,
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
import { Step3Limits } from "../types/step3-limits.js";

type ProjectRow = Record<string, unknown>;

function blockTag(blockNumber: number, totalBlocks: number): string {
  return chalk.dim(`[bloco ${blockNumber}/${totalBlocks}]`);
}

const GENTUBE_HF_ASYNC = ["1", "true", "yes"].includes(
  String(process.env.GENTUBE_HF_ASYNC ?? "").toLowerCase()
);

export async function runRoteiro(project: ProjectRow): Promise<void> {
  const projectId = Number(project.id);
  const totalBlocos = Number(project.total_blocos);
  const promptBase = await fs.readFile(PROMPT_MATRIX_PATH, "utf-8");
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
      const content = await generateScriptBlock({
        promptBase,
        title: String(project.titulo),
        niche: String(project.niche),
        audience: String(project.audience),
        transcript: (project.transcript as string | null) ?? undefined,
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
export async function runRoteiroBlock(project: ProjectRow, blockNumber: number): Promise<void> {
  const projectId = Number(project.id);
  const totalBlocos = Number(project.total_blocos);
  if (blockNumber < 1 || blockNumber > totalBlocos) {
    throw new Error(`Bloco invalido: ${blockNumber} (esperado entre 1 e ${totalBlocos})`);
  }

  const promptBase = await fs.readFile(PROMPT_MATRIX_PATH, "utf-8");
  const roteiroDir = path.join(String(project.project_path), "01 - Roteiro");
  const blockFileName = `block${String(blockNumber).padStart(2, "0")}.md`;
  const blockPath = path.join(roteiroDir, blockFileName);
  const startedAt = new Date().toISOString();

  addProjectLog(projectId, "roteiro", "info", `Reprocessando bloco ${blockNumber} do roteiro`);

  try {
    upsertScriptBlock(projectId, blockNumber, { status: "processing", started_at: startedAt, error_message: null });
    const content = await generateScriptBlock({
      promptBase,
      title: String(project.titulo),
      niche: String(project.niche),
      audience: String(project.audience),
      transcript: (project.transcript as string | null) ?? undefined,
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
      const audioBuffer = await textToSpeechMp3({ text: sourceText, voiceId });
      await fs.writeFile(audioPath, audioBuffer);
      upsertNarrationBlock(projectId, blockNumber, {
        status: "success",
        file_path_mp3: audioPath,
        finished_at: new Date().toISOString(),
      });
      console.log(chalk.green(`${blockTag(blockNumber, totalBlocos)} Audio salvo → block${String(blockNumber).padStart(2, "0")}.mp3`));
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
    const audioBuffer = await textToSpeechMp3({ text: sourceText, voiceId });
    await fs.writeFile(audioPath, audioBuffer);
    upsertNarrationBlock(projectId, blockNumber, {
      status: "success",
      file_path_mp3: audioPath,
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

export async function runImagensVideos(project: ProjectRow, avatarPath?: string, limits?: Step3Limits): Promise<void> {
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

      const rawPlan = await generateAssetsPlanJson({
        promptBase,
        blockNumber: i,
        totalBlocks: totalBlocos,
        scriptText,
        audience: String(project.audience),
        avatarPath,
        maxVideos,
        maxImages,
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
      for (const shot of plan.shots) {
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

export async function runImagensVideosBlock(project: ProjectRow, blockNumber: number, avatarPath?: string, limits?: Step3Limits): Promise<void> {
  const projectId = Number(project.id);
  const totalBlocos = Number(project.total_blocos);
  if (blockNumber < 1 || blockNumber > totalBlocos) {
    throw new Error(`Bloco invalido: ${blockNumber} (esperado entre 1 e ${totalBlocos})`);
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
    const rawPlan = await generateAssetsPlanJson({
      promptBase,
      blockNumber,
      totalBlocks: totalBlocos,
      scriptText,
      audience: String(project.audience),
      avatarPath,
      maxVideos: limits ? (blockNumber === 1 ? limits.maxVideosBlock1 : limits.maxVideosOtherBlocks) : 999,
      maxImages: limits ? (blockNumber === 1 ? limits.maxImagesBlock1 : limits.maxImagesOtherBlocks) : 999,
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

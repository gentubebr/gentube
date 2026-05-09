import fs from "node:fs/promises";
import path from "node:path";
import { PROMPT_MATRIX_PATH, PROMPT_MATRIX02_PATH } from "../config.js";
import { generateAssetsPlanJson, generateScriptBlock } from "../integrations/claude.js";
import { textToSpeechMp3 } from "../integrations/elevenlabs.js";
import {
  generateImageWithDefaultsCli,
  generateVideoWithDefaultsCli,
} from "../integrations/higgsfield-cli.js";
import {
  addProjectLog,
  countBlocksByStatus,
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

export async function runRoteiro(project: ProjectRow): Promise<void> {
  const projectId = Number(project.id);
  const totalBlocos = Number(project.total_blocos);
  const promptBase = await fs.readFile(PROMPT_MATRIX_PATH, "utf-8");
  const roteiroDir = path.join(String(project.project_path), "01 - Roteiro");

  updateProjectAnyStageStatus(projectId, "status_roteiro", "processing");
  addProjectLog(projectId, "roteiro", "info", "Iniciando geracao de roteiro");

  for (let i = 1; i <= totalBlocos; i += 1) {
    const blockFileName = `block${String(i).padStart(2, "0")}.md`;
    const blockPath = path.join(roteiroDir, blockFileName);
    const startedAt = new Date().toISOString();

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
      addProjectLog(projectId, "roteiro", "info", `Bloco ${i} gerado com sucesso`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
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
    const startedAt = new Date().toISOString();
    const sourceText = await fs.readFile(block.file_path_md, "utf-8");
    const audioPath = path.join(narracaoDir, `block${String(blockNumber).padStart(2, "0")}.mp3`);

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
  addProjectLog(projectId, "imagens_videos", "info", "Iniciando step 3 (direcao + producao)");

  for (let i = 1; i <= totalBlocos; i += 1) {
    const maxVideos = limits ? (i === 1 ? limits.maxVideosBlock1 : limits.maxVideosOtherBlocks) : 999;
    const maxImages = limits ? (i === 1 ? limits.maxImagesBlock1 : limits.maxImagesOtherBlocks) : 999;
    const block = String(i).padStart(2, "0");
    const scriptPath = path.join(roteiroDir, `block${block}.md`);
    const jsonPath = path.join(imagesDir, `block${block}.assets.json`);
    const rendersDir = path.join(imagesDir, "renders", `block${block}`);
    const startedAt = new Date().toISOString();

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

      upsertMediaBlock(projectId, i, {
        assets_json_path: jsonPath,
        plan_status: "success",
        renders_status: "processing",
        renders_total_count: plan.shots.length,
        renders_done_count: 0,
      });

      await fs.mkdir(rendersDir, { recursive: true });
      let done = 0;
      let lastImageUrl: string | undefined;
      const avatarRef =
        avatarPath && String(avatarPath).trim()
          ? /^https?:\/\//i.test(String(avatarPath))
            ? String(avatarPath).trim()
            : path.resolve(String(avatarPath))
          : undefined;
      for (const shot of plan.shots) {
        let referenceImageUrl = shot.character_required ? avatarRef : undefined;

        if (shot.type === "video" && !referenceImageUrl) {
          referenceImageUrl = lastImageUrl;
        }
        if (shot.type === "video" && !referenceImageUrl) {
          const bootstrap = await generateAndRenderShot({
            type: "image",
            prompt: shot.description,
            outPathNoExt: path.join(rendersDir, `${shot.id}__bootstrap`),
            referenceImageUrl: avatarRef,
          });
          lastImageUrl = bootstrap.mediaUrl;
          referenceImageUrl = bootstrap.mediaUrl;
          addProjectLog(projectId, "imagens_videos", "info", `Bootstrap de imagem para video ${shot.id}`, {
            mediaPath: bootstrap.localPath,
          });
        }

        const out = await generateAndRenderShot({
          type: shot.type,
          prompt: shot.description,
          outPathNoExt: path.join(rendersDir, shot.id),
          referenceImageUrl,
        });
        if (shot.type === "image") lastImageUrl = out.mediaUrl;
        done += 1;
        addProjectLog(projectId, "imagens_videos", "info", `Render concluido bloco ${i} shot ${shot.id}`, {
          mediaPath: out.localPath,
        });
        upsertMediaBlock(projectId, i, { renders_done_count: done });
      }

      upsertMediaBlock(projectId, i, {
        renders_status: "success",
        finished_at: new Date().toISOString(),
      });
      addProjectLog(projectId, "imagens_videos", "info", `Bloco ${i} finalizado no step 3`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
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
  addProjectLog(projectId, "imagens_videos", "info", `Reprocessando bloco ${blockNumber} do step 3`);

  try {
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

    upsertMediaBlock(projectId, blockNumber, {
      assets_json_path: jsonPath,
      plan_status: "success",
      renders_status: "processing",
      renders_total_count: plan.shots.length,
      renders_done_count: 0,
    });

    await fs.mkdir(rendersDir, { recursive: true });
    let done = 0;
    let lastImageUrl: string | undefined;
    const avatarRef =
      avatarPath && String(avatarPath).trim()
        ? /^https?:\/\//i.test(String(avatarPath))
          ? String(avatarPath).trim()
          : path.resolve(String(avatarPath))
        : undefined;
    for (const shot of plan.shots) {
      let referenceImageUrl = shot.character_required ? avatarRef : undefined;
      if (shot.type === "video" && !referenceImageUrl) {
        referenceImageUrl = lastImageUrl;
      }
      if (shot.type === "video" && !referenceImageUrl) {
        const bootstrap = await generateAndRenderShot({
          type: "image",
          prompt: shot.description,
          outPathNoExt: path.join(rendersDir, `${shot.id}__bootstrap`),
          referenceImageUrl: avatarRef,
        });
        lastImageUrl = bootstrap.mediaUrl;
        referenceImageUrl = bootstrap.mediaUrl;
      }
      const out = await generateAndRenderShot({
        type: shot.type,
        prompt: shot.description,
        outPathNoExt: path.join(rendersDir, shot.id),
        referenceImageUrl,
      });
      if (shot.type === "image") lastImageUrl = out.mediaUrl;
      done += 1;
      upsertMediaBlock(projectId, blockNumber, { renders_done_count: done });
    }

    upsertMediaBlock(projectId, blockNumber, { renders_status: "success", finished_at: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
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

import fs from "node:fs/promises";
import path from "node:path";
import { PROMPT_MATRIX_PATH } from "../config.js";
import { generateScriptBlock } from "../integrations/claude.js";
import { textToSpeechMp3 } from "../integrations/elevenlabs.js";
import {
  addProjectLog,
  countBlocksByStatus,
  listScriptBlocks,
  recomputeStageFromBlocks,
  updateProjectStageStatus,
  upsertNarrationBlock,
  upsertScriptBlock,
} from "../repository.js";

type ProjectRow = Record<string, unknown>;

export async function runRoteiro(project: ProjectRow): Promise<void> {
  const projectId = Number(project.id);
  const totalBlocos = Number(project.total_blocos);
  const promptBase = await fs.readFile(PROMPT_MATRIX_PATH, "utf-8");
  const roteiroDir = path.join(String(project.project_path), "01 - Roteiro");

  updateProjectStageStatus(projectId, "status_roteiro", "processing");
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
      updateProjectStageStatus(projectId, "status_roteiro", "error");
      throw error;
    }
  }

  const totalSuccess = countBlocksByStatus("script_blocks", projectId, "success");
  if (totalSuccess === totalBlocos) {
    recomputeStageFromBlocks(projectId, totalBlocos, "script_blocks", "status_roteiro");
  } else {
    updateProjectStageStatus(projectId, "status_roteiro", "error");
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

  updateProjectStageStatus(projectId, "status_narracao", "processing");
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
      updateProjectStageStatus(projectId, "status_narracao", "error");
      throw error;
    }
  }

  const totalSuccess = countBlocksByStatus("narration_blocks", projectId, "success");
  if (totalSuccess === totalBlocos) {
    recomputeStageFromBlocks(projectId, totalBlocos, "narration_blocks", "status_narracao");
  } else {
    updateProjectStageStatus(projectId, "status_narracao", "error");
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

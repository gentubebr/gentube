import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import {
  mergeMontagemRunOptions,
  resolveMontagemConfig,
  type MontagemConfig,
  type MontagemRunOptions,
} from "../config/montagem.js";
import fsSync from "node:fs";
import {
  addProjectLog,
  getAssemblyBlock,
  recomputeMontagemStage,
  upsertAssemblyBlock,
  updateProjectAnyStageStatus,
} from "../repository.js";
import type { BlockScenesPlanV2 } from "../types/scenes-plan.js";
import { ensureDir } from "../utils/fs.js";
import { assertFfmpegAvailable } from "../utils/ffmpeg-exec.js";
import {
  assetsJsonPath,
  blockAssemblyJsonName,
  blockErrFileName,
  fullBlockFileName,
  montagemBlocksDir,
  montagemRoot,
  montagemScenesDir,
  segmentFileName,
} from "../utils/montagem-paths.js";
import { buildSegments, checkSceneReady } from "../utils/montagem-media.js";
import { concatClipsWithXfade, isOutputStale, renderSceneClip } from "../utils/montagem-render.js";
import { resolveQuoteOverlaysForBlock } from "../utils/quote-overlays.js";
import { applyQuoteOverlaysToClip } from "../utils/montagem-quote-overlay.js";
import { stoicOverlayModeEnabled } from "../utils/stoic-overlay-mode.js";

type ProjectRow = Record<string, unknown>;

export type MontagemBlockReport = {
  blockNumber: number;
  status: "success" | "partial" | "error" | "skipped";
  scenesTotal: number;
  scenesReady: number;
  segments: string[];
  fullBlockPath?: string;
  errPath?: string;
  messages: string[];
};

function blockTag(n: number, total: number): string {
  return chalk.cyan(`[bloco ${n}/${total}]`);
}

async function loadBlockPlan(projectPath: string, blockNumber: number): Promise<BlockScenesPlanV2> {
  const jsonPath = assetsJsonPath(projectPath, blockNumber);
  const raw = await fs.readFile(jsonPath, "utf-8");
  const parsed = JSON.parse(raw) as BlockScenesPlanV2;
  if (parsed.schema_version !== "2.0" || !Array.isArray(parsed.scenes)) {
    throw new Error(`plano invalido (esperado schema 2.0): ${jsonPath}`);
  }
  if (typeof parsed.block_number === "number" && parsed.block_number !== blockNumber) {
    throw new Error(`block_number no JSON (${parsed.block_number}) != bloco ${blockNumber}`);
  }
  return parsed;
}

async function writeBlockErrFile(
  errPath: string,
  payload: {
    blockNumber: number;
    ffmpegPath: string;
    incompleteScenes: Array<{ id: string; reason: string }>;
    segmentsGenerated: string[];
    ffmpegErrors: string[];
  },
): Promise<void> {
  const lines = [
    `timestamp: ${new Date().toISOString()}`,
    `bloco: ${payload.blockNumber}`,
    `ffmpeg: ${payload.ffmpegPath}`,
    "",
    "cenas_incompletas:",
    ...payload.incompleteScenes.map((s) => `  - ${s.id}: ${s.reason}`),
    "",
    "segmentos_gerados:",
    ...payload.segmentsGenerated.map((s) => `  - ${path.basename(s)}`),
  ];
  if (payload.ffmpegErrors.length > 0) {
    lines.push("", "erros_ffmpeg:");
    lines.push(...payload.ffmpegErrors.map((e) => `  - ${e}`));
  }
  await fs.writeFile(errPath, `${lines.join("\n")}\n`, "utf-8");
}

async function writeAssemblyJson(
  jsonPath: string,
  data: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(jsonPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export async function runMontagemBlock(
  project: ProjectRow,
  blockNumber: number,
  cfg: MontagemConfig & { force: boolean },
): Promise<MontagemBlockReport> {
  const projectId = Number(project.id);
  const projectPath = path.resolve(String(project.project_path));
  const totalBlocos = Number(project.total_blocos);
  const tag = blockTag(blockNumber, totalBlocos);
  const messages: string[] = [];
  const incompleteScenes: Array<{ id: string; reason: string }> = [];
  const ffmpegErrors: string[] = [];
  const segmentsGenerated: string[] = [];

  const blocksDir = montagemBlocksDir(projectPath, cfg);
  const scenesDir = montagemScenesDir(projectPath, blockNumber, cfg);
  const errPath = path.join(blocksDir, blockErrFileName(blockNumber));
  const assemblyPath = path.join(blocksDir, blockAssemblyJsonName(blockNumber));
  const fullBlockPath = path.join(blocksDir, fullBlockFileName(blockNumber));

  if (cfg.skipExisting && !cfg.force && cfg.montagemPhase !== "scenes") {
    const row = getAssemblyBlock(projectId, blockNumber);
    const fullPath = (row?.full_block_path as string | undefined) ?? fullBlockPath;
    if (row?.status === "success" && fullPath && fsSync.existsSync(fullPath)) {
      console.log(chalk.dim(`${tag} Bloco ja montado (${path.basename(fullPath)}), pulando`));
      return {
        blockNumber,
        status: "success",
        scenesTotal: Number(row.scenes_total ?? 0),
        scenesReady: Number(row.scenes_ready ?? 0),
        segments: [fullPath],
        fullBlockPath: fullPath,
        messages: ["skip: bloco ja success no SQLite"],
      };
    }
  }

  let plan: BlockScenesPlanV2;
  try {
    plan = await loadBlockPlan(projectPath, blockNumber);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    messages.push(msg);
    if (cfg.writeErrFile) {
      await ensureDir(blocksDir);
      await writeBlockErrFile(errPath, {
        blockNumber,
        ffmpegPath: cfg.ffmpegPath,
        incompleteScenes: [],
        segmentsGenerated: [],
        ffmpegErrors: [msg],
      });
    }
    upsertAssemblyBlock({
      projectId,
      blockNumber,
      status: "error",
      scenesTotal: 0,
      scenesReady: 0,
      errPath: cfg.writeErrFile ? errPath : null,
    });
    console.log(chalk.red(`${tag} ${msg}`));
    return {
      blockNumber,
      status: "error",
      scenesTotal: 0,
      scenesReady: 0,
      segments: [],
      errPath: cfg.writeErrFile ? errPath : undefined,
      messages,
    };
  }

  if (stoicOverlayModeEnabled()) {
    const prep = await resolveQuoteOverlaysForBlock(projectPath, blockNumber);
    if (prep.applied > 0) {
      console.log(chalk.dim(`${tag} Quote overlays: ${prep.applied} aplicado(s) no plano`));
      plan = await loadBlockPlan(projectPath, blockNumber);
    }
    if (prep.skipped.length > 0) {
      console.log(chalk.yellow(`${tag} Quote overlays ignorados: ${prep.skipped.length}`));
    }
  }

  const scenesTotal = plan.scenes.length;
  const readyById = new Map<string, { clipPath: string }>();

  if (cfg.montagemPhase === "assemble") {
    for (const scene of plan.scenes) {
      const sceneOut = path.join(scenesDir, `${scene.id}.mp4`);
      try {
        await fs.access(sceneOut);
        readyById.set(scene.id, { clipPath: sceneOut });
      } catch {
        incompleteScenes.push({
          id: scene.id,
          reason: "clipe ausente (rode antes montagem com --montagem-scenes-only ou full)",
        });
        console.log(chalk.yellow(`${tag} ${scene.id}: falta ${scene.id}.mp4 em scenes/`));
      }
    }
  } else {
    for (const scene of plan.scenes) {
      const readiness = await checkSceneReady(projectPath, blockNumber, scene, cfg);
      if (!readiness.ok) {
        incompleteScenes.push({ id: readiness.sceneId, reason: readiness.reason });
        console.log(chalk.yellow(`${tag} ${readiness.sceneId} incompleta: ${readiness.reason}`));
        continue;
      }

      const sceneOut = path.join(scenesDir, `${scene.id}.mp4`);
      const inputs = [readiness.mp3Path, readiness.visualPath];
      const stale = await isOutputStale(sceneOut, inputs);

      if (!cfg.force && !stale) {
        try {
          await fs.access(sceneOut);
          console.log(chalk.dim(`${tag} Reutilizando clipe ${scene.id}.mp4`));
          readyById.set(scene.id, { clipPath: sceneOut });
          continue;
        } catch {
          /* render */
        }
      }

      try {
        console.log(chalk.dim(`${tag} Montando cena ${scene.id}...`));
        await renderSceneClip({
          cfg,
          mp3Path: readiness.mp3Path,
          visualPath: readiness.visualPath,
          isImage: readiness.isImage,
          holdLastFrame: readiness.holdLastFrame,
          outPath: sceneOut,
        });
        if (scene.quote_overlays && scene.quote_overlays.length > 0) {
          await applyQuoteOverlaysToClip({
            cfg,
            clipPath: sceneOut,
            overlays: scene.quote_overlays,
          });
        }
        readyById.set(scene.id, { clipPath: sceneOut });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ffmpegErrors.push(`${scene.id}: ${msg}`);
        incompleteScenes.push({ id: scene.id, reason: `ffmpeg: ${msg}` });
        console.log(chalk.red(`${tag} ${scene.id}: ${msg}`));
      }
    }
  }

  const scenesReady = readyById.size;

  if (cfg.montagemPhase === "scenes") {
    if (scenesReady > 0) {
      console.log(
        chalk.cyan(
          `${tag} Fase cenas: ${scenesReady}/${scenesTotal} clipes prontos. Blocos: depois use --montagem-assemble-only.`,
        ),
      );
    }
  }

  const segments = buildSegments(plan.scenes, readyById);
  const validSegments = segments.filter((s) => s.sceneIds.length >= cfg.minScenesPerSegment);

  if (cfg.montagemPhase !== "scenes" && cfg.partialSegments) {
    for (const seg of validSegments) {
      const first = seg.sceneIds[0]!;
      const last = seg.sceneIds[seg.sceneIds.length - 1]!;
      const isFull = seg.sceneIds.length === scenesTotal && incompleteScenes.length === 0;
      const outName = isFull ? fullBlockFileName(blockNumber) : segmentFileName(blockNumber, first, last);
      const outPath = path.join(blocksDir, outName);

      const stale = await isOutputStale(outPath, seg.clipPaths);
      if (!cfg.force && !stale) {
        try {
          await fs.access(outPath);
          console.log(chalk.dim(`${tag} Reutilizando ${outName}`));
          segmentsGenerated.push(outPath);
          continue;
        } catch {
          /* build */
        }
      }

      try {
        console.log(chalk.dim(`${tag} Segmento ${outName} (${seg.sceneIds.length} cenas)...`));
        await concatClipsWithXfade({ cfg, clipPaths: seg.clipPaths, outPath });
        segmentsGenerated.push(outPath);
        console.log(chalk.green(`${tag} ${outName}`));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ffmpegErrors.push(`${outName}: ${msg}`);
        console.log(chalk.red(`${tag} ${outName}: ${msg}`));
      }
    }
  }

  const allComplete = scenesReady === scenesTotal && incompleteScenes.length === 0 && ffmpegErrors.length === 0;
  const hasFull =
    allComplete && segmentsGenerated.some((p) => path.basename(p) === fullBlockFileName(blockNumber));

  let status: MontagemBlockReport["status"];
  if (cfg.montagemPhase === "scenes") {
    if (scenesReady === 0) status = "error";
    else status = "partial";
  } else if (hasFull) status = "success";
  else if (segmentsGenerated.length > 0) status = "partial";
  else status = "error";

  if (cfg.writeErrFile && (incompleteScenes.length > 0 || ffmpegErrors.length > 0 || status === "error")) {
    await writeBlockErrFile(errPath, {
      blockNumber,
      ffmpegPath: cfg.ffmpegPath,
      incompleteScenes,
      segmentsGenerated,
      ffmpegErrors,
    });
  } else {
    await fs.unlink(errPath).catch(() => {});
  }

  await writeAssemblyJson(assemblyPath, {
    schema_version: "1.0",
    block_number: blockNumber,
    at: new Date().toISOString(),
    montagem_phase: cfg.montagemPhase,
    status,
    scenes_total: scenesTotal,
    scenes_ready: scenesReady,
    incomplete_scenes: incompleteScenes,
    segments: segmentsGenerated.map((p) => path.basename(p)),
    full_block: hasFull ? path.basename(fullBlockPath) : null,
  });

  upsertAssemblyBlock({
    projectId,
    blockNumber,
    status,
    scenesTotal,
    scenesReady,
    fullBlockPath: hasFull ? fullBlockPath : null,
    errPath:
      cfg.writeErrFile && (incompleteScenes.length > 0 || ffmpegErrors.length > 0) ? errPath : null,
  });

  addProjectLog(projectId, "montagem", "info", `Bloco ${blockNumber} montagem: ${status}`, {
    scenesReady,
    scenesTotal,
    segments: segmentsGenerated.map((p) => path.basename(p)),
  });

  return {
    blockNumber,
    status,
    scenesTotal,
    scenesReady,
    segments: segmentsGenerated,
    fullBlockPath: hasFull ? fullBlockPath : undefined,
    errPath:
      cfg.writeErrFile && (incompleteScenes.length > 0 || ffmpegErrors.length > 0) ? errPath : undefined,
    messages,
  };
}

export async function runMontagem(project: ProjectRow, cliOpts?: MontagemRunOptions): Promise<void> {
  const cfg = mergeMontagemRunOptions(resolveMontagemConfig(), cliOpts);
  const projectId = Number(project.id);
  const projectPath = path.resolve(String(project.project_path));
  const totalBlocos = Number(project.total_blocos);

  await assertFfmpegAvailable(cfg);
  await ensureDir(montagemRoot(projectPath, cfg));
  await ensureDir(montagemBlocksDir(projectPath, cfg));

  updateProjectAnyStageStatus(projectId, "status_montagem", "processing");
  addProjectLog(projectId, "montagem", "info", "Inicio step montagem", {
    ffmpeg: cfg.ffmpegPath,
    montagem_phase: cfg.montagemPhase,
  });

  const blocks =
    cfg.blockNumber !== undefined
      ? [cfg.blockNumber]
      : Array.from({ length: totalBlocos }, (_, i) => i + 1);

  if (cfg.montagemPhase === "scenes") {
    console.log(
      chalk.yellow(
        "Modo apenas cenas: gera clipes em todos os blocos; depois rode --montagem-assemble-only para blockNN.mp4.",
      ),
    );
  } else if (cfg.montagemPhase === "assemble") {
    console.log(
      chalk.yellow(
        "Modo apenas blocos: concatena a partir de scenes/blockNN/scXX.mp4 (sem re-renderizar clipes).",
      ),
    );
  } else if (cfg.blockNumber === undefined) {
    console.log(
      chalk.yellow(
        "Dica: monte bloco a bloco com --block N antes de correr todos (ex.: run-step --step montagem --block 1)",
      ),
    );
  } else {
    console.log(chalk.dim(`Montagem apenas do bloco ${cfg.blockNumber}/${totalBlocos}`));
  }

  for (const bn of blocks) {
    try {
      const report = await runMontagemBlock(project, bn, cfg);
      if (cfg.stopOnBlockError && report.status === "error") {
        console.log(chalk.red(`Montagem interrompida apos bloco ${bn} (GENTUBE_MONTAGEM_STOP_ON_BLOCK_ERROR=1)`));
        break;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(chalk.red(`[bloco ${bn}] Erro fatal: ${msg}`));
      addProjectLog(projectId, "montagem", "error", `Bloco ${bn} fatal`, { error: msg });
      if (cfg.stopOnBlockError) break;
    }
  }

  recomputeMontagemStage(projectId, totalBlocos);
  console.log(chalk.cyan("Montagem concluida. Verifique 06 - Montagem/blocks/ e status --project."));
}

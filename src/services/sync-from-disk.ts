import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import {
  addProjectLog,
  getMediaBlock,
  getNarrationBlock,
  getScriptBlock,
  recomputeImagensVideosStage,
  recomputeMontagemStage,
  recomputeStageFromBlocks,
  upsertAssemblyBlock,
  upsertMediaBlock,
  upsertNarrationBlock,
  upsertScriptBlock,
} from "../repository.js";
import { resolveMontagemConfig } from "../config/montagem.js";
import { montagemBlocksDir, fullBlockFileName } from "../utils/montagem-paths.js";
import type { MontagemStatus } from "../repository.js";

type ProjectRow = Record<string, unknown>;

const MIN_SCRIPT_BYTES = 32;
const MIN_MP3_BYTES = 1024;

export type SyncFromDiskScope = "roteiro" | "narracao" | "imagens" | "montagem" | "all";

export type SyncFromDiskOptions = {
  dryRun: boolean;
  only?: SyncFromDiskScope;
  force: boolean;
};

export type SyncFromDiskReport = {
  roteiro: { imported: number[]; skipped: number[]; missing: number[] };
  narracao: { imported: number[]; skipped: number[]; missing: number[] };
  imagens: { imported: number[]; skipped: number[]; invalid: number[] };
  montagem: { imported: number[]; skipped: number[]; missing: number[] };
};

function blockPad(n: number): string {
  return String(n).padStart(2, "0");
}

function scopeEnabled(scope: SyncFromDiskScope, only?: SyncFromDiskScope): boolean {
  if (!only || only === "all") return true;
  return only === scope;
}

function shotFilePresent(files: string[], shotId: string, shotType: string): boolean {
  const imgExts = new Set([".png", ".jpg", ".jpeg", ".webp"]);
  const vidExts = new Set([".mp4", ".webm"]);
  const allowed = shotType === "video" ? vidExts : imgExts;
  for (const f of files) {
    const { name, ext } = path.parse(f);
    if (name !== shotId) continue;
    if (allowed.has(ext.toLowerCase())) return true;
  }
  return false;
}

function sceneAssetPresent(files: string[], sceneId: string, visualType: string, source: string): boolean {
  if (source === "manual_capture") {
    const imgExts = new Set([".png", ".jpg", ".jpeg", ".webp"]);
    for (const f of files) {
      const { name, ext } = path.parse(f);
      if (name !== sceneId) continue;
      if (imgExts.has(ext.toLowerCase())) return true;
    }
    return false;
  }
  return shotFilePresent(files, sceneId, visualType);
}

async function validateImagensBlockOnDisk(
  projectPath: string,
  blockNumber: number,
): Promise<{ ok: true; jsonPath: string; shotCount: number } | { ok: false; reason: string }> {
  const block = blockPad(blockNumber);
  const imagesDir = path.join(projectPath, "03 - Imagens e Videos");
  const jsonPath = path.join(imagesDir, `block${block}.assets.json`);
  const rendersDir = path.join(imagesDir, "renders", `block${block}`);

  let raw: string;
  try {
    raw = await fs.readFile(jsonPath, "utf-8");
  } catch {
    return { ok: false, reason: `sem ${path.relative(projectPath, jsonPath)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `JSON invalido bloco ${blockNumber}` };
  }

  const rootProbe = parsed as Record<string, unknown>;
  if (rootProbe.schema_version === "2.0" && Array.isArray(rootProbe.scenes)) {
    const scenes = rootProbe.scenes as Array<{ id?: unknown; visual?: { type?: unknown; source?: unknown } }>;
    if (typeof rootProbe.block_number === "number" && rootProbe.block_number !== blockNumber) {
      return {
        ok: false,
        reason: `plano declara block_number ${rootProbe.block_number}, esperado ${blockNumber}`,
      };
    }
    if (scenes.length === 0) {
      return { ok: false, reason: `bloco ${blockNumber} scenes vazio` };
    }

    let filesV2: string[];
    try {
      filesV2 = await fs.readdir(rendersDir);
    } catch {
      return { ok: false, reason: `sem pasta renders/block${block}` };
    }

    for (let idx = 0; idx < scenes.length; idx += 1) {
      const row = scenes[idx];
      const sid = row?.id;
      const v = row?.visual;
      if (typeof sid !== "string" || !sid.trim()) {
        return { ok: false, reason: `cena ${idx + 1} sem id` };
      }
      if (!v || (v.type !== "image" && v.type !== "video")) {
        return { ok: false, reason: `cena ${String(sid)} visual.type invalido` };
      }
      const src = v.source;
      if (src !== "ai_generated" && src !== "stock" && src !== "manual_capture") {
        return { ok: false, reason: `cena ${sid} visual.source invalido` };
      }
      if (!sceneAssetPresent(filesV2, sid.trim(), v.type, src)) {
        return {
          ok: false,
          reason: `falta ficheiro para cena ${sid} (${v.type}, ${src}) em renders/block${block}`,
        };
      }
    }

    return { ok: true, jsonPath, shotCount: scenes.length };
  }

  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { shots?: unknown }).shots)) {
    return { ok: false, reason: `plano bloco ${blockNumber} sem array shots` };
  }
  const root = parsed as { block_number?: unknown; shots: Array<{ id?: unknown; type?: unknown }> };
  if (typeof root.block_number === "number" && root.block_number !== blockNumber) {
    return {
      ok: false,
      reason: `plano declara block_number ${root.block_number}, esperado ${blockNumber}`,
    };
  }
  const shots = root.shots;
  if (shots.length === 0) {
    return { ok: false, reason: `bloco ${blockNumber} shots vazio` };
  }

  let files: string[];
  try {
    files = await fs.readdir(rendersDir);
  } catch {
    return { ok: false, reason: `sem pasta renders/block${block}` };
  }

  for (let idx = 0; idx < shots.length; idx += 1) {
    const s = shots[idx];
    if (typeof s?.id !== "string" || !s.id.trim()) {
      return { ok: false, reason: `shot ${idx + 1} sem id` };
    }
    if (s.type !== "image" && s.type !== "video") {
      return { ok: false, reason: `shot ${s.id} type invalido` };
    }
    if (!shotFilePresent(files, s.id, s.type)) {
      return { ok: false, reason: `falta ficheiro para shot ${s.id} (${s.type}) em renders/block${block}` };
    }
  }

  return { ok: true, jsonPath, shotCount: shots.length };
}

/**
 * Sincroniza ficheiros ja presentes nas pastas do projeto com o SQLite (roteiro, narracao, imagens).
 */
export async function syncProjectFromDisk(project: ProjectRow, opts: SyncFromDiskOptions): Promise<SyncFromDiskReport> {
  const projectId = Number(project.id);
  const totalBlocos = Number(project.total_blocos);
  const projectPath = path.resolve(String(project.project_path));

  const report: SyncFromDiskReport = {
    roteiro: { imported: [], skipped: [], missing: [] },
    narracao: { imported: [], skipped: [], missing: [] },
    imagens: { imported: [], skipped: [], invalid: [] },
    montagem: { imported: [], skipped: [], missing: [] },
  };

  const roteiroDir = path.join(projectPath, "01 - Roteiro");
  const narracaoDir = path.join(projectPath, "02 - Narracao");
  const onlyScope = opts.only ?? "all";

  if (scopeEnabled("roteiro", opts.only)) {
    for (let i = 1; i <= totalBlocos; i += 1) {
      const mdPath = path.join(roteiroDir, `block${blockPad(i)}.md`);
      let st: Awaited<ReturnType<typeof fs.stat>>;
      try {
        st = await fs.stat(mdPath);
      } catch {
        report.roteiro.missing.push(i);
        continue;
      }
      if (!st.isFile() || st.size < MIN_SCRIPT_BYTES) {
        report.roteiro.missing.push(i);
        continue;
      }

      const existing = getScriptBlock(projectId, i);
      if (existing?.status === "success" && !opts.force) {
        report.roteiro.skipped.push(i);
        continue;
      }

      const content = await fs.readFile(mdPath, "utf-8");
      if (!content.trim()) {
        report.roteiro.missing.push(i);
        continue;
      }

      if (opts.dryRun) {
        console.log(chalk.cyan(`[dry-run] roteiro bloco ${i}: importaria ${path.relative(projectPath, mdPath)}`));
        report.roteiro.imported.push(i);
        continue;
      }

      const now = new Date().toISOString();
      upsertScriptBlock(projectId, i, {
        status: "success",
        file_path_md: mdPath,
        content_md: content,
        error_message: null,
        finished_at: now,
      });
      report.roteiro.imported.push(i);
      console.log(chalk.green(`Roteiro bloco ${i}: SQLite atualizado (${path.basename(mdPath)})`));
    }
  }

  if (scopeEnabled("narracao", opts.only)) {
    for (let i = 1; i <= totalBlocos; i += 1) {
      const mp3Path = path.join(narracaoDir, `block${blockPad(i)}.mp3`);
      let st: Awaited<ReturnType<typeof fs.stat>>;
      try {
        st = await fs.stat(mp3Path);
      } catch {
        report.narracao.missing.push(i);
        continue;
      }
      if (!st.isFile() || st.size < MIN_MP3_BYTES) {
        report.narracao.missing.push(i);
        continue;
      }

      const existing = getNarrationBlock(projectId, i);
      if (existing?.status === "success" && !opts.force) {
        report.narracao.skipped.push(i);
        continue;
      }

      if (opts.dryRun) {
        console.log(chalk.cyan(`[dry-run] narracao bloco ${i}: importaria ${path.relative(projectPath, mp3Path)}`));
        report.narracao.imported.push(i);
        continue;
      }

      const now = new Date().toISOString();
      upsertNarrationBlock(projectId, i, {
        status: "success",
        file_path_mp3: mp3Path,
        error_message: null,
        finished_at: now,
      });
      report.narracao.imported.push(i);
      console.log(chalk.green(`Narracao bloco ${i}: SQLite atualizado (${path.basename(mp3Path)})`));
    }
  }

  if (scopeEnabled("imagens", opts.only)) {
    for (let i = 1; i <= totalBlocos; i += 1) {
      const check = await validateImagensBlockOnDisk(projectPath, i);
      if (!check.ok) {
        report.imagens.invalid.push(i);
        continue;
      }

      const existing = getMediaBlock(projectId, i);
      if (existing?.plan_status === "success" && existing.renders_status === "success" && !opts.force) {
        report.imagens.skipped.push(i);
        continue;
      }

      if (opts.dryRun) {
        console.log(
          chalk.cyan(
            `[dry-run] imagens bloco ${i}: importaria plano + ${check.shotCount} renders (${path.relative(projectPath, check.jsonPath)})`
          )
        );
        report.imagens.imported.push(i);
        continue;
      }

      const now = new Date().toISOString();
      upsertMediaBlock(projectId, i, {
        assets_json_path: check.jsonPath,
        plan_status: "success",
        plan_error: null,
        renders_status: "success",
        renders_total_count: check.shotCount,
        renders_done_count: check.shotCount,
        started_at: now,
        finished_at: now,
      });
      report.imagens.imported.push(i);
      console.log(chalk.green(`Imagens bloco ${i}: SQLite atualizado (${check.shotCount} shots no disco)`));
    }
  }

  if (scopeEnabled("montagem", opts.only)) {
    const cfg = resolveMontagemConfig();
    const blocksDir = montagemBlocksDir(projectPath, cfg);
    for (let i = 1; i <= totalBlocos; i += 1) {
      const fullPath = path.join(blocksDir, fullBlockFileName(i));
      const assemblyJson = path.join(blocksDir, `block${blockPad(i)}.assembly.json`);
      let hasOutput = false;
      try {
        await fs.access(fullPath);
        hasOutput = true;
      } catch {
        try {
          const files = await fs.readdir(blocksDir);
          const prefix = `block${blockPad(i)}_`;
          hasOutput = files.some((f) => f.startsWith(prefix) && f.endsWith(".mp4"));
        } catch {
          report.montagem.missing.push(i);
          continue;
        }
      }
      if (!hasOutput) {
        report.montagem.missing.push(i);
        continue;
      }

      if (opts.dryRun) {
        console.log(chalk.cyan(`[dry-run] montagem bloco ${i}: importaria estado do disco`));
        report.montagem.imported.push(i);
        continue;
      }

      let status: MontagemStatus = "partial";
      let scenesTotal = 0;
      let scenesReady = 0;
      try {
        const raw = await fs.readFile(assemblyJson, "utf-8");
        const meta = JSON.parse(raw) as {
          status?: MontagemStatus;
          scenes_total?: number;
          scenes_ready?: number;
        };
        if (meta.status) status = meta.status;
        scenesTotal = meta.scenes_total ?? 0;
        scenesReady = meta.scenes_ready ?? 0;
      } catch {
        try {
          await fs.access(fullPath);
          status = "success";
        } catch {
          status = "partial";
        }
      }

      upsertAssemblyBlock({
        projectId,
        blockNumber: i,
        status,
        scenesTotal,
        scenesReady,
        fullBlockPath: (await fs.access(fullPath).then(() => fullPath).catch(() => null)) ?? null,
        errPath: null,
      });
      report.montagem.imported.push(i);
      console.log(chalk.green(`Montagem bloco ${i}: SQLite atualizado (${status})`));
    }
  }

  if (opts.dryRun) {
    console.log(chalk.bold.yellow("\nDry-run: nenhuma escrita no SQLite."));
    return report;
  }

  if (onlyScope === "all" || onlyScope === "roteiro") {
    recomputeStageFromBlocks(projectId, totalBlocos, "script_blocks", "status_roteiro");
  }
  if (onlyScope === "all" || onlyScope === "narracao") {
    recomputeStageFromBlocks(projectId, totalBlocos, "narration_blocks", "status_narracao");
  }
  if (onlyScope === "all" || onlyScope === "imagens") {
    recomputeImagensVideosStage(projectId, totalBlocos);
  }
  if (onlyScope === "all" || onlyScope === "montagem") {
    recomputeMontagemStage(projectId, totalBlocos);
  }

  addProjectLog(projectId, "sync", "info", "sync-from-disk concluido", {
    report,
    only: onlyScope,
    force: opts.force,
  });

  return report;
}

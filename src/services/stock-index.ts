import fs from "node:fs/promises";
import path from "node:path";
import { VIDEOS_DIR } from "../config.js";
import type { BlockScenesPlanV2 } from "../types/scenes-plan.js";
import { registerStockLibraryAsset, stockLibraryStats } from "./stock-library.js";

type SceneVisual = {
  type?: "image" | "video";
  source?: string;
  search_keywords?: string | null;
  description?: string;
  role?: string;
  character_required?: boolean;
};

type SceneEntry = { id?: string; visual?: SceneVisual };

type StockIndexOptions = {
  rootDir?: string;
  projectPath?: string;
  dryRun?: boolean;
  force?: boolean;
  errorsFile?: string;
  maxErrorRows?: number;
};

export type StockIndexReport = {
  scannedPlans: number;
  stockScenes: number;
  indexed: number;
  missingRender: number;
  skippedNoKeywords: number;
  errors: number;
  assetsTotal: number;
  aliasesTotal: number;
  loggedErrors: number;
  errorLogPath: string | null;
  topErrorReasons: Array<{ reason: string; count: number }>;
};

type StockIndexErrorRow = {
  kind: "plan_parse_error" | "missing_render" | "register_error";
  reason: string;
  plan_path: string;
  block_number: number | null;
  scene_id: string | null;
  media_type: "image" | "video" | null;
  keywords: string | null;
  detail: string;
};

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp"];
const VIDEO_EXTS = [".mp4", ".webm", ".mov"];

async function listAssetPlanFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (/^block\d+\.assets\.json$/i.test(entry.name)) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

async function locateRenderFile(rendersDir: string, sceneId: string, mediaType: "image" | "video"): Promise<string | null> {
  const exts = mediaType === "video" ? VIDEO_EXTS : IMAGE_EXTS;
  for (const ext of exts) {
    const candidate = path.join(rendersDir, `${sceneId}${ext}`);
    try {
      const st = await fs.stat(candidate);
      if (st.isFile()) return candidate;
    } catch {
      // noop
    }
  }
  return null;
}

function blockNumberFromFileName(filePath: string, fallback = 1): number {
  const m = /block(\d+)\.assets\.json$/i.exec(path.basename(filePath));
  if (!m) return fallback;
  const n = Number.parseInt(m[1] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRoot(input: StockIndexOptions): string {
  if (input.projectPath?.trim()) return path.resolve(input.projectPath.trim());
  if (input.rootDir?.trim()) return path.resolve(input.rootDir.trim());
  return VIDEOS_DIR;
}

export async function runStockIndex(input: StockIndexOptions = {}): Promise<StockIndexReport> {
  void input.force;
  const root = normalizeRoot(input);
  const plans = await listAssetPlanFiles(root);
  const maxErrorRows = Math.max(1, input.maxErrorRows ?? 5000);
  const errorsRows: StockIndexErrorRow[] = [];
  const reasonCounts = new Map<string, number>();

  let stockScenes = 0;
  let indexed = 0;
  let missingRender = 0;
  let skippedNoKeywords = 0;
  let errors = 0;
  const countReason = (reason: string): void => {
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  };
  const pushError = (row: StockIndexErrorRow): void => {
    if (errorsRows.length < maxErrorRows) errorsRows.push(row);
    countReason(row.reason);
  };

  for (const planPath of plans) {
    let payload: BlockScenesPlanV2 | null = null;
    try {
      const raw = await fs.readFile(planPath, "utf8");
      payload = JSON.parse(raw) as BlockScenesPlanV2;
    } catch (err) {
      errors += 1;
      pushError({
        kind: "plan_parse_error",
        reason: "plan_parse_error",
        plan_path: planPath,
        block_number: null,
        scene_id: null,
        media_type: null,
        keywords: null,
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const scenes = (payload as { scenes?: SceneEntry[] }).scenes ?? [];
    const blockNumber = Number((payload as { block_number?: number }).block_number) || blockNumberFromFileName(planPath, 1);
    const blockTag = `block${String(blockNumber).padStart(2, "0")}`;
    const rendersDir = path.join(path.dirname(planPath), "renders", blockTag);
    for (const scene of scenes) {
      const id = scene.id?.trim();
      const visual = scene.visual;
      if (!id || !visual) continue;
      if (visual.source !== "stock") continue;
      stockScenes += 1;

      const mediaType = visual.type === "video" ? "video" : "image";
      const keywords = visual.search_keywords?.trim() ?? "";
      if (!keywords) {
        skippedNoKeywords += 1;
        continue;
      }
      const renderPath = await locateRenderFile(rendersDir, id, mediaType);
      if (!renderPath) {
        missingRender += 1;
        pushError({
          kind: "missing_render",
          reason: "missing_render",
          plan_path: planPath,
          block_number: blockNumber,
          scene_id: id,
          media_type: mediaType,
          keywords,
          detail: `Render ausente em ${rendersDir} para ${id}.${mediaType === "video" ? "{mp4|webm|mov}" : "{jpg|jpeg|png|webp}"}`,
        });
        continue;
      }
      if (input.dryRun) {
        indexed += 1;
        continue;
      }
      try {
        await registerStockLibraryAsset({
          mediaType,
          localPath: renderPath,
          keywords,
          description: visual.description ?? null,
          role: visual.role ?? null,
          provider: "unknown",
          sourceKind: "stock",
          characterRequired: Boolean(visual.character_required),
        });
        indexed += 1;
      } catch (err) {
        errors += 1;
        pushError({
          kind: "register_error",
          reason: "register_error",
          plan_path: planPath,
          block_number: blockNumber,
          scene_id: id,
          media_type: mediaType,
          keywords,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  let errorLogPath: string | null = null;
  if (errorsRows.length > 0) {
    errorLogPath = input.errorsFile?.trim()
      ? path.resolve(input.errorsFile.trim())
      : path.resolve(process.cwd(), "out", "stock-index-errors.jsonl");
    await fs.mkdir(path.dirname(errorLogPath), { recursive: true });
    const body = errorsRows.map((r) => JSON.stringify(r)).join("\n");
    await fs.writeFile(errorLogPath, `${body}\n`, "utf8");
  }

  const stats = stockLibraryStats();
  const topErrorReasons = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  return {
    scannedPlans: plans.length,
    stockScenes,
    indexed,
    missingRender,
    skippedNoKeywords,
    errors,
    assetsTotal: stats.assets,
    aliasesTotal: stats.aliases,
    loggedErrors: errorsRows.length,
    errorLogPath,
    topErrorReasons,
  };
}


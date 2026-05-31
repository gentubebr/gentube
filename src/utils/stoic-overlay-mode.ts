import fs from "node:fs/promises";
import path from "node:path";
import type { BlockScenesPlanV2 } from "../types/scenes-plan.js";

function isStoicPatrolModalityEnv(): boolean {
  const raw = (process.env.GENTUBE_VISUAL_MODALITY ?? "default").trim().toLowerCase();
  return raw === "stoic_patrol" || raw === "stoic-patrol" || raw === "religious";
}

/** Cenas ai_generated no Stoic Patrol: apenas type image (Gemini/Batch), nunca video IA. */
export function stoicPatrolAiImagesOnly(): boolean {
  if (!isStoicPatrolModalityEnv()) return false;
  const raw = (process.env.GENTUBE_STOIC_AI_IMAGES_ONLY ?? "1").trim().toLowerCase();
  return !["0", "false", "no"].includes(raw);
}

/** Stock + IA no overlay (quotes continuam na montagem). */
export function stoicAllowAiMixEnabled(): boolean {
  if (!isStoicPatrolModalityEnv()) return false;
  if (!stoicOverlayModeEnabled()) return false;
  const raw = (process.env.GENTUBE_STOIC_ALLOW_AI_MIX ?? "").trim().toLowerCase();
  return ["1", "true", "yes"].includes(raw);
}

function parseStockRatioPercent(envKey: string, fallback: number): number {
  const raw = process.env[envKey]?.trim();
  const n = raw !== undefined && raw !== "" ? parseInt(raw, 10) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, n));
}

/** % stock no plano overlay+mix: bloco 1 default 50 (50% IA); demais default 75 (25% IA). */
export function resolveStoicOverlayMixStockRatio(blockNumber: number): number {
  const block1 = parseStockRatioPercent("GENTUBE_STOIC_AI_MIX_STOCK_RATIO_BLOCK1", 50);
  const other = parseStockRatioPercent("GENTUBE_STOIC_AI_MIX_STOCK_RATIO_OTHER", 75);
  return blockNumber === 1 ? block1 : other;
}

/** Projetos novos Stoic Patrol: overlays sincronizados (sem quote_card como cena). */
export function stoicOverlayModeEnabled(): boolean {
  if (!isStoicPatrolModalityEnv()) return false;
  const raw = (process.env.GENTUBE_STOIC_OVERLAY_MODE ?? "").trim().toLowerCase();
  if (["0", "false", "no", "legacy"].includes(raw)) return false;
  if (["1", "true", "yes", "overlay"].includes(raw)) return true;
  return false;
}

export function blockQuotesJsonPath(projectPath: string, blockNumber: number): string {
  const pad = String(blockNumber).padStart(2, "0");
  return path.join(projectPath, "03 - Imagens e Videos", `block${pad}.quotes.json`);
}

export async function tryLoadBlockQuotesPlan(
  projectPath: string,
  blockNumber: number,
): Promise<import("../types/quotes-plan.js").BlockQuotesPlan | null> {
  const p = blockQuotesJsonPath(projectPath, blockNumber);
  try {
    const raw = await fs.readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as import("../types/quotes-plan.js").BlockQuotesPlan;
    if (parsed.schema_version !== "1.0-quotes" || !Array.isArray(parsed.quotes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Plano legado: pelo menos uma cena quote_card. */
export function isLegacyStoicQuoteCardPlan(plan: BlockScenesPlanV2): boolean {
  return plan.scenes.some((s) => s.visual.source === "quote_card");
}

/** Usar pipeline overlay (quotizador + ancoras + montagem prep). */
export function useStoicOverlayPipeline(opts?: {
  plan?: BlockScenesPlanV2 | null;
  hasQuotesFile?: boolean;
}): boolean {
  if (!stoicOverlayModeEnabled()) return false;
  if (opts?.plan && isLegacyStoicQuoteCardPlan(opts.plan)) return false;
  if (opts?.hasQuotesFile === false && opts?.plan) {
    return false;
  }
  return true;
}

export function ttsWithTimestampsEnabled(): boolean {
  const raw = (process.env.GENTUBE_TTS_WITH_TIMESTAMPS ?? "").trim().toLowerCase();
  if (["1", "true", "yes"].includes(raw)) return true;
  if (stoicOverlayModeEnabled()) return true;
  return false;
}

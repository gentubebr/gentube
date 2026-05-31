import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import type { BlockQuote, BlockQuotesPlan, QuoteOverlay } from "../types/quotes-plan.js";
import type { BlockScenesPlanV2, ScenePlanV2 } from "../types/scenes-plan.js";
import type { SceneAlignmentFile } from "../types/quotes-plan.js";
import { extractSpanFromAnchors, findCharRangeInSceneText, findSubstringIndex } from "./text-anchors.js";
import { blockQuotesJsonPath } from "./stoic-overlay-mode.js";
import { assetsJsonPath } from "./montagem-paths.js";

function narrationSceneAlignmentPath(
  projectPath: string,
  blockNumber: number,
  sceneId: string,
): string {
  const pad = String(blockNumber).padStart(2, "0");
  return path.join(projectPath, "02 - Narracao", `block${pad}`, `${sceneId}.alignment.json`);
}

async function loadAlignment(
  projectPath: string,
  blockNumber: number,
  sceneId: string,
): Promise<SceneAlignmentFile | null> {
  const p = narrationSceneAlignmentPath(projectPath, blockNumber, sceneId);
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw) as SceneAlignmentFile;
  } catch {
    return null;
  }
}

function findSceneForQuote(plan: BlockScenesPlanV2, quote: BlockQuote): ScenePlanV2 | null {
  for (const scene of plan.scenes) {
    if (findSubstringIndex(scene.narration_text, quote.starts_with) >= 0) {
      return scene;
    }
  }
  return null;
}

function timestampsFromAlignment(
  alignment: SceneAlignmentFile["alignment"],
  startIndex: number,
  endIndex: number,
): { start_time_seconds: number; end_time_seconds: number } | null {
  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds;
  const ends = alignment.character_end_times_seconds;
  if (startIndex < 0 || endIndex >= chars.length) return null;
  const start_time_seconds = starts[startIndex];
  const end_time_seconds = ends[endIndex];
  if (typeof start_time_seconds !== "number" || typeof end_time_seconds !== "number") return null;
  return { start_time_seconds, end_time_seconds };
}

export type ResolveOverlaysReport = {
  applied: number;
  skipped: Array<{ quoteId: string; reason: string }>;
};

/** Secao 23.12 — preenche quote_overlays[] por cena e persiste assets.json. */
export async function resolveQuoteOverlaysForBlock(
  projectPath: string,
  blockNumber: number,
  opts?: { persist?: boolean },
): Promise<ResolveOverlaysReport> {
  const quotesPath = blockQuotesJsonPath(projectPath, blockNumber);
  let quotesPlan: BlockQuotesPlan;
  try {
    const raw = await fs.readFile(quotesPath, "utf-8");
    quotesPlan = JSON.parse(raw) as BlockQuotesPlan;
  } catch {
    return { applied: 0, skipped: [{ quoteId: "-", reason: "blockNN.quotes.json ausente" }] };
  }

  const assetsPath = assetsJsonPath(projectPath, blockNumber);
  const planRaw = await fs.readFile(assetsPath, "utf-8");
  const plan = JSON.parse(planRaw) as BlockScenesPlanV2;

  const skipped: Array<{ quoteId: string; reason: string }> = [];
  let applied = 0;

  for (const scene of plan.scenes) {
    scene.quote_overlays = [];
  }

  for (const quote of quotesPlan.quotes) {
    const scene = findSceneForQuote(plan, quote);
    if (!scene) {
      const msg = `nenhuma cena contem starts_with de ${quote.id}`;
      console.warn(chalk.yellow(`[quote_overlay] ${quote.id}: ${msg}`));
      skipped.push({ quoteId: quote.id, reason: msg });
      continue;
    }

    const alignment = await loadAlignment(projectPath, blockNumber, scene.id);
    if (!alignment?.alignment) {
      const msg = `alignment ausente para ${scene.id}`;
      console.warn(chalk.yellow(`[quote_overlay] ${quote.id}: ${msg}`));
      skipped.push({ quoteId: quote.id, reason: msg });
      continue;
    }

    const range = findCharRangeInSceneText(scene.narration_text, quote.starts_with, quote.ends_with);
    if (!range) {
      const msg = `ancoras da quote nao encontradas em narration_text de ${scene.id}`;
      console.warn(chalk.yellow(`[quote_overlay] ${quote.id}: ${msg}`));
      skipped.push({ quoteId: quote.id, reason: msg });
      continue;
    }

    const times = timestampsFromAlignment(alignment.alignment, range.startIndex, range.endIndex);
    if (!times) {
      const msg = `indices de alignment invalidos para ${scene.id}`;
      console.warn(chalk.yellow(`[quote_overlay] ${quote.id}: ${msg}`));
      skipped.push({ quoteId: quote.id, reason: msg });
      continue;
    }

    let text: string;
    try {
      text = extractSpanFromAnchors(scene.narration_text, quote);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "extracao de texto falhou";
      console.warn(chalk.yellow(`[quote_overlay] ${quote.id}: ${msg}`));
      skipped.push({ quoteId: quote.id, reason: msg });
      continue;
    }

    const overlay: QuoteOverlay = {
      quote_id: quote.id,
      text,
      start_time_seconds: times.start_time_seconds,
      end_time_seconds: times.end_time_seconds,
      overlay_style: quote.overlay_style,
      ...(quote.reference ? { reference: quote.reference } : {}),
    };

    if (!scene.quote_overlays) scene.quote_overlays = [];
    scene.quote_overlays.push(overlay);
    applied += 1;
  }

  if (opts?.persist !== false) {
    await fs.writeFile(assetsPath, `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
  }

  return { applied, skipped };
}

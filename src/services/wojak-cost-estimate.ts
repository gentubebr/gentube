import fs from "node:fs/promises";
import path from "node:path";
import { GEMINI_VEO_DURATION_SECONDS } from "../config.js";
import type { BlockScenesPlanV2 } from "../types/scenes-plan.js";
import { isBlockScenesPlanV2 } from "../utils/scenes-plan.js";

export type WojakCostRates = {
  claudePlanPerBlockUsd: number;
  geminiImageSyncUsd: number;
  geminiImageBatchUsd: number;
  veoPerSecondUsd: number;
};

export type WojakBlockCostLine = {
  blockNumber: number;
  sceneCount: number;
  imageScenes: number;
  videoScenes: number;
  geminiBatchImages: number;
  geminiSyncBootstraps: number;
  veoVideos: number;
  claudePlanCalls: number;
  usd: {
    claude: number;
    geminiBatch: number;
    geminiSyncBootstrap: number;
    veo: number;
    googleTotal: number;
    total: number;
  };
};

export type WojakProjectCostEstimate = {
  projectPath: string;
  totalBlocks: number;
  blocks: WojakBlockCostLine[];
  totals: WojakBlockCostLine["usd"] & { claude: number };
  rates: WojakCostRates;
  notes: string[];
};

function envUsd(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function wojakCostRatesFromEnv(): WojakCostRates {
  return {
    claudePlanPerBlockUsd: envUsd("GENTUBE_COST_USD_CLAUDE_PLAN_BLOCK", 4),
    geminiImageSyncUsd: envUsd("GENTUBE_COST_USD_GEMINI_IMAGE_SYNC", 0.039),
    geminiImageBatchUsd: envUsd("GENTUBE_COST_USD_GEMINI_IMAGE_BATCH", 0.0195),
    veoPerSecondUsd: envUsd("GENTUBE_COST_USD_VEO_PER_SECOND", 0.06),
  };
}

export function estimateWojakBlockCosts(
  plan: BlockScenesPlanV2,
  rates: WojakCostRates = wojakCostRatesFromEnv(),
): WojakBlockCostLine {
  const imageScenes = plan.scenes.filter((s) => s.visual.type === "image").length;
  const videoScenes = plan.scenes.filter((s) => s.visual.type === "video").length;
  const geminiBatchImages = imageScenes;
  const geminiSyncBootstraps = videoScenes;
  const veoVideos = videoScenes;
  const veoSeconds = veoVideos * GEMINI_VEO_DURATION_SECONDS;

  const geminiBatch = geminiBatchImages * rates.geminiImageBatchUsd;
  const geminiSyncBootstrap = geminiSyncBootstraps * rates.geminiImageSyncUsd;
  const veo = veoSeconds * rates.veoPerSecondUsd;
  const claude = rates.claudePlanPerBlockUsd;
  const googleTotal = geminiBatch + geminiSyncBootstrap + veo;

  return {
    blockNumber: plan.block_number,
    sceneCount: plan.scenes.length,
    imageScenes,
    videoScenes,
    geminiBatchImages,
    geminiSyncBootstraps,
    veoVideos,
    claudePlanCalls: 2,
    usd: {
      claude,
      geminiBatch,
      geminiSyncBootstrap,
      veo,
      googleTotal,
      total: claude + googleTotal,
    },
  };
}

export async function estimateWojakProjectCosts(
  projectPath: string,
  totalBlocks: number,
  rates?: WojakCostRates,
): Promise<WojakProjectCostEstimate> {
  const r = rates ?? wojakCostRatesFromEnv();
  const imagesDir = path.join(projectPath, "03 - Imagens e Videos");
  const blocks: WojakBlockCostLine[] = [];
  const notes = [
    "Estimativa com tarifas do .env (GENTUBE_COST_USD_*); confira fatura Google/Anthropic.",
    "Modo Wojak B: imagens estaticas = Batch+ref PNG; bootstrap video = sync; Veo = sync sem batch.",
    "Roteiro e narracao ElevenLabs nao incluidos.",
  ];

  for (let b = 1; b <= totalBlocks; b += 1) {
    const pad = String(b).padStart(2, "0");
    const jsonPath = path.join(imagesDir, `block${pad}.assets.json`);
    try {
      const raw = await fs.readFile(jsonPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!isBlockScenesPlanV2(parsed)) {
        notes.push(`block${pad}: plano ausente ou invalido — ignorado`);
        continue;
      }
      blocks.push(estimateWojakBlockCosts(parsed, r));
    } catch {
      notes.push(`block${pad}: sem block${pad}.assets.json`);
    }
  }

  const totals = blocks.reduce(
    (acc, line) => ({
      claude: acc.claude + line.usd.claude,
      geminiBatch: acc.geminiBatch + line.usd.geminiBatch,
      geminiSyncBootstrap: acc.geminiSyncBootstrap + line.usd.geminiSyncBootstrap,
      veo: acc.veo + line.usd.veo,
      googleTotal: acc.googleTotal + line.usd.googleTotal,
      total: acc.total + line.usd.total,
    }),
    {
      claude: 0,
      geminiBatch: 0,
      geminiSyncBootstrap: 0,
      veo: 0,
      googleTotal: 0,
      total: 0,
    },
  );

  return {
    projectPath,
    totalBlocks,
    blocks,
    totals,
    rates: r,
    notes,
  };
}

export function formatWojakCostReport(est: WojakProjectCostEstimate): string {
  const lines: string[] = [
    "=== Estimativa de custo — modalidade Wojak (opcao B) ===",
    `Projeto: ${est.projectPath}`,
    `Blocos com plano: ${est.blocks.length} / ${est.totalBlocks}`,
    "",
    "Tarifas (USD):",
    `  Claude plano/bloco (2 chamadas): $${est.rates.claudePlanPerBlockUsd.toFixed(2)}`,
    `  Gemini imagem batch+ref:       $${est.rates.geminiImageBatchUsd.toFixed(4)} / imagem`,
    `  Gemini bootstrap sync+ref:     $${est.rates.geminiImageSyncUsd.toFixed(4)} / imagem`,
    `  Veo (${GEMINI_VEO_DURATION_SECONDS}s/cena):              $${est.rates.veoPerSecondUsd.toFixed(4)} / segundo`,
    "",
  ];

  for (const b of est.blocks) {
    lines.push(
      `Bloco ${b.blockNumber}: ${b.sceneCount} cenas (${b.imageScenes} img batch + ${b.videoScenes} vid)`,
      `  Claude:     $${b.usd.claude.toFixed(2)}`,
      `  Batch img:  $${b.usd.geminiBatch.toFixed(2)} (${b.geminiBatchImages}×)`,
      `  Bootstrap:  $${b.usd.geminiSyncBootstrap.toFixed(2)} (${b.geminiSyncBootstraps}×)`,
      `  Veo:        $${b.usd.veo.toFixed(2)} (${b.veoVideos}×)`,
      `  Subtotal:   $${b.usd.total.toFixed(2)}`,
      "",
    );
  }

  lines.push(
    "TOTAL projeto:",
    `  Claude:  $${est.totals.claude.toFixed(2)}`,
    `  Google:  $${est.totals.googleTotal.toFixed(2)} (batch $${est.totals.geminiBatch.toFixed(2)} + bootstrap $${est.totals.geminiSyncBootstrap.toFixed(2)} + veo $${est.totals.veo.toFixed(2)})`,
    `  TOTAL:   $${est.totals.total.toFixed(2)}`,
    "",
    ...est.notes.map((n) => `• ${n}`),
  );
  return lines.join("\n");
}

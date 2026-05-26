import crypto from "node:crypto";
import {
  MAGNIFIC_API_KEY,
  PEXELS_API_KEY,
  STOCK_SPLIT_GOOGLE_BATCH_PERCENT,
  STOCK_SPLIT_MAGNIFIC_PERCENT,
  resolveStockProvider,
  type StockProviderMode,
} from "../config.js";
import { searchAndDownloadMagnific } from "./magnific.js";
import { searchAndDownloadPexels } from "./pexels.js";
import { isStockProviderFallbackEligible } from "../utils/stock-media.js";
import { tryCopyFromStockLibrary, registerStockLibraryAsset } from "../services/stock-library.js";

export type StockDownloadInput = {
  type: "image" | "video";
  keywords: string;
  destPathNoExt: string;
  description?: string;
  role?: string;
  characterRequired?: boolean;
};

type ProviderName = "local" | "magnific" | "pexels" | "google_image";

export class StockGoogleBatchFallbackError extends Error {
  prompt: string;
  constructor(prompt: string) {
    super("Stock split escolheu Google Batch assincrono");
    this.name = "StockGoogleBatchFallbackError";
    this.prompt = prompt;
  }
}

function providersForMode(mode: StockProviderMode): ProviderName[] {
  switch (mode) {
    case "local_then_pexels_then_magnific":
      return ["local", "pexels", "magnific"];
    case "pexels":
      return ["pexels"];
    case "magnific_then_pexels":
      return ["magnific", "pexels"];
    case "pexels_then_magnific":
      return ["pexels", "magnific"];
    case "magnific":
    default:
      return ["magnific"];
  }
}

function availableProviders(chain: ProviderName[]): ProviderName[] {
  return chain.filter((p) => {
    if (p === "local") return true;
    if (p === "google_image") return true;
    if (p === "magnific") return Boolean(MAGNIFIC_API_KEY);
    return Boolean(PEXELS_API_KEY);
  });
}

function chooseSplitProvider(seed: string): ProviderName {
  const x = Math.max(0, Math.min(100, STOCK_SPLIT_MAGNIFIC_PERCENT));
  const y = Math.max(0, Math.min(100, STOCK_SPLIT_GOOGLE_BATCH_PERCENT));
  const total = x + y;
  const normalizedMagnific = total > 0 ? Math.round((x / total) * 100) : 60;
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  const bucket = Number.parseInt(hash.slice(0, 2), 16) % 100;
  return bucket < normalizedMagnific ? "magnific" : "google_image";
}

function buildGoogleStockPrompt(input: StockDownloadInput): string {
  const parts = [
    input.description?.trim(),
    input.keywords.trim(),
    "cinematic visual, meaningful composition, no text, no logo, no watermark, 16:9",
  ].filter(Boolean);
  return parts.join(". ");
}

async function downloadFromProvider(
  provider: ProviderName,
  input: StockDownloadInput,
): Promise<string> {
  if (provider === "local") {
    const hit = await tryCopyFromStockLibrary({
      mediaType: input.type,
      keywords: input.keywords,
      destPathNoExt: input.destPathNoExt,
    });
    if (!hit) {
      throw new Error(`Stock local sem match para "${input.keywords}"`);
    }
    if (process.env.GENTUBE_VERBOSE === "1") {
      console.log(
        `Stock: local ${hit.matchKind} hit (${(hit.score * 100).toFixed(0)}%) → ${hit.matchedKeywords}`,
      );
    }
    return hit.path;
  }
  if (provider === "google_image") {
    if (input.type !== "image") {
      throw new Error("Google image fallback so suporta type=image");
    }
    if (input.characterRequired) {
      throw new Error("Google image fallback bloqueado para cena com personagem/avatar");
    }
    const prompt = buildGoogleStockPrompt(input);
    throw new StockGoogleBatchFallbackError(prompt);
  }
  if (provider === "pexels") {
    return searchAndDownloadPexels(input);
  }
  return searchAndDownloadMagnific(input);
}

/**
 * Busca e baixa stock conforme GENTUBE_STOCK_PROVIDER (Magnific, Pexels ou cadeia com fallback).
 */
export async function searchAndDownload(input: StockDownloadInput): Promise<string> {
  const mode = resolveStockProvider();
  const isSplitMode = mode === "local_then_pexels_then_split";
  const chain = isSplitMode
    ? availableProviders(["local", "pexels"])
    : availableProviders(providersForMode(mode));
  if (chain.length === 0) {
    throw new Error(
      "Nenhum provedor de stock configurado: defina MAGNIFIC_API_KEY e/ou PEXELS_API_KEY e GENTUBE_STOCK_PROVIDER",
    );
  }

  let lastErr: Error | null = null;
  for (let i = 0; i < chain.length; i += 1) {
    const provider = chain[i];
    try {
      const localPath = await downloadFromProvider(provider, input);
      if (provider !== "local") {
        await registerStockLibraryAsset({
          mediaType: input.type,
          localPath,
          keywords: input.keywords,
          description: input.description ?? null,
          role: input.role ?? null,
          provider: provider === "google_image" ? "google_batch" : provider,
          sourceKind: provider === "google_image" ? "ai_generated" : "stock",
          characterRequired: Boolean(input.characterRequired),
        }).catch(() => {});
      }
      if (i > 0) {
        const label = chain.slice(0, i).join(" → ");
        const msg = `Stock: fallback ${label} → ${provider} OK (${input.type})`;
        if (process.env.GENTUBE_VERBOSE === "1") {
          console.log(msg);
        }
      }
      return localPath;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const canFallback =
        i < chain.length - 1 && (chain[i] === "local" || isStockProviderFallbackEligible(lastErr));
      if (process.env.GENTUBE_VERBOSE === "1") {
        console.log(
          `Stock: ${provider} falhou (${input.keywords.slice(0, 60)}…): ${lastErr.message.slice(0, 120)}` +
            (canFallback ? ` — tentando ${chain[i + 1]}` : ""),
        );
      }
      if (canFallback) continue;
      if (isSplitMode) break;
      throw new Error(
        chain.length === 1
          ? lastErr.message
          : `Stock falhou (${provider}${chain.length > 1 ? `; sem fallback` : ""}): ${lastErr.message}`,
      );
    }
  }

  if (!isSplitMode) {
    throw lastErr ?? new Error(`Stock: falha para "${input.keywords}"`);
  }

  const splitPrimary = chooseSplitProvider(`${input.type}|${input.keywords}|${input.destPathNoExt}`);
  const splitSecondary = splitPrimary === "magnific" ? "google_image" : "magnific";
  const splitChain = availableProviders([splitPrimary, splitSecondary]);
  if (splitChain.length === 0) {
    throw lastErr ?? new Error("Stock split sem provedores disponiveis");
  }
  for (let i = 0; i < splitChain.length; i += 1) {
    const provider = splitChain[i]!;
    try {
      const localPath = await downloadFromProvider(provider, input);
      if (provider !== "local") {
        await registerStockLibraryAsset({
          mediaType: input.type,
          localPath,
          keywords: input.keywords,
          description: input.description ?? null,
          role: input.role ?? null,
          provider: provider === "google_image" ? "google_batch" : provider,
          sourceKind: provider === "google_image" ? "ai_generated" : "stock",
          characterRequired: Boolean(input.characterRequired),
        }).catch(() => {});
      }
      return localPath;
    } catch (err) {
      if (err instanceof StockGoogleBatchFallbackError) throw err;
      lastErr = err instanceof Error ? err : new Error(String(err));
      const canFallback =
        i < splitChain.length - 1 &&
        (provider === "google_image" || provider === "local" || isStockProviderFallbackEligible(lastErr));
      if (!canFallback) throw lastErr;
    }
  }
  throw lastErr ?? new Error(`Stock: falha para "${input.keywords}"`);
}

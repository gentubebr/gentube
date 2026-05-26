import { MAGNIFIC_API_KEY, PEXELS_API_KEY, resolveStockProvider, type StockProviderMode } from "../config.js";
import { searchAndDownloadMagnific } from "./magnific.js";
import { searchAndDownloadPexels } from "./pexels.js";
import { isStockProviderFallbackEligible } from "../utils/stock-media.js";

export type StockDownloadInput = {
  type: "image" | "video";
  keywords: string;
  destPathNoExt: string;
};

type ProviderName = "magnific" | "pexels";

function providersForMode(mode: StockProviderMode): ProviderName[] {
  switch (mode) {
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
    if (p === "magnific") return Boolean(MAGNIFIC_API_KEY);
    return Boolean(PEXELS_API_KEY);
  });
}

async function downloadFromProvider(
  provider: ProviderName,
  input: StockDownloadInput,
): Promise<string> {
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
  const chain = availableProviders(providersForMode(mode));
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
      const canFallback = i < chain.length - 1 && isStockProviderFallbackEligible(lastErr);
      if (process.env.GENTUBE_VERBOSE === "1") {
        console.log(
          `Stock: ${provider} falhou (${input.keywords.slice(0, 60)}…): ${lastErr.message.slice(0, 120)}` +
            (canFallback ? ` — tentando ${chain[i + 1]}` : ""),
        );
      }
      if (canFallback) continue;
      throw new Error(
        chain.length === 1
          ? lastErr.message
          : `Stock falhou (${provider}${chain.length > 1 ? `; sem fallback` : ""}): ${lastErr.message}`,
      );
    }
  }
  throw lastErr ?? new Error(`Stock: falha para "${input.keywords}"`);
}

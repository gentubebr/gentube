/**
 * Matriz de fallback de video: HF → Veo → Magnific
 *
 * | Erro observado | Exemplos na mensagem / HTTP | Proximo degrau |
 * |----------------|----------------------------|----------------|
 * | Credito/cota HF | credit, insufficient, quota, 402, payment, limit exceeded | Veo (sync) |
 * | Erro transiente HF | timeout, 5xx, network, ECONNRESET | Retry HF (ate 3x) — sem Veo |
 * | Payload HF | imagem invalida, 422, NSFW | Falha — sem Veo automatico |
 * | Cota/billing Google | quota, 429, RESOURCE_EXHAUSTED, billing | Magnific (se keywords) |
 * | Erro transiente Veo | timeout poll, 5xx | Retry Veo 1x — depois Magnific |
 * | RAI / prompt Veo | safety, filtered, blocked | Magnific ou falha |
 * | Magnific sem match | nenhum 16:9, >100MB | Falha final |
 *
 * Variavel: GENTUBE_VIDEO_BACKEND=auto|higgsfield|veo|magnific
 */

export type VideoProvider = "higgsfield" | "veo" | "magnific";

function normalize(msg: string): string {
  return msg.toLowerCase();
}

/** HF CLI/API: sem creditos ou cota esgotada — aciona Veo, sem retry HF. */
export function isHfCreditsOrQuotaError(message: string, httpStatus?: number): boolean {
  if (httpStatus === 402) return true;
  if (httpStatus === 403) {
    const m = normalize(message);
    if (m.includes("credit") || m.includes("quota") || m.includes("payment") || m.includes("billing")) {
      return true;
    }
  }
  const m = normalize(message);
  const hints = [
    "credit",
    "credits",
    "not_enough_credits",
    "insufficient",
    "not enough",
    "out of credits",
    "quota",
    "rate limit",
    "limit exceeded",
    "exceeded your",
    "payment required",
    "billing",
    "subscription",
    "balance",
    "402",
  ];
  return hints.some((h) => m.includes(h));
}

/** Erro HF que vale nova tentativa (rede/servidor), nao fallback de provedor. */
export function isHfTransientError(message: string, httpStatus?: number): boolean {
  if (httpStatus !== undefined && httpStatus >= 500) return true;
  const m = normalize(message);
  return (
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("econnreset") ||
    m.includes("enotfound") ||
    m.includes("network") ||
    m.includes("503") ||
    m.includes("502") ||
    m.includes("504")
  );
}

/** Google GenAI / Veo: cota ou billing — aciona Magnific. */
export function isGoogleQuotaOrBillingError(message: string, httpStatus?: number): boolean {
  if (httpStatus === 429 || httpStatus === 402 || httpStatus === 403) return true;
  const m = normalize(message);
  const hints = [
    "quota",
    "rate limit",
    "resource_exhausted",
    "resource exhausted",
    "billing",
    "exceeded",
    "limit",
    "429",
    "permission denied",
  ];
  return hints.some((h) => m.includes(h));
}

export function shouldFallbackHfToVeo(message: string, httpStatus?: number): boolean {
  return isHfCreditsOrQuotaError(message, httpStatus);
}

export function shouldFallbackVeoToMagnific(message: string, httpStatus?: number): boolean {
  return isGoogleQuotaOrBillingError(message, httpStatus);
}

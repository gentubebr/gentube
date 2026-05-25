/**
 * Classificacao e fallback de erros de provedores externos.
 *
 * --- Matriz de fallback de video: HF → Veo → Magnific ---
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
 *
 * --- Classificacao de erros Claude/Anthropic ---
 *
 * | Tipo | HTTP / mensagem | Acao no pipeline |
 * |------|-----------------|-----------------|
 * | transient | 500, 529, timeout, ECONNRESET | Retry imediato |
 * | quota | 429, rate_limit_error | Retry com backoff (GENTUBE_QUOTA_RETRY_DELAY_MS) |
 * | permanent | 400, 401, 403, invalid_request, authentication | Sem retry — falha imediata |
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

// ---------------------------------------------------------------------------
// Claude / Anthropic error classification
// ---------------------------------------------------------------------------

export type ClaudeErrorKind = "transient" | "quota" | "permanent";

/**
 * Extrai o status HTTP de um erro do Anthropic SDK ou de qualquer objeto com `.status`.
 * O SDK lanca `APIError` com propriedade `.status: number`.
 */
function extractHttpStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const s = (error as { status: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

/**
 * Extrai o tipo de erro Anthropic (ex. "rate_limit_error", "invalid_request_error").
 * O SDK expoe via `.error.type` ou `.type`.
 */
function extractAnthropicErrorType(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (typeof e.type === "string") return e.type;
    if (e.error && typeof e.error === "object") {
      const inner = e.error as Record<string, unknown>;
      if (typeof inner.type === "string") return inner.type;
    }
  }
  return "";
}

/**
 * Classifica um erro lancado por chamadas Claude/Anthropic em tres categorias:
 *
 * - `transient`  — falha de rede ou servidor sobrecarregado; retry imediato adequado.
 * - `quota`      — rate limit atingido; retry com backoff adequado.
 * - `permanent`  — erro de payload/autenticacao; retry nao vai ajudar.
 */
export function classifyClaudeError(error: unknown): ClaudeErrorKind {
  const httpStatus = extractHttpStatus(error);
  const errorType = extractAnthropicErrorType(error);
  const msg = normalize(error instanceof Error ? error.message : String(error));

  // Quota / rate limit
  if (
    httpStatus === 429 ||
    errorType === "rate_limit_error" ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("rate_limit")
  ) {
    return "quota";
  }

  // Permanent — autenticacao, requisicao invalida, conteudo bloqueado
  if (
    httpStatus === 400 ||
    httpStatus === 401 ||
    httpStatus === 403 ||
    httpStatus === 404 ||
    httpStatus === 422 ||
    errorType === "invalid_request_error" ||
    errorType === "authentication_error" ||
    errorType === "permission_error" ||
    errorType === "not_found_error" ||
    msg.includes("invalid_request") ||
    msg.includes("authentication_error") ||
    msg.includes("invalid api key") ||
    msg.includes("content policy") ||
    msg.includes("safety") ||
    msg.includes("not allowed")
  ) {
    return "permanent";
  }

  // Transient — servidor sobrecarregado, rede, timeout
  if (
    httpStatus === 500 ||
    httpStatus === 502 ||
    httpStatus === 503 ||
    httpStatus === 529 ||
    errorType === "overloaded_error" ||
    errorType === "api_error" ||
    msg.includes("overloaded") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("network") ||
    msg.includes("503") ||
    msg.includes("529")
  ) {
    return "transient";
  }

  // Default conservador: tratar como transient para nao perder trabalho
  return "transient";
}

/**
 * Delay de retry para erros de quota (ms).
 * Padrao 30s; configuravel via GENTUBE_QUOTA_RETRY_DELAY_MS.
 */
export const QUOTA_RETRY_DELAY_MS = (() => {
  const v = parseInt(process.env.GENTUBE_QUOTA_RETRY_DELAY_MS ?? "", 10);
  return isNaN(v) ? 30_000 : v;
})();

/**
 * Cliente HTTP para `platform.higgsfield.ai` (API Key).
 * O step 3 do GenTube usa `higgsfield-cli.ts` + binario oficial; este modulo permanece para referencia ou uso futuro.
 */
import { HIGGSFIELD_API_KEY_ID, HIGGSFIELD_API_KEY_SECRET } from "../config.js";

const BASE_URL = "https://platform.higgsfield.ai";

type HiggsStatus = "queued" | "in_progress" | "completed" | "failed" | "nsfw" | "cancelled";

class HiggsSubmitError extends Error {
  status: number;
  body: string;
  modelId: string;
  constructor(modelId: string, status: number, body: string) {
    super(`Higgsfield submit falhou (${status}) [${modelId}]: ${body}`);
    this.status = status;
    this.body = body;
    this.modelId = modelId;
  }
}

function getAuthHeader(): string {
  if (!HIGGSFIELD_API_KEY_ID || !HIGGSFIELD_API_KEY_SECRET) {
    throw new Error("HIGGSFIELD_API_KEY_ID/HIGGSFIELD_API_KEY_SECRET nao configuradas no .env");
  }
  return `Key ${HIGGSFIELD_API_KEY_ID}:${HIGGSFIELD_API_KEY_SECRET}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function collectMediaUrls(value: unknown, bag: string[] = []): string[] {
  if (typeof value === "string" && /^https?:\/\//.test(value)) {
    bag.push(value);
    return bag;
  }
  if (Array.isArray(value)) {
    value.forEach((v) => collectMediaUrls(v, bag));
    return bag;
  }
  const obj = asObject(value);
  if (!obj) return bag;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && /^https?:\/\//.test(v) && ["url", "image", "video", "result_url"].includes(k)) {
      bag.push(v);
    } else {
      collectMediaUrls(v, bag);
    }
  }
  return bag;
}

function extractRequestId(resp: unknown): string {
  const obj = asObject(resp);
  if (!obj) throw new Error("Resposta do Higgsfield invalida");
  const requestId = obj.request_id ?? obj.id;
  if (typeof requestId !== "string" || !requestId) {
    throw new Error("Nao foi possivel extrair request_id da resposta Higgsfield");
  }
  return requestId;
}

async function submit(modelId: string, argumentsPayload: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${BASE_URL}/${modelId}`, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(argumentsPayload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new HiggsSubmitError(modelId, res.status, body);
  }
  const payload = (await res.json()) as unknown;
  return extractRequestId(payload);
}

async function submitWithFallback(
  modelCandidates: string[],
  makePayload: (modelId: string) => Record<string, unknown>
): Promise<{ requestId: string; modelUsed: string }> {
  let lastError: unknown;
  for (const modelId of modelCandidates) {
    try {
      const requestId = await submit(modelId, makePayload(modelId));
      return { requestId, modelUsed: modelId };
    } catch (error) {
      lastError = error;
      if (error instanceof HiggsSubmitError) {
        // 404 model inexistente: tenta proximo candidate.
        if (error.status === 404) continue;
        // 422 payload incompativel com modelo: tenta fallback.
        if (error.status === 422) continue;
        // 403/credits e demais erros: interrompe para evitar custo/retries cegos.
        throw error;
      }
      throw error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error("Nenhum modelo Higgsfield candidato aceitou o request");
}

async function pollResult(requestId: string): Promise<Record<string, unknown>> {
  const timeoutMs = 6 * 60 * 1000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${BASE_URL}/requests/${requestId}/status`, {
      headers: { Authorization: getAuthHeader() },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Higgsfield status falhou (${res.status}): ${body}`);
    }
    const payload = (await res.json()) as Record<string, unknown>;
    const status = String(payload.status ?? "") as HiggsStatus;
    if (status === "completed") return payload;
    if (status === "failed" || status === "nsfw" || status === "cancelled") {
      throw new Error(`Higgsfield request ${requestId} terminou com status=${status}`);
    }
    await sleep(2500);
  }
  throw new Error(`Timeout aguardando request Higgsfield ${requestId}`);
}

export async function generateImageWithDefaults(input: {
  prompt: string;
  referenceImageUrl?: string;
}): Promise<{ mediaUrl: string; requestId: string }> {
  const candidates = [
    // Politica original (pode existir em alguns ambientes).
    "nano_banana_flash",
    "nano_banana_2",
    // Fallbacks confirmados como validos no endpoint atual.
    "higgsfield-ai/soul/standard",
  ];
  const refUrl = input.referenceImageUrl && /^https?:\/\//.test(input.referenceImageUrl) ? input.referenceImageUrl : undefined;
  const { requestId } = await submitWithFallback(candidates, (modelId) => {
    const payload: Record<string, unknown> = {
      prompt: input.prompt,
      aspect_ratio: "16:9",
      resolution: modelId === "higgsfield-ai/soul/standard" ? "720p" : "1k",
    };
    if (refUrl) payload.image_url = refUrl;
    return payload;
  });
  const result = await pollResult(requestId);
  const url = collectMediaUrls(result)[0];
  if (!url) throw new Error(`Higgsfield imagem nao retornou URL (request ${requestId})`);
  return { mediaUrl: url, requestId };
}

export async function generateVideoWithDefaults(input: {
  prompt: string;
  referenceImageUrl: string;
}): Promise<{ mediaUrl: string; requestId: string }> {
  const candidates = [
    // Politica aprovada (pode nao existir no endpoint atual).
    "kling3_0",
    // Fallbacks validos no endpoint atual.
    "kling-video/v2.1/pro/image-to-video",
    "higgsfield-ai/dop/standard",
  ];
  const refUrl = input.referenceImageUrl && /^https?:\/\//.test(input.referenceImageUrl) ? input.referenceImageUrl : undefined;
  if (!refUrl) {
    throw new Error("Modelo de video atual exige image_url de referencia");
  }
  const { requestId } = await submitWithFallback(candidates, (modelId) => {
    const payload: Record<string, unknown> = {
      prompt: input.prompt,
      duration: 5,
      aspect_ratio: "16:9",
      mode: "std",
      sound: "off",
    };
    // Modelos i2v normalmente exigem imagem de entrada.
    if (refUrl) payload.image_url = refUrl;
    return payload;
  });
  const result = await pollResult(requestId);
  const url = collectMediaUrls(result)[0];
  if (!url) throw new Error(`Higgsfield video nao retornou URL (request ${requestId})`);
  return { mediaUrl: url, requestId };
}

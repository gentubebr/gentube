import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runHiggsfieldCliCaptured } from "./higgsfield-agents.js";

const IMAGE_JOB_SET = "nano_banana_flash";
const VIDEO_JOB_SET = "kling3_0";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Referencia aceita pelo hf como upload id ou job id (UUID). */
export function isHfMediaReferenceUuid(ref: string): boolean {
  return UUID_RE.test(ref.trim());
}

/** Saida de `hf generate create ... --json` sem `--wait`: costuma ser `["<uuid>"]`. */
export function parseCreateJobIdsFromStdout(stdout: string): string[] {
  const trimmed = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const startObj = trimmed.lastIndexOf("{");
    const startArr = trimmed.lastIndexOf("[");
    const cut = Math.max(startObj, startArr);
    if (cut >= 0) {
      parsed = JSON.parse(trimmed.slice(cut));
    } else {
      throw new Error(`Higgsfield CLI create async: JSON invalido: ${trimmed.slice(0, 400)}`);
    }
  }
  if (Array.isArray(parsed)) {
    const ids = parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
    if (ids.length === 0) throw new Error("Higgsfield CLI create async: array de ids vazio");
    return ids;
  }
  if (typeof parsed === "object" && parsed !== null) {
    const id = (parsed as Record<string, unknown>).id;
    if (typeof id === "string" && id) return [id];
  }
  throw new Error("Higgsfield CLI create async: formato de resposta inesperado");
}

export type HfGenerateGetPayload = {
  id: string;
  status: string;
  result_url?: string;
  job_set_type?: string;
};

export function parseGenerateGetJson(stdout: string): HfGenerateGetPayload {
  const trimmed = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const cut = trimmed.lastIndexOf("{");
    if (cut < 0) throw new Error(`Higgsfield CLI get: JSON invalido: ${trimmed.slice(0, 400)}`);
    parsed = JSON.parse(trimmed.slice(cut));
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Higgsfield CLI get: resposta nao-objeto");
  }
  const o = parsed as Record<string, unknown>;
  const id = o.id;
  const status = o.status;
  const result_url = o.result_url;
  if (typeof id !== "string" || typeof status !== "string") {
    throw new Error("Higgsfield CLI get: id/status ausentes");
  }
  return {
    id,
    status,
    result_url: typeof result_url === "string" ? result_url : undefined,
    job_set_type: typeof o.job_set_type === "string" ? o.job_set_type : undefined,
  };
}

function parseGenerateStdoutJson(stdout: string): { resultUrl: string; jobId: string } {
  const trimmed = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf("[");
    const startObj = trimmed.lastIndexOf("{");
    const cut = Math.max(start, startObj);
    if (cut >= 0) {
      try {
        parsed = JSON.parse(trimmed.slice(cut));
      } catch {
        throw new Error(`Higgsfield CLI: JSON invalido na saida (trecho): ${trimmed.slice(0, 400)}`);
      }
    } else {
      throw new Error(`Higgsfield CLI: nenhum JSON na saida: ${trimmed.slice(0, 400)}`);
    }
  }

  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (typeof first !== "object" || first === null) {
    throw new Error("Higgsfield CLI: resposta JSON inesperada (nao-objeto)");
  }
  const o = first as Record<string, unknown>;
  const resultUrl = o.result_url;
  const id = o.id;
  if (typeof resultUrl !== "string" || !/^https?:\/\//.test(resultUrl)) {
    throw new Error("Higgsfield CLI: campo result_url ausente ou invalido no JSON");
  }
  const jobId = typeof id === "string" && id ? id : "unknown";
  return { resultUrl, jobId };
}

async function downloadUrlToTempFile(url: string, ext: ".png" | ".jpg" | ".jpeg"): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download imagem referencia falhou (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gentube-hf-ref-"));
  const file = path.join(dir, `ref${ext}`);
  await fs.writeFile(file, buf);
  return file;
}

/** Resolve URL https ou caminho local existente para um arquivo local (--image / --start-image). */
export async function resolveReferenceImageToLocalFile(
  ref?: string
): Promise<string | undefined> {
  if (!ref?.trim()) return undefined;
  const t = ref.trim();
  if (isHfMediaReferenceUuid(t)) return t;
  if (/^https?:\/\//i.test(t)) {
    const lower = t.split("?")[0]?.toLowerCase() ?? "";
    const ext = lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? ".jpg" : ".png";
    return downloadUrlToTempFile(t, ext);
  }
  try {
    await fs.access(t);
  } catch {
    throw new Error(`Imagem de referencia inexistente ou inacessivel: ${t}`);
  }
  return path.resolve(t);
}

async function runGenerateCreate(args: string[]): Promise<{ mediaUrl: string; requestId: string }> {
  const waitTimeout = (process.env.HIGGSFIELD_CLI_WAIT_TIMEOUT ?? "15m").trim() || "15m";
  const full = [...args, "--wait", "--json", "--no-color", "--wait-timeout", waitTimeout];
  const { code, stdout, stderr } = await runHiggsfieldCliCaptured(full);
  if (code !== 0) {
    const errTail = stderr.trim() || stdout.trim().slice(0, 500);
    throw new Error(`Higgsfield CLI encerrou com codigo ${code}: ${errTail}`);
  }
  const { resultUrl, jobId } = parseGenerateStdoutJson(stdout);
  return { mediaUrl: resultUrl, requestId: jobId };
}

/** `hf generate create ... --json` sem `--wait`; retorna ids de job. */
export async function runGenerateCreateAsync(args: string[]): Promise<string[]> {
  const full = [...args, "--json", "--no-color"];
  const { code, stdout, stderr } = await runHiggsfieldCliCaptured(full);
  if (code !== 0) {
    const errTail = stderr.trim() || stdout.trim().slice(0, 500);
    throw new Error(`Higgsfield CLI create async codigo ${code}: ${errTail}`);
  }
  return parseCreateJobIdsFromStdout(stdout);
}

/** `hf generate get <id> --json` */
export async function runGenerateGetJson(jobId: string): Promise<HfGenerateGetPayload> {
  const { code, stdout, stderr } = await runHiggsfieldCliCaptured(["generate", "get", jobId, "--json"]);
  if (code !== 0) {
    const errTail = stderr.trim() || stdout.trim().slice(0, 500);
    throw new Error(`Higgsfield CLI get ${jobId} codigo ${code}: ${errTail}`);
  }
  return parseGenerateGetJson(stdout);
}

/**
 * Gera imagem via binario `higgsfield`/`hf` (creditos da conta web/CLI).
 * Politica: nano_banana_flash, 16:9, 1k; referencia opcional via --image (path ou upload automatico).
 */
/** Enfileira imagem (sem `--wait`); retorna `hf_job_id`. */
export async function enqueueImageWithDefaultsCli(input: {
  prompt: string;
  referenceImageUrl?: string;
}): Promise<string> {
  let tempRef: string | undefined;
  try {
    tempRef = await resolveReferenceImageToLocalFile(input.referenceImageUrl);
    const argv = [
      "generate",
      "create",
      IMAGE_JOB_SET,
      "--prompt",
      input.prompt,
      "--aspect_ratio",
      "16:9",
      "--resolution",
      "1k",
    ];
    if (tempRef) argv.push("--image", tempRef);
    const ids = await runGenerateCreateAsync(argv);
    return ids[0]!;
  } finally {
    if (tempRef?.includes("gentube-hf-ref-")) {
      await fs.rm(path.dirname(tempRef), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function generateImageWithDefaultsCli(input: {
  prompt: string;
  referenceImageUrl?: string;
}): Promise<{ mediaUrl: string; requestId: string }> {
  let tempRef: string | undefined;
  try {
    tempRef = await resolveReferenceImageToLocalFile(input.referenceImageUrl);
    const argv = [
      "generate",
      "create",
      IMAGE_JOB_SET,
      "--prompt",
      input.prompt,
      "--aspect_ratio",
      "16:9",
      "--resolution",
      "1k",
    ];
    if (tempRef) argv.push("--image", tempRef);
    return await runGenerateCreate(argv);
  } finally {
    if (tempRef?.includes("gentube-hf-ref-")) {
      await fs.rm(path.dirname(tempRef), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Gera video via CLI (kling3_0): exige frame inicial local ou URL (baixada para temp).
 */
/** Enfileira video (sem `--wait`); retorna `hf_job_id`. */
export async function enqueueVideoWithDefaultsCli(input: {
  prompt: string;
  referenceImageUrl: string;
}): Promise<string> {
  if (!input.referenceImageUrl?.trim()) {
    throw new Error("Video CLI exige imagem inicial (--start-image)");
  }
  let tempRef: string | undefined;
  try {
    const raw = input.referenceImageUrl.trim();
    tempRef = isHfMediaReferenceUuid(raw) ? raw : await resolveReferenceImageToLocalFile(input.referenceImageUrl);
    if (!tempRef) throw new Error("Nao foi possivel resolver imagem inicial para o video");
    const argv = [
      "generate",
      "create",
      VIDEO_JOB_SET,
      "--prompt",
      input.prompt,
      "--start-image",
      tempRef,
      "--duration",
      "5",
      "--aspect_ratio",
      "16:9",
      "--mode",
      "std",
      "--sound",
      "off",
    ];
    const ids = await runGenerateCreateAsync(argv);
    return ids[0]!;
  } finally {
    if (tempRef?.includes("gentube-hf-ref-")) {
      await fs.rm(path.dirname(tempRef), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Enfileira thumbnail (sem --wait): aceita multiplos --image (referencia + avatar).
 * Modelo nano_banana_flash, 16:9, 1k.
 */
export async function enqueueThumbnailCli(input: {
  prompt: string;
  imageFiles: string[];
}): Promise<string> {
  const resolved: string[] = [];
  try {
    for (const img of input.imageFiles) {
      const local = await resolveReferenceImageToLocalFile(img);
      if (local) resolved.push(local);
    }
    const argv = [
      "generate",
      "create",
      IMAGE_JOB_SET,
      "--prompt",
      input.prompt,
      "--aspect_ratio",
      "16:9",
      "--resolution",
      "1k",
    ];
    for (const r of resolved) {
      argv.push("--image", r);
    }
    const ids = await runGenerateCreateAsync(argv);
    return ids[0]!;
  } finally {
    for (const r of resolved) {
      if (r.includes("gentube-hf-ref-")) {
        await fs.rm(path.dirname(r), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

export async function generateThumbnailCli(input: {
  prompt: string;
  imageFiles: string[];
}): Promise<{ mediaUrl: string; requestId: string }> {
  const resolved: string[] = [];
  try {
    for (const img of input.imageFiles) {
      const local = await resolveReferenceImageToLocalFile(img);
      if (local) resolved.push(local);
    }
    const argv = [
      "generate",
      "create",
      IMAGE_JOB_SET,
      "--prompt",
      input.prompt,
      "--aspect_ratio",
      "16:9",
      "--resolution",
      "1k",
    ];
    for (const r of resolved) {
      argv.push("--image", r);
    }
    return await runGenerateCreate(argv);
  } finally {
    for (const r of resolved) {
      if (r.includes("gentube-hf-ref-")) {
        await fs.rm(path.dirname(r), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

export async function generateVideoWithDefaultsCli(input: {
  prompt: string;
  referenceImageUrl: string;
}): Promise<{ mediaUrl: string; requestId: string }> {
  if (!input.referenceImageUrl?.trim()) {
    throw new Error("Video CLI exige imagem inicial (--start-image)");
  }
  let tempRef: string | undefined;
  try {
    const raw = input.referenceImageUrl.trim();
    tempRef = isHfMediaReferenceUuid(raw) ? raw : await resolveReferenceImageToLocalFile(input.referenceImageUrl);
    if (!tempRef) throw new Error("Nao foi possivel resolver imagem inicial para o video");
    const argv = [
      "generate",
      "create",
      VIDEO_JOB_SET,
      "--prompt",
      input.prompt,
      "--start-image",
      tempRef,
      "--duration",
      "5",
      "--aspect_ratio",
      "16:9",
      "--mode",
      "std",
      "--sound",
      "off",
    ];
    return await runGenerateCreate(argv);
  } finally {
    if (tempRef?.includes("gentube-hf-ref-")) {
      await fs.rm(path.dirname(tempRef), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runHiggsfieldCliCaptured } from "./higgsfield-agents.js";

const IMAGE_JOB_SET = "nano_banana_flash";
const VIDEO_JOB_SET = "kling3_0";

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

/**
 * Gera imagem via binario `higgsfield`/`hf` (creditos da conta web/CLI).
 * Politica: nano_banana_flash, 16:9, 1k; referencia opcional via --image (path ou upload automatico).
 */
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
export async function generateVideoWithDefaultsCli(input: {
  prompt: string;
  referenceImageUrl: string;
}): Promise<{ mediaUrl: string; requestId: string }> {
  if (!input.referenceImageUrl?.trim()) {
    throw new Error("Video CLI exige imagem inicial (--start-image)");
  }
  let tempRef: string | undefined;
  try {
    tempRef = await resolveReferenceImageToLocalFile(input.referenceImageUrl);
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

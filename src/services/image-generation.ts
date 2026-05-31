import crypto from "node:crypto";
import path from "node:path";
import {
  type ImageBackend,
  type ImageDeliveryMode,
  type ImageRunFlags,
  higgsfieldDisabled,
  resolveImageBackend,
  resolveImageDelivery,
  resolveSceneImageDelivery,
  resolveVisualModality,
} from "../config.js";
import {
  enqueueImageWithDefaultsCli,
  generateImageWithDefaultsCli,
} from "../integrations/higgsfield-cli.js";
import { submitGoogleImageBatch } from "../integrations/gemini-batch.js";
import { generateGeminiImageSync } from "../integrations/gemini-image.js";
import { findDoneImageJobByHash, insertImageJob, listImageJobsByBatchId, updateImageJob } from "../repository.js";
import type { ImageJobProvider } from "../types/image-jobs.js";
import { processLocalImageBatch } from "./image-local-batch.js";

const GENTUBE_HF_ASYNC = ["1", "true", "yes"].includes(
  String(process.env.GENTUBE_HF_ASYNC ?? "").toLowerCase()
);

export type RenderImageInput = {
  projectId: number;
  blockNumber: number;
  shotId: string;
  prompt: string;
  outPathNoExt: string;
  referenceImageUrl?: string;
  flags?: ImageRunFlags;
  /** Forca sync (ex.: bootstrap de video antes do batch do bloco). */
  forceSync?: boolean;
};

export type RenderImageResult = {
  provider: ImageJobProvider;
  doneSync: boolean;
  queued: boolean;
  batchId?: string;
  localPath?: string;
};

async function downloadHfToDisk(
  mediaUrl: string,
  outPathNoExt: string
): Promise<string> {
  const res = await fetch(mediaUrl);
  if (!res.ok) throw new Error(`Download HF falhou (${res.status})`);
  const arr = await res.arrayBuffer();
  const ct = res.headers.get("content-type") ?? "";
  const ext = ct.includes("jpeg") ? ".jpg" : ct.includes("webp") ? ".webp" : ".png";
  const localPath = `${outPathNoExt}${ext}`;
  const fs = await import("node:fs/promises");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, Buffer.from(arr));
  return localPath;
}

async function tryHiggsfieldImage(input: RenderImageInput, promptHash?: string): Promise<{ localPath?: string; hfJobId?: string }> {
  if (higgsfieldDisabled()) {
    throw new Error("Higgsfield desabilitado (GENTUBE_DISABLE_HIGGSFIELD=1)");
  }
  if (GENTUBE_HF_ASYNC) {
    const hfJobId = await enqueueImageWithDefaultsCli({
      prompt: input.prompt,
      referenceImageUrl: input.referenceImageUrl,
    });
    insertImageJob({
      projectId: input.projectId,
      blockNumber: input.blockNumber,
      shotId: input.shotId,
      provider: "higgsfield",
      deliveryMode: "sync",
      outPathNoExt: input.outPathNoExt,
      externalId: hfJobId,
      promptText: input.prompt,
      promptHash: promptHash ?? null,
      referenceImagePath: input.referenceImageUrl,
      status: "submitted",
    });
    return { hfJobId };
  }

  const out = await generateImageWithDefaultsCli({
    prompt: input.prompt,
    referenceImageUrl: input.referenceImageUrl,
  });
  const localPath = await downloadHfToDisk(out.mediaUrl, input.outPathNoExt);
  return { localPath };
}

async function renderGeminiSync(input: RenderImageInput, referencePath?: string, promptHash?: string): Promise<string> {
  const out = await generateGeminiImageSync({
    prompt: input.prompt,
    outPathNoExt: input.outPathNoExt,
    referenceImagePath: referencePath,
  });
  const jobId = insertImageJob({
    projectId: input.projectId,
    blockNumber: input.blockNumber,
    shotId: input.shotId,
    provider: "gemini",
    deliveryMode: "sync",
    outPathNoExt: input.outPathNoExt,
    promptText: input.prompt,
    promptHash: promptHash ?? null,
    referenceImagePath: referencePath ?? null,
    status: "completed",
    outcome: "done",
  });
  updateImageJob(jobId, {
    result_mime: out.mimeType,
    downloaded_at: new Date().toISOString(),
  });
  return out.localPath;
}

function queueGeminiBatchJob(input: RenderImageInput & { promptHash?: string }, batchId: string): RenderImageResult {
  insertImageJob({
    projectId: input.projectId,
    blockNumber: input.blockNumber,
    shotId: input.shotId,
    provider: "gemini",
    deliveryMode: "google_batch",
    outPathNoExt: input.outPathNoExt,
    batchId,
    promptText: input.prompt,
    promptHash: input.promptHash ?? null,
    referenceImagePath: input.referenceImageUrl ?? null,
  });
  return { provider: "gemini", doneSync: false, queued: true, batchId };
}

function queueGeminiLocalJob(input: RenderImageInput & { promptHash?: string }, batchId: string): RenderImageResult {
  insertImageJob({
    projectId: input.projectId,
    blockNumber: input.blockNumber,
    shotId: input.shotId,
    provider: "gemini",
    deliveryMode: "local_batch",
    outPathNoExt: input.outPathNoExt,
    batchId,
    promptText: input.prompt,
    promptHash: input.promptHash ?? null,
    referenceImagePath: input.referenceImageUrl ?? null,
  });
  return { provider: "gemini", doneSync: false, queued: true, batchId };
}

/** sha256(prompt + "|" + referenceImagePath) — identificador de unicidade da imagem. */
export function computeImagePromptHash(prompt: string, referenceImagePath?: string | null): string {
  return crypto
    .createHash("sha256")
    .update(`${prompt}|${referenceImagePath ?? ""}`)
    .digest("hex");
}

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;

/**
 * Tenta encontrar o arquivo de imagem gerado para um job done.
 * Varre extensoes comuns — retorna o primeiro path existente, ou null.
 */
async function resolveImageFilePath(outPathNoExt: string): Promise<string | null> {
  const { access } = await import("node:fs/promises");
  for (const ext of IMAGE_EXTENSIONS) {
    const p = `${outPathNoExt}${ext}`;
    try {
      await access(p);
      return p;
    } catch {
      // proximo
    }
  }
  return null;
}

export async function renderSceneImage(
  input: RenderImageInput,
  batchId?: string
): Promise<RenderImageResult> {
  const effectiveFlags = input.forceSync
    ? { googleBatchMode: false, batchLocal: false }
    : input.flags;
  const delivery = resolveSceneImageDelivery(effectiveFlags, { forceSync: input.forceSync });
  const backend =
    resolveVisualModality() === "wojak" ? "gemini" : resolveImageBackend(effectiveFlags, delivery);

  // P6 — Deduplicacao por hash de prompt: evita re-gerar imagens identicas.
  // Nao aplica em forceSync (bootstrap de video) nem em modos assincronos (batch ainda nao tem arquivo).
  const promptHash = computeImagePromptHash(input.prompt, input.referenceImageUrl);
  if (!input.forceSync && delivery !== "google_batch" && delivery !== "local_batch") {
    const existingJob = findDoneImageJobByHash(promptHash);
    if (existingJob) {
      const srcPath = await resolveImageFilePath(existingJob.out_path_no_ext);
      if (srcPath) {
        const { copyFile, mkdir } = await import("node:fs/promises");
        const ext = srcPath.slice(srcPath.lastIndexOf("."));
        const destPath = `${input.outPathNoExt}${ext}`;
        await mkdir(path.dirname(destPath), { recursive: true });
        await copyFile(srcPath, destPath);
        insertImageJob({
          projectId: input.projectId,
          blockNumber: input.blockNumber,
          shotId: input.shotId,
          provider: existingJob.provider,
          deliveryMode: "sync",
          outPathNoExt: input.outPathNoExt,
          promptText: input.prompt,
          promptHash,
          referenceImagePath: input.referenceImageUrl ?? null,
          status: "dedup",
          outcome: "done",
        });
        return { provider: existingJob.provider, doneSync: true, queued: false, localPath: destPath };
      }
    }
  }

  // Bootstrap de video (forceSync) deve concluir na hora; HF async nao serve aqui.
  if (input.forceSync) {
    const localPath = await renderGeminiSync(input, input.referenceImageUrl);
    return { provider: "gemini", doneSync: true, queued: false, localPath };
  }

  if (delivery === "google_batch") {
    const bid = batchId ?? crypto.randomUUID();
    return queueGeminiBatchJob({ ...input, flags: effectiveFlags, promptHash }, bid);
  }

  if (delivery === "local_batch") {
    const bid = batchId ?? crypto.randomUUID();
    return queueGeminiLocalJob({ ...input, flags: effectiveFlags, promptHash }, bid);
  }

  if (backend === "gemini") {
    const localPath = await renderGeminiSync(input, input.referenceImageUrl, promptHash);
    return { provider: "gemini", doneSync: true, queued: false, localPath };
  }

  if (backend === "higgsfield" && !higgsfieldDisabled()) {
    const hf = await tryHiggsfieldImage(input, promptHash);
    if (hf.hfJobId) {
      return { provider: "higgsfield", doneSync: false, queued: true };
    }
    return { provider: "higgsfield", doneSync: true, queued: false, localPath: hf.localPath };
  }

  // auto: HF then Gemini sync (HF omitido se GENTUBE_DISABLE_HIGGSFIELD=1)
  if (!higgsfieldDisabled()) {
    try {
      const hf = await tryHiggsfieldImage(input, promptHash);
      if (hf.hfJobId) {
        return { provider: "higgsfield", doneSync: false, queued: true };
      }
      return { provider: "higgsfield", doneSync: true, queued: false, localPath: hf.localPath };
    } catch (hfErr) {
      const hfMsg = hfErr instanceof Error ? hfErr.message : String(hfErr);
      try {
        const localPath = await renderGeminiSync(input, input.referenceImageUrl, promptHash);
        return { provider: "gemini", doneSync: true, queued: false, localPath };
      } catch (gemErr) {
        const gMsg = gemErr instanceof Error ? gemErr.message : String(gemErr);
        throw new Error(`HF: ${hfMsg} | Gemini fallback: ${gMsg}`);
      }
    }
  }

  const localPath = await renderGeminiSync(input, input.referenceImageUrl, promptHash);
  return { provider: "gemini", doneSync: true, queued: false, localPath };
}

/** Submete batches Google pendentes (sem external_id). Falha direto se submit falhar. */
export async function flushPendingGoogleBatches(batchIds: string[]): Promise<void> {
  const unique = [...new Set(batchIds.filter(Boolean))];
  for (const batchId of unique) {
    const jobs = listImageJobsByBatchId(batchId).filter(
      (j) => j.delivery_mode === "google_batch" && j.outcome === "pending" && !j.external_id
    );
    if (jobs.length === 0) continue;
    await submitGoogleImageBatch(jobs);
  }
}

/** Processa batch local imediatamente apos enfileirar cenas do bloco. */
export async function flushPendingLocalBatches(batchIds: string[]): Promise<void> {
  const unique = [...new Set(batchIds.filter(Boolean))];
  for (const batchId of unique) {
    const jobs = listImageJobsByBatchId(batchId).filter(
      (j) => j.delivery_mode === "local_batch" && j.outcome === "pending"
    );
    if (jobs.length === 0) continue;
    await processLocalImageBatch(jobs);
  }
}

export function shouldUseGeminiForImages(flags?: ImageRunFlags): boolean {
  const delivery = resolveImageDelivery(flags);
  const backend = resolveImageBackend(flags, delivery);
  return backend === "gemini" || delivery === "google_batch" || delivery === "local_batch";
}

export function isGoogleBatchMode(flags?: ImageRunFlags): boolean {
  return resolveSceneImageDelivery(flags) === "google_batch";
}

export { resolveImageBackend, resolveImageDelivery };
export type { ImageBackend, ImageDeliveryMode, ImageRunFlags };

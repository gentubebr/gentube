import crypto from "node:crypto";
import path from "node:path";
import {
  type ImageBackend,
  type ImageDeliveryMode,
  type ImageRunFlags,
  resolveImageBackend,
  resolveImageDelivery,
} from "../config.js";
import {
  enqueueImageWithDefaultsCli,
  generateImageWithDefaultsCli,
} from "../integrations/higgsfield-cli.js";
import { submitGoogleImageBatch } from "../integrations/gemini-batch.js";
import { generateGeminiImageSync } from "../integrations/gemini-image.js";
import { insertImageJob, listImageJobsByBatchId, updateImageJob } from "../repository.js";
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

async function tryHiggsfieldImage(input: RenderImageInput): Promise<{ localPath?: string; hfJobId?: string }> {
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

async function renderGeminiSync(input: RenderImageInput, referencePath?: string): Promise<string> {
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

function queueGeminiBatchJob(input: RenderImageInput, batchId: string): RenderImageResult {
  insertImageJob({
    projectId: input.projectId,
    blockNumber: input.blockNumber,
    shotId: input.shotId,
    provider: "gemini",
    deliveryMode: "google_batch",
    outPathNoExt: input.outPathNoExt,
    batchId,
    promptText: input.prompt,
    referenceImagePath: input.referenceImageUrl ?? null,
  });
  return { provider: "gemini", doneSync: false, queued: true, batchId };
}

function queueGeminiLocalJob(input: RenderImageInput, batchId: string): RenderImageResult {
  insertImageJob({
    projectId: input.projectId,
    blockNumber: input.blockNumber,
    shotId: input.shotId,
    provider: "gemini",
    deliveryMode: "local_batch",
    outPathNoExt: input.outPathNoExt,
    batchId,
    promptText: input.prompt,
    referenceImagePath: input.referenceImageUrl ?? null,
  });
  return { provider: "gemini", doneSync: false, queued: true, batchId };
}

export async function renderSceneImage(
  input: RenderImageInput,
  batchId?: string
): Promise<RenderImageResult> {
  const effectiveFlags = input.forceSync
    ? { googleBatchMode: false, batchLocal: false }
    : input.flags;
  const delivery = input.forceSync ? "sync" : resolveImageDelivery(effectiveFlags);
  const backend = resolveImageBackend(effectiveFlags, delivery);

  if (delivery === "google_batch") {
    const bid = batchId ?? crypto.randomUUID();
    return queueGeminiBatchJob({ ...input, flags: effectiveFlags }, bid);
  }

  if (delivery === "local_batch") {
    const bid = batchId ?? crypto.randomUUID();
    return queueGeminiLocalJob({ ...input, flags: effectiveFlags }, bid);
  }

  if (backend === "gemini") {
    const localPath = await renderGeminiSync(input, input.referenceImageUrl);
    return { provider: "gemini", doneSync: true, queued: false, localPath };
  }

  if (backend === "higgsfield") {
    const hf = await tryHiggsfieldImage(input);
    if (hf.hfJobId) {
      return { provider: "higgsfield", doneSync: false, queued: true };
    }
    return { provider: "higgsfield", doneSync: true, queued: false, localPath: hf.localPath };
  }

  // auto: HF then Gemini sync on any failure
  try {
    const hf = await tryHiggsfieldImage(input);
    if (hf.hfJobId) {
      return { provider: "higgsfield", doneSync: false, queued: true };
    }
    return { provider: "higgsfield", doneSync: true, queued: false, localPath: hf.localPath };
  } catch (hfErr) {
    const hfMsg = hfErr instanceof Error ? hfErr.message : String(hfErr);
    try {
      const localPath = await renderGeminiSync(input, input.referenceImageUrl);
      return { provider: "gemini", doneSync: true, queued: false, localPath };
    } catch (gemErr) {
      const gMsg = gemErr instanceof Error ? gemErr.message : String(gemErr);
      throw new Error(`HF: ${hfMsg} | Gemini fallback: ${gMsg}`);
    }
  }
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
  return resolveImageDelivery(flags) === "google_batch";
}

export { resolveImageBackend, resolveImageDelivery };
export type { ImageBackend, ImageDeliveryMode, ImageRunFlags };

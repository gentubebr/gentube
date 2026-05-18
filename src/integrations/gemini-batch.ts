import { JobState } from "@google/genai";
import {
  GEMINI_IMAGE_ASPECT_RATIO,
  GEMINI_IMAGE_MODEL,
  GEMINI_IMAGE_SIZE,
} from "../config.js";
import type { ImageJobRow } from "../types/image-jobs.js";
import { extFromMime, extractInlineImageFromResponse, getGeminiClient } from "./gemini-image.js";
import fs from "node:fs/promises";
import path from "node:path";
import { updateImageJob } from "../repository.js";

function isBatchTerminalSuccess(state?: JobState | string): boolean {
  const s = String(state ?? "");
  return (
    s === JobState.JOB_STATE_SUCCEEDED ||
    s === "JOB_STATE_SUCCEEDED" ||
    s === JobState.JOB_STATE_PARTIALLY_SUCCEEDED ||
    s === "JOB_STATE_PARTIALLY_SUCCEEDED"
  );
}

function isBatchTerminalFailure(state?: JobState | string): boolean {
  const s = String(state ?? "");
  return (
    s === JobState.JOB_STATE_FAILED ||
    s === "JOB_STATE_FAILED" ||
    s === JobState.JOB_STATE_CANCELLED ||
    s === "JOB_STATE_CANCELLED" ||
    s === JobState.JOB_STATE_EXPIRED ||
    s === "JOB_STATE_EXPIRED"
  );
}

/** Submete batch Google com pedidos inline; devolve resource name do batch. */
export async function submitGoogleImageBatch(
  jobs: ImageJobRow[],
  opts?: { skipDb?: boolean }
): Promise<string> {
  if (jobs.length === 0) throw new Error("submitGoogleImageBatch: lista vazia");
  const ai = getGeminiClient();

  const inlinedRequests = jobs.map((job) => ({
    contents: [
      {
        role: "user",
        parts: [{ text: job.prompt_text ?? "" }],
      },
    ],
    config: {
      responseModalities: ["IMAGE"],
      imageConfig: {
        aspectRatio: GEMINI_IMAGE_ASPECT_RATIO,
        imageSize: GEMINI_IMAGE_SIZE,
      },
    },
    metadata: {
      image_job_id: String(job.id),
      shot_id: job.shot_id,
    },
  }));

  const batchJob = await ai.batches.create({
    model: GEMINI_IMAGE_MODEL,
    src: inlinedRequests,
    config: {
      displayName: `gentube-${jobs[0]!.project_id}-b${jobs[0]!.block_number}-${jobs[0]!.batch_id?.slice(0, 8) ?? "batch"}`,
    },
  });

  const name = batchJob.name;
  if (!name?.trim()) {
    throw new Error("Gemini batch: resposta sem name do job");
  }

  if (!opts?.skipDb) {
    for (const job of jobs) {
      updateImageJob(job.id, {
        external_id: name,
        status: "submitted",
      });
    }
  }

  return name;
}

export async function pollGoogleBatchOnce(batchName: string): Promise<{
  state: string;
  done: boolean;
  failed: boolean;
}> {
  const ai = getGeminiClient();
  const batch = await ai.batches.get({ name: batchName });
  const state = String(batch.state ?? "");
  return {
    state,
    done: isBatchTerminalSuccess(state),
    failed: isBatchTerminalFailure(state),
  };
}

/** Aplica respostas inline do batch concluido aos image_jobs (ou so grava em disco se skipDb). */
export async function applyGoogleBatchResults(
  batchName: string,
  jobs: ImageJobRow[],
  opts?: { skipDb?: boolean }
): Promise<void> {
  const ai = getGeminiClient();
  const batch = await ai.batches.get({ name: batchName });
  const state = String(batch.state ?? "");

  if (isBatchTerminalFailure(state)) {
    const errMsg = batch.error?.message ?? `batch state=${state}`;
    for (const job of jobs) {
      if (!opts?.skipDb) {
        updateImageJob(job.id, {
          outcome: "failed",
          status: "failed",
          error_message: errMsg,
        });
      }
    }
    throw new Error(errMsg);
  }

  if (!isBatchTerminalSuccess(state)) {
    return;
  }

  const responses = batch.dest?.inlinedResponses;
  if (!responses?.length) {
    const errMsg = "Gemini batch concluido sem inlinedResponses";
    for (const job of jobs) {
      if (!opts?.skipDb) {
        updateImageJob(job.id, {
          outcome: "failed",
          status: "failed",
          error_message: errMsg,
        });
      }
    }
    throw new Error(errMsg);
  }

  const jobById = new Map(jobs.map((j) => [String(j.id), j]));

  for (let i = 0; i < responses.length; i += 1) {
    const inlined = responses[i]!;
    const metaId = inlined.metadata?.image_job_id;
    const job =
      (metaId ? jobById.get(metaId) : undefined) ??
      (jobs.length === responses.length ? jobs[i] : undefined);

    if (!job) continue;

    if (inlined.error) {
      if (!opts?.skipDb) {
        updateImageJob(job.id, {
          outcome: "failed",
          status: "failed",
          error_message: inlined.error.message ?? "erro no batch item",
        });
      }
      continue;
    }

    const extracted = inlined.response ? extractInlineImageFromResponse(inlined.response) : null;
    if (!extracted) {
      if (!opts?.skipDb) {
        updateImageJob(job.id, {
          outcome: "failed",
          status: "failed",
          error_message: "resposta batch sem imagem",
        });
      }
      continue;
    }

    const ext = extFromMime(extracted.mimeType);
    const localPath = `${job.out_path_no_ext}${ext}`;
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, Buffer.from(extracted.base64, "base64"));
    if (!opts?.skipDb) {
      const now = new Date().toISOString();
      updateImageJob(job.id, {
        outcome: "done",
        status: "completed",
        result_mime: extracted.mimeType,
        downloaded_at: now,
      });
    }
  }
}

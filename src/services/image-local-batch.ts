import chalk from "chalk";
import { GEMINI_LOCAL_BATCH_CONCURRENCY } from "../config.js";
import { generateGeminiImageSync } from "../integrations/gemini-image.js";
import { updateImageJob } from "../repository.js";
import type { ImageJobRow } from "../types/image-jobs.js";

async function runPool<T>(items: T[], concurrency: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = next;
      next += 1;
      if (idx >= items.length) break;
      await fn(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
}

export async function processLocalImageBatch(
  jobs: ImageJobRow[],
  concurrency?: number,
  opts?: { skipDb?: boolean }
): Promise<void> {
  const limit = concurrency ?? GEMINI_LOCAL_BATCH_CONCURRENCY;
  await runPool(jobs, limit, async (job, idx) => {
    const tag = chalk.dim(`[batch-local ${idx + 1}/${jobs.length}]`);
    try {
      if (!job.prompt_text?.trim()) {
        throw new Error("prompt_text ausente no image_job");
      }
      const out = await generateGeminiImageSync({
        prompt: job.prompt_text,
        outPathNoExt: job.out_path_no_ext,
        referenceImagePath: job.reference_image_path ?? undefined,
      });
      if (!opts?.skipDb) {
        const now = new Date().toISOString();
        updateImageJob(job.id, {
          outcome: "done",
          status: "completed",
          result_mime: out.mimeType,
          downloaded_at: now,
        });
      }
      console.log(chalk.green(`${tag} ${job.shot_id} → ${out.localPath}`));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!opts?.skipDb) {
        updateImageJob(job.id, { outcome: "failed", status: "failed", error_message: msg });
      }
      console.log(chalk.red(`${tag} ${job.shot_id} FALHOU: ${msg}`));
    }
  });
}

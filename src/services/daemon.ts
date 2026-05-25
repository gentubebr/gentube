/**
 * Daemon GenTube — processa jobs da tabela job_queue em background.
 *
 * Uso:
 *   gentube daemon:start    — inicia daemon detached (escreve data/daemon.pid)
 *   gentube daemon:stop     — envia SIGTERM ao daemon pelo PID
 *   gentube daemon:status   — mostra se daemon esta vivo e o job em execucao
 *   gentube daemon:run      — loop interno (chamado pelo daemon:start, nao usar diretamente)
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import {
  imageRunFlagsFromCli,
  assertImagensPhaseFlagsExclusive,
  DEFAULT_MAX_IMAGES_BLOCK1,
  DEFAULT_MAX_IMAGES_OTHER_BLOCKS,
  DEFAULT_MAX_VIDEOS_BLOCK1,
  DEFAULT_MAX_VIDEOS_OTHER_BLOCKS,
} from "../config.js";
import { parseIntervalMs } from "../utils/parse-interval.js";
import { getProjectById } from "../repository.js";
import {
  claimNextPendingJob,
  finishJob,
  recoverStalledJobs,
  type JobQueueRow,
  type JobQueueOptions,
} from "../repository-jobs.js";
import { runFullPipeline } from "./pipeline-orchestrator.js";
import type { PipelineStage } from "./pipeline-orchestrator.js";
import type { Step3Limits } from "../types/step3-limits.js";
import type { ImagensVideosOptions } from "./pipeline.js";

export const DAEMON_PID_FILE = path.join(DATA_DIR, "daemon.pid");
export const DAEMON_LOG_FILE = path.join(DATA_DIR, "daemon.log");

const POLL_INTERVAL_MS = (() => {
  const v = parseInt(process.env.GENTUBE_DAEMON_POLL_MS ?? "", 10);
  return isNaN(v) ? 10_000 : v;
})();

// ---------------------------------------------------------------------------
// PID helpers
// ---------------------------------------------------------------------------

export function readDaemonPid(): number | null {
  try {
    const raw = fs.readFileSync(DAEMON_PID_FILE, "utf8").trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function isDaemonRunning(): boolean {
  const pid = readDaemonPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writePid(pid: number): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DAEMON_PID_FILE, String(pid), "utf8");
}

function removePid(): void {
  try {
    fs.unlinkSync(DAEMON_PID_FILE);
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------
// Option building (replica de invokeRunPipeline sem dependencia de index.ts)
// ---------------------------------------------------------------------------

const PIPELINE_STAGES: PipelineStage[] = [
  "roteiro",
  "quality_gate",
  "imagens",
  "image_sync",
  "imagens_retry",
  "narracao",
  "montagem",
  "thumbnails",
];

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = parseInt(value, 10);
  return isNaN(n) || n < 0 ? fallback : n;
}

function buildPipelineOptions(opts: JobQueueOptions): Parameters<typeof runFullPipeline>[1] {
  const profile = (opts.profile ?? "wojak-images-only") as "wojak-images-only";

  let fromStage: PipelineStage | undefined;
  let throughStage: PipelineStage | undefined;
  if (opts.throughStage?.trim()) {
    const s = opts.throughStage.trim() as PipelineStage;
    if (PIPELINE_STAGES.includes(s)) throughStage = s;
  }
  if (opts.fromStage?.trim()) {
    const s = opts.fromStage.trim() as PipelineStage;
    if (PIPELINE_STAGES.includes(s)) fromStage = s;
  }

  const limits: Step3Limits = {
    maxVideosBlock1: 0,
    maxVideosOtherBlocks: 0,
    maxImagesBlock1: parsePositiveInt(opts.maxImagesBlock1, DEFAULT_MAX_IMAGES_BLOCK1),
    maxImagesOtherBlocks: parsePositiveInt(opts.maxImagesOther, DEFAULT_MAX_IMAGES_OTHER_BLOCKS),
  };

  const imageFlags = imageRunFlagsFromCli({
    googleBatchMode: opts.googleBatchMode ?? true,
    batchLocal: false,
  });
  assertImagensPhaseFlagsExclusive({});

  const scenePlanV2 =
    opts.scenePlanV2 === true ||
    ["1", "true", "yes"].includes(String(process.env.GENTUBE_SCENE_PLAN_V2 ?? "").toLowerCase());

  const imagensOpts: ImagensVideosOptions = {
    scenePlanV2,
    imageFlags,
    planOnly: false,
    enqueueOnly: false,
  };

  const avatarAbs = opts.avatarFile ? path.resolve(opts.avatarFile) : undefined;

  return {
    profile,
    voiceId: opts.voiceId,
    continueOnError: opts.continueOnError !== false,
    maxRetriesPerBlock: parsePositiveInt(opts.maxRetriesPerBlock, 2),
    avatarPath: avatarAbs,
    promptMatrix: opts.promptMatrix,
    promptCanalVoice: opts.promptCanalVoice,
    skipThumbnails: Boolean(opts.skipThumbnails),
    fromStage,
    throughStage,
    imageSyncIntervalMs: parseIntervalMs(opts.imageSyncInterval, 30_000),
    imageSyncMaxRounds: parsePositiveInt(opts.imageSyncMaxRounds, 500),
    limits,
    imagensOpts,
    montagemPhase: opts.montagemScenesOnly ? "scenes" : opts.montagemAssembleOnly ? "assemble" : undefined,
    montagemForce: Boolean(opts.montagemForce),
    thumbnailReferenceUrl: opts.referenceUrl,
    thumbnailCount: parsePositiveInt(opts.count, 2),
    thumbnailPrompt: opts.prompt,
  };
}

// ---------------------------------------------------------------------------
// Job execution
// ---------------------------------------------------------------------------

async function runJob(job: JobQueueRow): Promise<void> {
  const opts: JobQueueOptions = JSON.parse(job.options_json);
  const project = getProjectById(job.project_id);
  if (!project) throw new Error(`Projeto ${job.project_id} nao encontrado`);

  const pipelineOpts = buildPipelineOptions(opts);
  const summary = await runFullPipeline(project, pipelineOpts);

  if (summary.status !== "success" && summary.status !== "partial") {
    throw new Error(`Pipeline terminou com status: ${summary.status}`);
  }

  finishJob(job.id, { status: "done", runId: summary.runId });
}

// ---------------------------------------------------------------------------
// Daemon loop
// ---------------------------------------------------------------------------

let stopping = false;

export async function runDaemonLoop(): Promise<void> {
  const pid = process.pid;
  writePid(pid);

  process.on("SIGTERM", () => {
    daemonLog("SIGTERM recebido — aguardando fim do job atual...");
    stopping = true;
  });
  process.on("SIGINT", () => {
    daemonLog("SIGINT recebido — encerrando");
    stopping = true;
  });

  const recovered = recoverStalledJobs();
  if (recovered > 0) {
    daemonLog(`${recovered} job(s) travado(s) recuperado(s) como 'failed'`);
  }

  daemonLog(`Daemon iniciado (PID ${pid}). Poll a cada ${POLL_INTERVAL_MS / 1000}s`);

  while (!stopping) {
    const job = claimNextPendingJob(pid);
    if (job) {
      daemonLog(`Iniciando job #${job.id} (projeto ${job.project_id})`);
      try {
        await runJob(job);
        daemonLog(`Job #${job.id} concluido`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        daemonLog(`Job #${job.id} falhou: ${msg}`);
        finishJob(job.id, { status: "failed", errorMessage: msg });
      }
    } else {
      await sleep(POLL_INTERVAL_MS);
    }
  }

  removePid();
  daemonLog("Daemon encerrado");
}

function daemonLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(DAEMON_LOG_FILE, line);
  } catch {
    // nao fatal
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

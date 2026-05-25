import { getDb, nowIso } from "./db.js";

export type JobQueueStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export type JobQueueRow = {
  id: number;
  project_id: number;
  profile: string;
  status: JobQueueStatus;
  priority: number;
  options_json: string;
  run_id: number | null;
  worker_pid: number | null;
  error_message: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Opcoes serializadas no job_queue — subconjunto de RunPipelineCliOptions + voiceId. */
export type JobQueueOptions = {
  voiceId: string;
  profile?: string;
  fromStage?: string;
  throughStage?: string;
  promptMatrix?: string;
  promptCanalVoice?: string;
  avatarFile?: string;
  continueOnError?: boolean;
  maxRetriesPerBlock?: string;
  maxImagesBlock1?: string;
  maxImagesOther?: string;
  scenePlanV2?: boolean;
  googleBatchMode?: boolean;
  imageSyncInterval?: string;
  imageSyncMaxRounds?: string;
  skipThumbnails?: boolean;
  referenceUrl?: string;
  count?: string;
  prompt?: string;
  montagemForce?: boolean;
  montagemScenesOnly?: boolean;
  montagemAssembleOnly?: boolean;
};

export function enqueueJob(input: {
  projectId: number;
  profile?: string;
  priority?: number;
  options: JobQueueOptions;
}): number {
  const now = nowIso();
  const r = getDb()
    .prepare(
      `INSERT INTO job_queue
        (project_id, profile, status, priority, options_json, queued_at, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
    )
    .run(
      input.projectId,
      input.profile ?? "wojak-images-only",
      input.priority ?? 0,
      JSON.stringify(input.options),
      now,
      now,
      now,
    );
  return Number(r.lastInsertRowid);
}

export function claimNextPendingJob(workerPid: number): JobQueueRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM job_queue WHERE status = 'pending'
       ORDER BY priority DESC, id ASC LIMIT 1`,
    )
    .get() as JobQueueRow | undefined;
  if (!row) return null;
  const now = nowIso();
  const changed = db
    .prepare(
      `UPDATE job_queue SET status = 'running', worker_pid = ?, started_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(workerPid, now, now, row.id);
  if (changed.changes === 0) return null; // race — outra instancia pegou antes
  return { ...row, status: "running", worker_pid: workerPid, started_at: now };
}

export function finishJob(
  id: number,
  result: { status: "done" | "failed"; runId?: number | null; errorMessage?: string | null },
): void {
  const now = nowIso();
  getDb()
    .prepare(
      `UPDATE job_queue SET status = ?, run_id = ?, error_message = ?, finished_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(result.status, result.runId ?? null, result.errorMessage ?? null, now, now, id);
}

export function cancelJob(id: number): boolean {
  const now = nowIso();
  const r = getDb()
    .prepare(
      `UPDATE job_queue SET status = 'cancelled', updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(now, id);
  return r.changes > 0;
}

export function listJobs(opts?: { limit?: number; status?: JobQueueStatus }): JobQueueRow[] {
  const db = getDb();
  if (opts?.status) {
    return db
      .prepare(`SELECT * FROM job_queue WHERE status = ? ORDER BY id DESC LIMIT ?`)
      .all(opts.status, opts?.limit ?? 50) as JobQueueRow[];
  }
  return db
    .prepare(`SELECT * FROM job_queue ORDER BY id DESC LIMIT ?`)
    .all(opts?.limit ?? 50) as JobQueueRow[];
}

export function getJob(id: number): JobQueueRow | null {
  return (getDb().prepare(`SELECT * FROM job_queue WHERE id = ?`).get(id) as JobQueueRow | undefined) ?? null;
}

/** Marca jobs 'running' com PID morto como 'failed' (limpeza ao iniciar daemon). */
export function recoverStalledJobs(): number {
  const db = getDb();
  const running = db
    .prepare(`SELECT id, worker_pid FROM job_queue WHERE status = 'running'`)
    .all() as Array<{ id: number; worker_pid: number | null }>;
  let recovered = 0;
  const now = nowIso();
  for (const row of running) {
    const pidAlive = row.worker_pid !== null && isPidAlive(row.worker_pid);
    if (!pidAlive) {
      db.prepare(
        `UPDATE job_queue SET status = 'failed', error_message = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
      ).run(`Daemon encerrado durante execucao (PID ${row.worker_pid ?? "??"})`, now, now, row.id);
      recovered += 1;
    }
  }
  return recovered;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

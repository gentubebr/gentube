import fs from "node:fs/promises";
import path from "node:path";
import { getDb, nowIso } from "./db.js";
export type PipelineRunStatus = "running" | "success" | "partial" | "failed";
export type PipelineStepStatus = "pending" | "running" | "success" | "skipped" | "error";

export type PipelineRunRow = {
  id: number;
  project_id: number;
  profile: string;
  status: PipelineRunStatus;
  continue_on_error: number;
  current_stage: string | null;
  started_at: string;
  finished_at: string | null;
  summary_json: string | null;
  report_path: string | null;
};

export type PipelineRunStepRow = {
  id: number;
  run_id: number;
  stage: string;
  block_number: number | null;
  status: PipelineStepStatus;
  attempt: number;
  error_message: string | null;
  details_json: string | null;
  started_at: string | null;
  finished_at: string | null;
};

export function createPipelineRun(input: {
  projectId: number;
  profile: string;
  continueOnError: boolean;
}): number {
  const db = getDb();
  const now = nowIso();
  const r = db
    .prepare(
      `INSERT INTO pipeline_runs (
        project_id, profile, status, continue_on_error, current_stage,
        started_at, created_at, updated_at
      ) VALUES (?, ?, 'running', ?, NULL, ?, ?, ?)`,
    )
    .run(input.projectId, input.profile, input.continueOnError ? 1 : 0, now, now, now);
  return Number(r.lastInsertRowid);
}

export function updatePipelineRun(
  runId: number,
  fields: {
    status?: PipelineRunStatus;
    currentStage?: string | null;
    finishedAt?: string;
    summaryJson?: unknown;
    reportPath?: string;
  },
): void {
  const db = getDb();
  const now = nowIso();
  const sets: string[] = ["updated_at = ?"];
  const vals: unknown[] = [now];

  if (fields.status !== undefined) {
    sets.push("status = ?");
    vals.push(fields.status);
  }
  if (fields.currentStage !== undefined) {
    sets.push("current_stage = ?");
    vals.push(fields.currentStage);
  }
  if (fields.finishedAt !== undefined) {
    sets.push("finished_at = ?");
    vals.push(fields.finishedAt);
  }
  if (fields.summaryJson !== undefined) {
    sets.push("summary_json = ?");
    vals.push(JSON.stringify(fields.summaryJson));
  }
  if (fields.reportPath !== undefined) {
    sets.push("report_path = ?");
    vals.push(fields.reportPath);
  }

  vals.push(runId);
  db.prepare(`UPDATE pipeline_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function getPipelineRun(runId: number): PipelineRunRow | null {
  const db = getDb();
  return (db.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(runId) as PipelineRunRow | undefined) ?? null;
}

export function getLatestPipelineRun(projectId: number): PipelineRunRow | null {
  const db = getDb();
  return (
    (db
      .prepare("SELECT * FROM pipeline_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1")
      .get(projectId) as PipelineRunRow | undefined) ?? null
  );
}

export function insertPipelineRunStep(input: {
  runId: number;
  stage: string;
  blockNumber?: number;
  status?: PipelineStepStatus;
  attempt?: number;
  details?: unknown;
}): number {
  const db = getDb();
  const now = nowIso();
  const r = db
    .prepare(
      `INSERT INTO pipeline_run_steps (
        run_id, stage, block_number, status, attempt, details_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      input.stage,
      input.blockNumber ?? null,
      input.status ?? "pending",
      input.attempt ?? 1,
      input.details ? JSON.stringify(input.details) : null,
      now,
      now,
    );
  return Number(r.lastInsertRowid);
}

export function finishPipelineRunStep(
  stepId: number,
  status: PipelineStepStatus,
  errorMessage?: string,
  details?: unknown,
): void {
  const db = getDb();
  const now = nowIso();
  db.prepare(
    `UPDATE pipeline_run_steps SET
      status = ?, error_message = ?, details_json = COALESCE(?, details_json),
      finished_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    status,
    errorMessage ?? null,
    details !== undefined ? JSON.stringify(details) : null,
    now,
    now,
    stepId,
  );
}

export function startPipelineRunStep(stepId: number): void {
  const db = getDb();
  const now = nowIso();
  db.prepare(
    `UPDATE pipeline_run_steps SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?`,
  ).run(now, now, stepId);
}

export function listPipelineRunSteps(runId: number): PipelineRunStepRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM pipeline_run_steps WHERE run_id = ? ORDER BY id")
    .all(runId) as PipelineRunStepRow[];
}

export function countImageJobsFailed(projectId: number, blockNumber?: number): number {
  const db = getDb();
  if (blockNumber !== undefined) {
    const row = db
      .prepare(
        `SELECT COUNT(*) as n FROM image_jobs WHERE project_id = ? AND block_number = ? AND outcome = 'failed'`,
      )
      .get(projectId, blockNumber) as { n: number };
    return row.n;
  }
  const row = db
    .prepare(`SELECT COUNT(*) as n FROM image_jobs WHERE project_id = ? AND outcome = 'failed'`)
    .get(projectId) as { n: number };
  return row.n;
}

export function listBlockNumbersWithFailedImageJobs(projectId: number): number[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT block_number as bn FROM image_jobs
       WHERE project_id = ? AND outcome = 'failed' ORDER BY block_number`,
    )
    .all(projectId) as Array<{ bn: number }>;
  return rows.map((r) => r.bn);
}

export function deleteFailedImageJobsForBlock(projectId: number, blockNumber: number): number {
  const db = getDb();
  const r = db
    .prepare(
      `DELETE FROM image_jobs WHERE project_id = ? AND block_number = ? AND outcome = 'failed'`,
    )
    .run(projectId, blockNumber);
  return r.changes;
}

export async function writePipelineRunReport(
  projectPath: string,
  runId: number,
  payload: unknown,
): Promise<string> {
  const modelagemDir = path.join(projectPath, "05 - Modelagem");
  await fs.mkdir(modelagemDir, { recursive: true });
  const reportPath = path.join(modelagemDir, `pipeline-run-${runId}.json`);
  const latestPath = path.join(modelagemDir, "pipeline-run-latest.json");
  const body = JSON.stringify(payload, null, 2);
  await fs.writeFile(reportPath, body, "utf-8");
  await fs.writeFile(latestPath, body, "utf-8");
  return reportPath;
}

export function deletePipelineRunsForProject(projectId: number): void {
  const db = getDb();
  const runIds = db
    .prepare("SELECT id FROM pipeline_runs WHERE project_id = ?")
    .all(projectId) as Array<{ id: number }>;
  for (const { id } of runIds) {
    db.prepare("DELETE FROM pipeline_run_steps WHERE run_id = ?").run(id);
  }
  db.prepare("DELETE FROM pipeline_runs WHERE project_id = ?").run(projectId);
}

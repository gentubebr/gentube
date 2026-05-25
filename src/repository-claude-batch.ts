import { getDb, nowIso } from "./db.js";

export type ClaudeBatchJobRow = {
  id: number;
  project_id: number;
  stage: string;
  block_number: number | null;
  custom_id: string;
  batch_id: string;
  status: string;
  outcome: string;
  result_path: string | null;
  error_message: string | null;
};

export function insertClaudeBatchJob(input: {
  projectId: number;
  stage: string;
  blockNumber?: number | null;
  customId: string;
  batchId: string;
}): number {
  const now = nowIso();
  const r = getDb()
    .prepare(
      `INSERT INTO claude_batch_jobs (
        project_id, stage, block_number, custom_id, batch_id, status, outcome, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'submitted', 'pending', ?, ?)`,
    )
    .run(
      input.projectId,
      input.stage,
      input.blockNumber ?? null,
      input.customId,
      input.batchId,
      now,
      now,
    );
  return Number(r.lastInsertRowid);
}

export function updateClaudeBatchJob(
  id: number,
  patch: Partial<{
    status: string;
    outcome: string;
    result_path: string | null;
    error_message: string | null;
  }>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  fields.push("updated_at = ?");
  values.push(nowIso());
  values.push(id);
  getDb()
    .prepare(`UPDATE claude_batch_jobs SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
}

export function listClaudeBatchJobsPending(projectId?: number): ClaudeBatchJobRow[] {
  const sql = projectId
    ? `SELECT * FROM claude_batch_jobs WHERE outcome = 'pending' AND project_id = ? ORDER BY id`
    : `SELECT * FROM claude_batch_jobs WHERE outcome = 'pending' ORDER BY id`;
  return (projectId
    ? getDb().prepare(sql).all(projectId)
    : getDb().prepare(sql).all()) as ClaudeBatchJobRow[];
}

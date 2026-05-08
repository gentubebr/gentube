import { getDb, nowIso } from "./db.js";

export type BlockStatus = "pending" | "processing" | "success" | "error";

export function createChannel(nomeCanal: string, slugCanal: string, basePath: string): number {
  const db = getDb();
  const now = nowIso();
  const stmt = db.prepare(`
    INSERT INTO channels (nome_canal, slug_canal, base_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(nomeCanal, slugCanal, basePath, now, now);
  return Number(result.lastInsertRowid);
}

export function listChannels(): Array<{ id: number; nome_canal: string; slug_canal: string; base_path: string }> {
  const db = getDb();
  return db
    .prepare("SELECT id, nome_canal, slug_canal, base_path FROM channels ORDER BY nome_canal")
    .all() as Array<{ id: number; nome_canal: string; slug_canal: string; base_path: string }>;
}

export function findChannelByIdOrSlug(idOrSlug: string) {
  const db = getDb();
  const numericId = Number(idOrSlug);
  if (!Number.isNaN(numericId)) {
    const byId = db.prepare("SELECT * FROM channels WHERE id = ?").get(numericId);
    if (byId) return byId as Record<string, unknown>;
  }
  const bySlug = db.prepare("SELECT * FROM channels WHERE slug_canal = ?").get(idOrSlug);
  return (bySlug as Record<string, unknown>) ?? null;
}

export function createProject(input: {
  channelId: number;
  titulo: string;
  slug: string;
  dataProjeto: string;
  projectPath: string;
  totalBlocos: number;
  niche: string;
  audience: string;
  transcript?: string;
}): number {
  const db = getDb();
  const now = nowIso();
  const stmt = db.prepare(`
    INSERT INTO video_projects (
      channel_id, titulo, slug, data_projeto, project_path, total_blocos,
      niche, audience, transcript, status_roteiro, status_narracao,
      status_imagens_videos, status_thumbnails, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', 'pending', 'pending', ?, ?)
  `);
  const result = stmt.run(
    input.channelId,
    input.titulo,
    input.slug,
    input.dataProjeto,
    input.projectPath,
    input.totalBlocos,
    input.niche,
    input.audience,
    input.transcript ?? null,
    now,
    now
  );
  return Number(result.lastInsertRowid);
}

export function getProjectByIdOrSlug(idOrSlug: string) {
  const db = getDb();
  const numericId = Number(idOrSlug);
  if (!Number.isNaN(numericId)) {
    const byId = db.prepare("SELECT * FROM video_projects WHERE id = ?").get(numericId);
    if (byId) return byId as Record<string, unknown>;
  }
  const bySlug = db.prepare("SELECT * FROM video_projects WHERE slug = ?").get(idOrSlug);
  return (bySlug as Record<string, unknown>) ?? null;
}

export function updateProjectStageStatus(projectId: number, stage: "status_roteiro" | "status_narracao", status: BlockStatus): void {
  const db = getDb();
  db.prepare(`UPDATE video_projects SET ${stage} = ?, updated_at = ? WHERE id = ?`).run(status, nowIso(), projectId);
}

export function upsertScriptBlock(projectId: number, blockNumber: number, payload: Record<string, string | null>): void {
  const db = getDb();
  const now = nowIso();
  db.prepare(`
    INSERT INTO script_blocks (project_id, block_number, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, block_number) DO UPDATE SET updated_at = excluded.updated_at
  `).run(projectId, blockNumber, now, now);

  const fields = Object.keys(payload);
  if (fields.length === 0) return;
  const setClause = [...fields.map((f) => `${f} = ?`), "updated_at = ?"].join(", ");
  const values = [...fields.map((f) => payload[f] ?? null), now, projectId, blockNumber];
  db.prepare(`UPDATE script_blocks SET ${setClause} WHERE project_id = ? AND block_number = ?`).run(...values);
}

export function upsertNarrationBlock(projectId: number, blockNumber: number, payload: Record<string, string | null>): void {
  const db = getDb();
  const now = nowIso();
  db.prepare(`
    INSERT INTO narration_blocks (project_id, block_number, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, block_number) DO UPDATE SET updated_at = excluded.updated_at
  `).run(projectId, blockNumber, now, now);

  const fields = Object.keys(payload);
  if (fields.length === 0) return;
  const setClause = [...fields.map((f) => `${f} = ?`), "updated_at = ?"].join(", ");
  const values = [...fields.map((f) => payload[f] ?? null), now, projectId, blockNumber];
  db.prepare(`UPDATE narration_blocks SET ${setClause} WHERE project_id = ? AND block_number = ?`).run(...values);
}

export function countBlocksByStatus(table: "script_blocks" | "narration_blocks", projectId: number, status: BlockStatus): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) as total FROM ${table} WHERE project_id = ? AND status = ?`).get(projectId, status) as {
    total: number;
  };
  return row.total;
}

export function listScriptBlocks(projectId: number): Array<{ block_number: number; file_path_md: string | null; status: string }> {
  const db = getDb();
  return db
    .prepare("SELECT block_number, file_path_md, status FROM script_blocks WHERE project_id = ? ORDER BY block_number")
    .all(projectId) as Array<{ block_number: number; file_path_md: string | null; status: string }>;
}

export function addProjectLog(projectId: number, stage: string, level: "info" | "error", message: string, details?: unknown): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO project_logs (project_id, stage, level, message, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(projectId, stage, level, message, details ? JSON.stringify(details) : null, nowIso());
}

export function deleteProject(projectId: number): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM project_logs WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM narration_blocks WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM script_blocks WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM video_projects WHERE id = ?").run(projectId);
  });
  tx();
}

/** Recalcula status da etapa (roteiro ou narracao) a partir dos blocos no SQLite. */
export function recomputeStageFromBlocks(
  projectId: number,
  totalBlocos: number,
  table: "script_blocks" | "narration_blocks",
  stageColumn: "status_roteiro" | "status_narracao"
): void {
  const db = getDb();
  const rows = db
    .prepare(`SELECT status, COUNT(*) as n FROM ${table} WHERE project_id = ? GROUP BY status`)
    .all(projectId) as Array<{ status: string; n: number }>;

  const counts: Record<string, number> = {};
  let sum = 0;
  for (const r of rows) {
    counts[r.status] = r.n;
    sum += r.n;
  }

  const missing = Math.max(0, totalBlocos - sum);
  const success = counts.success ?? 0;
  const error = counts.error ?? 0;
  const processing = counts.processing ?? 0;
  const pending = (counts.pending ?? 0) + missing;

  let status: BlockStatus;
  if (error > 0) {
    status = "error";
  } else if (success === totalBlocos) {
    status = "success";
  } else if (processing > 0 || success > 0) {
    status = "processing";
  } else {
    status = "pending";
  }

  updateProjectStageStatus(projectId, stageColumn, status);
}

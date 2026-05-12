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

export function updateProjectAnyStageStatus(
  projectId: number,
  stage: "status_roteiro" | "status_narracao" | "status_imagens_videos" | "status_thumbnails",
  status: BlockStatus
): void {
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

export function getScriptBlock(projectId: number, blockNumber: number): { block_number: number; status: string; file_path_md: string | null } | null {
  const db = getDb();
  const row = db
    .prepare("SELECT block_number, status, file_path_md FROM script_blocks WHERE project_id = ? AND block_number = ?")
    .get(projectId, blockNumber);
  return (row as { block_number: number; status: string; file_path_md: string | null }) ?? null;
}

export function getNarrationBlock(projectId: number, blockNumber: number): { block_number: number; status: string; file_path_mp3: string | null } | null {
  const db = getDb();
  const row = db
    .prepare("SELECT block_number, status, file_path_mp3 FROM narration_blocks WHERE project_id = ? AND block_number = ?")
    .get(projectId, blockNumber);
  return (row as { block_number: number; status: string; file_path_mp3: string | null }) ?? null;
}

export function countBlocksByStatus(table: "script_blocks" | "narration_blocks", projectId: number, status: BlockStatus): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) as total FROM ${table} WHERE project_id = ? AND status = ?`).get(projectId, status) as {
    total: number;
  };
  return row.total;
}

export function upsertMediaBlock(projectId: number, blockNumber: number, payload: Record<string, string | number | null>): void {
  const db = getDb();
  const now = nowIso();
  db.prepare(`
    INSERT INTO media_blocks (project_id, block_number, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, block_number) DO UPDATE SET updated_at = excluded.updated_at
  `).run(projectId, blockNumber, now, now);

  const fields = Object.keys(payload);
  if (fields.length === 0) return;
  const setClause = [...fields.map((f) => `${f} = ?`), "updated_at = ?"].join(", ");
  const values = [...fields.map((f) => payload[f] ?? null), now, projectId, blockNumber];
  db.prepare(`UPDATE media_blocks SET ${setClause} WHERE project_id = ? AND block_number = ?`).run(...values);
}

export function listMediaBlocks(projectId: number): Array<{ block_number: number; plan_status: string; renders_status: string }> {
  const db = getDb();
  return db
    .prepare("SELECT block_number, plan_status, renders_status FROM media_blocks WHERE project_id = ? ORDER BY block_number")
    .all(projectId) as Array<{ block_number: number; plan_status: string; renders_status: string }>;
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

export type HfCliJobRow = {
  id: number;
  project_id: number;
  block_number: number;
  shot_id: string;
  asset_type: "image" | "video";
  out_path_no_ext: string;
  hf_job_id: string;
  hf_status: string | null;
  outcome: "pending" | "done" | "failed";
  result_url: string | null;
  error_message: string | null;
  downloaded_at: string | null;
  created_at: string;
  updated_at: string;
};

export function insertHfCliJob(input: {
  projectId: number;
  blockNumber: number;
  shotId: string;
  assetType: "image" | "video";
  outPathNoExt: string;
  hfJobId: string;
}): number {
  const db = getDb();
  const now = nowIso();
  const r = db
    .prepare(
      `INSERT INTO hf_cli_jobs (
        project_id, block_number, shot_id, asset_type, out_path_no_ext, hf_job_id,
        hf_status, outcome, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'submitted', 'pending', ?, ?)`
    )
    .run(
      input.projectId,
      input.blockNumber,
      input.shotId,
      input.assetType,
      input.outPathNoExt,
      input.hfJobId,
      now,
      now
    );
  return Number(r.lastInsertRowid);
}

export function updateHfCliJobPoll(
  id: number,
  fields: { hf_status?: string; result_url?: string | null; outcome?: "pending" | "done" | "failed"; error_message?: string | null; downloaded_at?: string | null }
): void {
  const db = getDb();
  const now = nowIso();
  const keys = Object.keys(fields).filter((k) => fields[k as keyof typeof fields] !== undefined);
  if (keys.length === 0) {
    db.prepare("UPDATE hf_cli_jobs SET updated_at = ? WHERE id = ?").run(now, id);
    return;
  }
  const set = [...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
  const vals = [...keys.map((k) => fields[k as keyof typeof fields]), now, id];
  db.prepare(`UPDATE hf_cli_jobs SET ${set} WHERE id = ?`).run(...vals);
}

export function listHfCliJobsPending(projectId?: number, limit = 50): HfCliJobRow[] {
  const db = getDb();
  if (projectId !== undefined) {
    return db
      .prepare(
        `SELECT * FROM hf_cli_jobs WHERE outcome = 'pending' AND project_id = ? ORDER BY id LIMIT ?`
      )
      .all(projectId, limit) as HfCliJobRow[];
  }
  return db.prepare(`SELECT * FROM hf_cli_jobs WHERE outcome = 'pending' ORDER BY id LIMIT ?`).all(limit) as HfCliJobRow[];
}

export function countHfCliJobsPending(projectId?: number): number {
  const db = getDb();
  if (projectId !== undefined) {
    const row = db
      .prepare(`SELECT COUNT(*) as n FROM hf_cli_jobs WHERE outcome = 'pending' AND project_id = ?`)
      .get(projectId) as { n: number };
    return row.n;
  }
  const row = db.prepare(`SELECT COUNT(*) as n FROM hf_cli_jobs WHERE outcome = 'pending'`).get() as { n: number };
  return row.n;
}

export function countHfCliJobsByBlockOutcome(
  projectId: number,
  blockNumber: number,
  outcome: "pending" | "done" | "failed"
): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM hf_cli_jobs WHERE project_id = ? AND block_number = ? AND outcome = ?`
    )
    .get(projectId, blockNumber, outcome) as { n: number };
  return row.n;
}

export function countHfCliJobsByBlock(projectId: number, blockNumber: number): number {
  const db = getDb();
  const row = db
    .prepare(`SELECT COUNT(*) as n FROM hf_cli_jobs WHERE project_id = ? AND block_number = ?`)
    .get(projectId, blockNumber) as { n: number };
  return row.n;
}

export function deleteHfCliJobsForBlock(projectId: number, blockNumber: number): void {
  const db = getDb();
  db.prepare("DELETE FROM hf_cli_jobs WHERE project_id = ? AND block_number = ?").run(projectId, blockNumber);
}

export function deleteProject(projectId: number): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM hf_cli_jobs WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_logs WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM media_blocks WHERE project_id = ?").run(projectId);
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

export function recomputeImagensVideosStage(projectId: number, totalBlocos: number): void {
  const db = getDb();
  const rows = db
    .prepare("SELECT plan_status, renders_status FROM media_blocks WHERE project_id = ?")
    .all(projectId) as Array<{ plan_status: string; renders_status: string }>;

  if (rows.length === 0) {
    updateProjectAnyStageStatus(projectId, "status_imagens_videos", "pending");
    return;
  }

  let hasError = false;
  let allDone = rows.length >= totalBlocos;
  let hasProgress = false;

  for (const row of rows) {
    if (row.plan_status === "error" || row.renders_status === "error") hasError = true;
    if (!(row.plan_status === "success" && row.renders_status === "success")) allDone = false;
    if (
      row.plan_status === "processing" ||
      row.renders_status === "processing" ||
      row.renders_status === "awaiting_hf" ||
      row.plan_status === "success"
    ) {
      hasProgress = true;
    }
  }

  if (hasError) {
    updateProjectAnyStageStatus(projectId, "status_imagens_videos", "error");
  } else if (allDone) {
    updateProjectAnyStageStatus(projectId, "status_imagens_videos", "success");
  } else if (hasProgress) {
    updateProjectAnyStageStatus(projectId, "status_imagens_videos", "processing");
  } else {
    updateProjectAnyStageStatus(projectId, "status_imagens_videos", "pending");
  }
}

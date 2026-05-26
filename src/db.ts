import fs from "node:fs";
import Database from "better-sqlite3";
import { DATA_DIR, DB_PATH } from "./config.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome_canal TEXT NOT NULL UNIQUE,
      slug_canal TEXT NOT NULL UNIQUE,
      base_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS video_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      titulo TEXT NOT NULL,
      slug TEXT NOT NULL,
      data_projeto TEXT NOT NULL,
      project_path TEXT NOT NULL UNIQUE,
      total_blocos INTEGER NOT NULL,
      niche TEXT NOT NULL,
      audience TEXT NOT NULL,
      transcript TEXT,
      status_roteiro TEXT NOT NULL DEFAULT 'pending',
      status_narracao TEXT NOT NULL DEFAULT 'pending',
      status_imagens_videos TEXT NOT NULL DEFAULT 'pending',
      status_thumbnails TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(channel_id) REFERENCES channels(id)
    );

    CREATE TABLE IF NOT EXISTS script_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      file_path_md TEXT,
      content_md TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, block_number),
      FOREIGN KEY(project_id) REFERENCES video_projects(id)
    );

    CREATE TABLE IF NOT EXISTS narration_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      source_script_block_id INTEGER,
      file_path_mp3 TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, block_number),
      FOREIGN KEY(project_id) REFERENCES video_projects(id)
    );

    CREATE TABLE IF NOT EXISTS project_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      stage TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES video_projects(id)
    );

    CREATE TABLE IF NOT EXISTS media_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      assets_json_path TEXT,
      plan_status TEXT NOT NULL DEFAULT 'pending',
      plan_error TEXT,
      renders_status TEXT NOT NULL DEFAULT 'pending',
      renders_done_count INTEGER NOT NULL DEFAULT 0,
      renders_total_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, block_number),
      FOREIGN KEY(project_id) REFERENCES video_projects(id)
    );

    CREATE TABLE IF NOT EXISTS hf_cli_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      shot_id TEXT NOT NULL,
      asset_type TEXT NOT NULL CHECK(asset_type IN ('image', 'video')),
      out_path_no_ext TEXT NOT NULL,
      hf_job_id TEXT NOT NULL UNIQUE,
      hf_status TEXT,
      outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending', 'done', 'failed')),
      result_url TEXT,
      error_message TEXT,
      downloaded_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES video_projects(id)
    );

    CREATE INDEX IF NOT EXISTS idx_hf_cli_jobs_project_block ON hf_cli_jobs(project_id, block_number);
    CREATE INDEX IF NOT EXISTS idx_hf_cli_jobs_outcome ON hf_cli_jobs(outcome);

    CREATE TABLE IF NOT EXISTS image_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      shot_id TEXT NOT NULL,
      asset_type TEXT NOT NULL DEFAULT 'image' CHECK(asset_type = 'image'),
      provider TEXT NOT NULL CHECK(provider IN ('higgsfield', 'gemini')),
      delivery_mode TEXT NOT NULL CHECK(delivery_mode IN ('sync', 'google_batch', 'local_batch')),
      external_id TEXT,
      batch_id TEXT,
      out_path_no_ext TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending', 'done', 'failed')),
      result_mime TEXT,
      error_message TEXT,
      reference_image_path TEXT,
      prompt_text TEXT,
      downloaded_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES video_projects(id)
    );

    CREATE INDEX IF NOT EXISTS idx_image_jobs_outcome ON image_jobs(outcome);
    CREATE INDEX IF NOT EXISTS idx_image_jobs_batch ON image_jobs(batch_id);
    CREATE INDEX IF NOT EXISTS idx_image_jobs_project_block ON image_jobs(project_id, block_number);
    CREATE INDEX IF NOT EXISTS idx_image_jobs_provider ON image_jobs(provider, outcome);
  `);

  migrateImageJobsColumns(db);
  migrateImageHashSchema(db);
  migrateTtsCacheSchema(db);
  migrateJobQueueSchema(db);
  migrateMontagemSchema(db);
  migratePipelineRunsSchema(db);
  migrateClaudeBatchSchema(db);
  migrateQualityGateSchema(db);
  migrateStockLibrarySchema(db);

  return db;
}

/** Colunas do QualityGateAgent em script_blocks — idempotente. */
function migrateQualityGateSchema(database: Database.Database): void {
  const cols = database.prepare("PRAGMA table_info(script_blocks)").all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("quality_gate_score")) {
    database.exec("ALTER TABLE script_blocks ADD COLUMN quality_gate_score INTEGER");
  }
  if (!names.has("quality_gate_attempts")) {
    database.exec("ALTER TABLE script_blocks ADD COLUMN quality_gate_attempts INTEGER NOT NULL DEFAULT 0");
  }
}

/** Colunas adicionadas apos deploy inicial — idempotente. */
function migrateImageJobsColumns(database: Database.Database): void {
  const cols = database.prepare("PRAGMA table_info(image_jobs)").all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("prompt_text")) {
    database.exec("ALTER TABLE image_jobs ADD COLUMN prompt_text TEXT");
  }
}

/** Fila de jobs para o daemon (P8 otimizacao 2026-05-25). */
function migrateJobQueueSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS job_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      profile TEXT NOT NULL DEFAULT 'wojak-images-only',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','running','done','failed','cancelled')),
      priority INTEGER NOT NULL DEFAULT 0,
      options_json TEXT NOT NULL,
      run_id INTEGER,
      worker_pid INTEGER,
      error_message TEXT,
      queued_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES video_projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_job_queue_status
      ON job_queue(status, priority DESC, id ASC);
  `);
}

/** Cache TTS por hash de texto+voz (P7 otimizacao 2026-05-25). */
function migrateTtsCacheSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tts_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text_hash TEXT NOT NULL UNIQUE,
      voice_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      text_length INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tts_cache_hash ON tts_cache(text_hash);
  `);
}

/** Deduplicacao de imagens por hash de prompt (P6 otimizacao 2026-05-25) — idempotente. */
function migrateImageHashSchema(database: Database.Database): void {
  const cols = database.prepare("PRAGMA table_info(image_jobs)").all() as { name: string }[];
  if (!new Set(cols.map((c) => c.name)).has("prompt_hash")) {
    database.exec("ALTER TABLE image_jobs ADD COLUMN prompt_hash TEXT");
    database.exec(
      "CREATE INDEX IF NOT EXISTS idx_image_jobs_prompt_hash ON image_jobs(prompt_hash, outcome)",
    );
  }
}

function migrateMontagemSchema(database: Database.Database): void {
  const projectCols = database.prepare("PRAGMA table_info(video_projects)").all() as { name: string }[];
  if (!new Set(projectCols.map((c) => c.name)).has("status_montagem")) {
    database.exec(
      "ALTER TABLE video_projects ADD COLUMN status_montagem TEXT NOT NULL DEFAULT 'pending'",
    );
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS assembly_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      scenes_total INTEGER NOT NULL DEFAULT 0,
      scenes_ready INTEGER NOT NULL DEFAULT 0,
      full_block_path TEXT,
      err_path TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, block_number),
      FOREIGN KEY(project_id) REFERENCES video_projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_assembly_blocks_project ON assembly_blocks(project_id);
  `);
}

function migrateClaudeBatchSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS claude_batch_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      stage TEXT NOT NULL CHECK(stage IN ('roteiro', 'segmentation', 'visualization')),
      block_number INTEGER,
      custom_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted',
      outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending', 'done', 'failed')),
      result_path TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES video_projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_claude_batch_project ON claude_batch_jobs(project_id, outcome);
    CREATE INDEX IF NOT EXISTS idx_claude_batch_batch ON claude_batch_jobs(batch_id);
  `);
}

/** Biblioteca local de stock com aliases e FTS para busca aproximada. */
function migrateStockLibrarySchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS stock_library_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_type TEXT NOT NULL CHECK(media_type IN ('image', 'video')),
      content_sha256 TEXT NOT NULL UNIQUE,
      file_path TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'unknown',
      provider_asset_id TEXT,
      source_kind TEXT NOT NULL DEFAULT 'stock',
      character_required INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      use_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_stock_library_assets_media ON stock_library_assets(media_type);
    CREATE INDEX IF NOT EXISTS idx_stock_library_assets_provider ON stock_library_assets(provider);

    CREATE TABLE IF NOT EXISTS stock_library_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL,
      keywords_raw TEXT NOT NULL,
      keywords_norm TEXT NOT NULL,
      description TEXT,
      role TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(asset_id, keywords_norm),
      FOREIGN KEY(asset_id) REFERENCES stock_library_assets(id)
    );
    CREATE INDEX IF NOT EXISTS idx_stock_library_aliases_keywords_norm ON stock_library_aliases(keywords_norm);
    CREATE INDEX IF NOT EXISTS idx_stock_library_aliases_asset_id ON stock_library_aliases(asset_id);
  `);

  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS stock_library_aliases_fts
    USING fts5(
      keywords_norm,
      keywords_raw,
      description,
      role,
      content='',
      tokenize='unicode61 remove_diacritics 2'
    );
  `);
}

function migratePipelineRunsSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      continue_on_error INTEGER NOT NULL DEFAULT 1,
      current_stage TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      summary_json TEXT,
      report_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES video_projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project ON pipeline_runs(project_id);

    CREATE TABLE IF NOT EXISTS pipeline_run_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      stage TEXT NOT NULL,
      block_number INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt INTEGER NOT NULL DEFAULT 1,
      error_message TEXT,
      details_json TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES pipeline_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_run ON pipeline_run_steps(run_id);
    CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_stage ON pipeline_run_steps(run_id, stage);
  `);
}

export function nowIso(): string {
  return new Date().toISOString();
}

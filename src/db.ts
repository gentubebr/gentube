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

  return db;
}

/** Colunas adicionadas apos deploy inicial — idempotente. */
function migrateImageJobsColumns(database: Database.Database): void {
  const cols = database.prepare("PRAGMA table_info(image_jobs)").all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("prompt_text")) {
    database.exec("ALTER TABLE image_jobs ADD COLUMN prompt_text TEXT");
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { imageSize } from "image-size";
import { DATA_DIR, STOCK_LIBRARY_FTS_MIN_SCORE, STOCK_LIBRARY_MIN_TERMS } from "../config.js";
import { getDb } from "../db.js";
import { keywordSearchVariants } from "../utils/stock-media.js";
import { ffprobeVideoDimensions } from "../utils/stock-media.js";

const STOCK_LIBRARY_DIR = path.join(DATA_DIR, "stock_library");
const STOCK_LIBRARY_FILES_DIR = path.join(STOCK_LIBRARY_DIR, "files");

type MediaType = "image" | "video";
type SourceKind = "stock" | "ai_generated";

export type RegisterStockLibraryInput = {
  mediaType: MediaType;
  localPath: string;
  keywords: string;
  description?: string | null;
  role?: string | null;
  provider?: string;
  providerAssetId?: string | null;
  sourceKind?: SourceKind;
  characterRequired?: boolean;
};

export type LocalMatchResult = {
  path: string;
  matchKind: "exact" | "fts";
  matchedKeywords: string;
  score: number;
};

function normalizeKeywords(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function tokenize(raw: string): string[] {
  return normalizeKeywords(raw)
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function extForPath(filePath: string, mediaType: MediaType): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext) return ext;
  return mediaType === "video" ? ".mp4" : ".jpg";
}

async function measureMedia(filePath: string, mediaType: MediaType): Promise<{ width: number | null; height: number | null }> {
  if (mediaType === "video") {
    const dims = await ffprobeVideoDimensions(filePath);
    return { width: dims?.w ?? null, height: dims?.h ?? null };
  }
  try {
    const buf = await fs.readFile(filePath);
    const dim = imageSize(buf);
    return { width: dim.width ?? null, height: dim.height ?? null };
  } catch {
    return { width: null, height: null };
  }
}

async function copyCanonical(filePath: string, canonicalPath: string): Promise<void> {
  await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
  await fs.copyFile(filePath, canonicalPath);
}

function ensureFtsRow(aliasId: number, keywordsNorm: string, keywordsRaw: string, description: string | null, role: string | null): void {
  const db = getDb();
  db.prepare(
    `
      INSERT OR REPLACE INTO stock_library_aliases_fts (rowid, keywords_norm, keywords_raw, description, role)
      VALUES (?, ?, ?, ?, ?)
    `,
  ).run(aliasId, keywordsNorm, keywordsRaw, description ?? "", role ?? "");
}

export async function registerStockLibraryAsset(input: RegisterStockLibraryInput): Promise<{ assetId: number; canonicalPath: string }> {
  const db = getDb();
  const now = new Date().toISOString();
  const keywordsRaw = input.keywords.trim();
  const keywordsNorm = normalizeKeywords(keywordsRaw);
  if (!keywordsNorm) {
    throw new Error("Stock library: keywords vazias");
  }

  const rawBuf = await fs.readFile(input.localPath);
  const contentSha = sha256(rawBuf);
  const existing = db
    .prepare("SELECT id, file_path, provider FROM stock_library_assets WHERE content_sha256 = ?")
    .get(contentSha) as { id: number; file_path: string; provider: string } | undefined;

  const ext = extForPath(input.localPath, input.mediaType);
  const canonicalPath = existing?.file_path ?? path.join(STOCK_LIBRARY_FILES_DIR, `${contentSha}${ext}`);
  const dims = await measureMedia(input.localPath, input.mediaType);

  let assetId: number;
  if (existing) {
    assetId = existing.id;
    await fs.access(canonicalPath).catch(async () => {
      await copyCanonical(input.localPath, canonicalPath);
    });
    db.prepare(
      `
        UPDATE stock_library_assets
        SET updated_at = ?,
            provider = CASE
              WHEN provider = 'unknown' AND ? <> '' THEN ?
              ELSE provider
            END,
            width = COALESCE(width, ?),
            height = COALESCE(height, ?)
        WHERE id = ?
      `,
    ).run(now, input.provider ?? "", input.provider ?? "", dims.width, dims.height, assetId);
  } else {
    await copyCanonical(input.localPath, canonicalPath);
    const ins = db
      .prepare(
        `
          INSERT INTO stock_library_assets (
            media_type,
            content_sha256,
            file_path,
            provider,
            provider_asset_id,
            source_kind,
            character_required,
            width,
            height,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.mediaType,
        contentSha,
        canonicalPath,
        (input.provider ?? "unknown").trim() || "unknown",
        input.providerAssetId ?? null,
        input.sourceKind ?? "stock",
        input.characterRequired ? 1 : 0,
        dims.width,
        dims.height,
        now,
        now,
      );
    assetId = Number(ins.lastInsertRowid);
  }

  db.prepare(
    `
      INSERT INTO stock_library_aliases (
        asset_id,
        keywords_raw,
        keywords_norm,
        description,
        role,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_id, keywords_norm) DO UPDATE SET
        keywords_raw = excluded.keywords_raw,
        description = COALESCE(excluded.description, stock_library_aliases.description),
        role = COALESCE(excluded.role, stock_library_aliases.role),
        updated_at = excluded.updated_at
    `,
  ).run(assetId, keywordsRaw, keywordsNorm, input.description ?? null, input.role ?? null, now, now);

  const alias = db
    .prepare("SELECT id, keywords_norm, keywords_raw, description, role FROM stock_library_aliases WHERE asset_id = ? AND keywords_norm = ?")
    .get(assetId, keywordsNorm) as
    | { id: number; keywords_norm: string; keywords_raw: string; description: string | null; role: string | null }
    | undefined;
  if (alias) {
    ensureFtsRow(alias.id, alias.keywords_norm, alias.keywords_raw, alias.description, alias.role);
  }

  return { assetId, canonicalPath };
}

function touchAssetUse(assetId: number): void {
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE stock_library_assets SET use_count = use_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, assetId);
}

async function copyAssetToDest(canonicalPath: string, destPathNoExt: string): Promise<string> {
  const ext = extForPath(canonicalPath, canonicalPath.endsWith(".mp4") || canonicalPath.endsWith(".webm") ? "video" : "image");
  const dest = `${destPathNoExt}${ext}`;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(canonicalPath, dest);
  return dest;
}

function localScore(queryTokens: string[], candidateText: string): number {
  const q = new Set(queryTokens);
  if (q.size === 0) return 0;
  const c = new Set(tokenize(candidateText));
  let overlap = 0;
  for (const token of q) {
    if (c.has(token)) overlap += 1;
  }
  return overlap / q.size;
}

function searchFtsCandidates(mediaType: MediaType, query: string): Array<{
  asset_id: number;
  file_path: string;
  keywords_norm: string;
  description: string | null;
}> {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const matchExpr = tokens.join(" OR ");
  const db = getDb();
  return db
    .prepare(
      `
        SELECT
          a.asset_id AS asset_id,
          s.file_path AS file_path,
          a.keywords_norm AS keywords_norm,
          a.description AS description
        FROM stock_library_aliases_fts f
        JOIN stock_library_aliases a ON a.id = f.rowid
        JOIN stock_library_assets s ON s.id = a.asset_id
        WHERE stock_library_aliases_fts MATCH ?
          AND s.media_type = ?
        LIMIT 40
      `,
    )
    .all(matchExpr, mediaType) as Array<{
    asset_id: number;
    file_path: string;
    keywords_norm: string;
    description: string | null;
  }>;
}

function exactCandidate(mediaType: MediaType, keywordsNorm: string): { asset_id: number; file_path: string } | null {
  const db = getDb();
  const row = db
    .prepare(
      `
        SELECT s.id AS asset_id, s.file_path AS file_path
        FROM stock_library_aliases a
        JOIN stock_library_assets s ON s.id = a.asset_id
        WHERE s.media_type = ? AND a.keywords_norm = ?
        ORDER BY s.use_count DESC, s.id DESC
        LIMIT 1
      `,
    )
    .get(mediaType, keywordsNorm) as { asset_id: number; file_path: string } | undefined;
  return row ?? null;
}

export async function tryCopyFromStockLibrary(input: {
  mediaType: MediaType;
  keywords: string;
  destPathNoExt: string;
}): Promise<LocalMatchResult | null> {
  const keywordsNorm = normalizeKeywords(input.keywords);
  if (!keywordsNorm) return null;

  const exact = exactCandidate(input.mediaType, keywordsNorm);
  if (exact) {
    const pathOut = await copyAssetToDest(exact.file_path, input.destPathNoExt);
    touchAssetUse(exact.asset_id);
    return { path: pathOut, matchKind: "exact", matchedKeywords: keywordsNorm, score: 1 };
  }

  const variants = keywordSearchVariants(keywordsNorm, STOCK_LIBRARY_MIN_TERMS);
  let best:
    | {
        assetId: number;
        filePath: string;
        matchedKeywords: string;
        score: number;
      }
    | null = null;
  for (const variant of variants) {
    const candidates = searchFtsCandidates(input.mediaType, variant);
    const qTokens = tokenize(variant);
    for (const cand of candidates) {
      const score = localScore(qTokens, `${cand.keywords_norm} ${cand.description ?? ""}`);
      if (score < STOCK_LIBRARY_FTS_MIN_SCORE) continue;
      if (!best || score > best.score) {
        best = {
          assetId: cand.asset_id,
          filePath: cand.file_path,
          matchedKeywords: cand.keywords_norm,
          score,
        };
      }
    }
    if (best) break;
  }

  if (!best) return null;
  const pathOut = await copyAssetToDest(best.filePath, input.destPathNoExt);
  touchAssetUse(best.assetId);
  return {
    path: pathOut,
    matchKind: "fts",
    matchedKeywords: best.matchedKeywords,
    score: best.score,
  };
}

export function stockLibraryStats(): { assets: number; aliases: number } {
  const db = getDb();
  const assets = Number((db.prepare("SELECT COUNT(*) AS n FROM stock_library_assets").get() as { n: number }).n);
  const aliases = Number((db.prepare("SELECT COUNT(*) AS n FROM stock_library_aliases").get() as { n: number }).n);
  return { assets, aliases };
}


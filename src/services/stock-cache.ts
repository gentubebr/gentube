import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";

const STOCK_CACHE_DIR = path.join(DATA_DIR, "stock_cache");

function stockCacheKey(type: "image" | "video", keywords: string): string {
  return crypto.createHash("sha256").update(`${type}|${keywords.trim().toLowerCase()}`).digest("hex");
}

function cachePathForKey(key: string, downloadedPath: string): string {
  const ext = path.extname(downloadedPath) || (downloadedPath.includes(".mp4") ? ".mp4" : ".jpg");
  return path.join(STOCK_CACHE_DIR, `${key}${ext}`);
}

/**
 * Se existir asset Magnific em cache para keywords+tipo, copia para destPathNoExt + extensao.
 */
export async function tryCopyStockFromCache(input: {
  type: "image" | "video";
  keywords: string;
  destPathNoExt: string;
}): Promise<string | null> {
  const key = stockCacheKey(input.type, input.keywords);
  const dir = STOCK_CACHE_DIR;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const match = entries.find((f) => f.startsWith(key));
  if (!match) return null;
  const cached = path.join(dir, match);
  const ext = path.extname(match);
  const dest = `${input.destPathNoExt}${ext}`;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(cached, dest);
  return dest;
}

/** Guarda copia canonica apos download Magnific bem-sucedido. */
export async function saveStockToCache(input: {
  type: "image" | "video";
  keywords: string;
  localPath: string;
}): Promise<void> {
  const key = stockCacheKey(input.type, input.keywords);
  await fs.mkdir(STOCK_CACHE_DIR, { recursive: true });
  const canonical = cachePathForKey(key, input.localPath);
  await fs.copyFile(input.localPath, canonical);
}

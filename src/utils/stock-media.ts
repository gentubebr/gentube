import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { imageSize } from "image-size";
import { resolveMontagemConfig } from "../config/montagem.js";

const execFileAsync = promisify(execFile);

export const MAX_STOCK_DOWNLOAD_BYTES = 100 * 1024 * 1024;

const ASPECT_16_9 = 16 / 9;
const ASPECT_TOLERANCE = 0.02;

export function isApprox169(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  const r = width / height;
  return Math.abs(r - ASPECT_16_9) / ASPECT_16_9 <= ASPECT_TOLERANCE;
}

/** Variantes da query: remove palavras do fim ate minWords. */
export function keywordSearchVariants(keywords: string, minWords = 3): string[] {
  const words = keywords.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const out: string[] = [];
  for (let n = words.length; n >= minWords; n -= 1) {
    out.push(words.slice(0, n).join(" "));
  }
  return out.filter((v, i, arr) => arr.indexOf(v) === i);
}

export function isStockSearchExhausted(msg: string): boolean {
  return (
    /nenhum(?:a)? (?:imagem|video)/i.test(msg) ||
    /16:9 aceitavel/i.test(msg) ||
    /nenhuma imagem encontrada/i.test(msg) ||
    /nenhum video encontrado/i.test(msg)
  );
}

export function isStockProviderFallbackEligible(err: Error): boolean {
  const msg = err.message;
  if (isStockSearchExhausted(msg)) return true;
  if (/fetch failed/i.test(msg)) return true;
  if (/\(429\)|\(500\)|\(502\)|\(503\)|rate limit|too many requests/i.test(msg)) return true;
  if (/Resource is disabled|download(?:Image|Video) falhou \(404\)/i.test(msg)) return true;
  if (/excede 100 MB/i.test(msg)) return true;
  return false;
}

function ffmpegPath(): string {
  return resolveMontagemConfig().ffmpegPath;
}

function ffprobePath(): string {
  return resolveMontagemConfig().ffprobePath;
}

export async function ffprobeVideoDimensions(filePath: string): Promise<{ w: number; h: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      ffprobePath(),
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0:s=x",
        filePath,
      ],
      { timeout: 20_000, maxBuffer: 1024 * 1024 },
    );
    const line = stdout.trim().split("\n")[0] ?? "";
    const [ws, hs] = line.split("x");
    const w = parseInt(ws ?? "", 10);
    const h = parseInt(hs ?? "", 10);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { w, h };
  } catch {
    return null;
  }
}

async function validateImageFile169(filePath: string): Promise<boolean> {
  const buf = await fs.readFile(filePath);
  const dim = imageSize(buf);
  const w = dim.width;
  const h = dim.height;
  if (typeof w !== "number" || typeof h !== "number") return false;
  return isApprox169(w, h);
}

/** Recorta/escala imagem landscape para 1920x1080 quando o stock nao e 16:9 nativo. */
export async function ensureImage169(filePath: string): Promise<boolean> {
  const buf = await fs.readFile(filePath);
  const dim = imageSize(buf);
  const w = dim.width;
  const h = dim.height;
  if (typeof w !== "number" || typeof h !== "number" || w <= 0 || h <= 0) return false;
  if (h > w) return false;
  if (isApprox169(w, h)) return true;

  const tmp = `${filePath}.169.tmp.jpg`;
  try {
    await execFileAsync(
      ffmpegPath(),
      [
        "-y",
        "-i",
        filePath,
        "-vf",
        "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080",
        "-q:v",
        "2",
        tmp,
      ],
      { timeout: 120_000 },
    );
    await fs.rename(tmp, filePath);
    return validateImageFile169(filePath);
  } catch {
    await fs.unlink(tmp).catch(() => {});
    return false;
  }
}

export async function downloadUrlToFile(downloadUrl: string, destPathNoExt: string, defaultExt: string): Promise<string> {
  const fileRes = await fetch(downloadUrl);
  if (!fileRes.ok) {
    throw new Error(`Falha ao baixar stock (${fileRes.status})`);
  }
  const contentLength = Number(fileRes.headers.get("content-length") || 0);
  if (contentLength > MAX_STOCK_DOWNLOAD_BYTES) {
    throw new Error(`Stock excede 100 MB (${(contentLength / 1024 / 1024).toFixed(1)} MB)`);
  }
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  if (buffer.length > MAX_STOCK_DOWNLOAD_BYTES) {
    throw new Error(`Stock excede 100 MB (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
  }
  const urlExt = path.extname(new URL(downloadUrl).pathname);
  const ext = urlExt && urlExt.length <= 5 ? urlExt : defaultExt;
  const finalPath = destPathNoExt.includes(".") ? destPathNoExt : `${destPathNoExt}${ext}`;
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, buffer);
  return finalPath;
}

export async function videoFilePasses169(filePath: string): Promise<boolean> {
  const dims = await ffprobeVideoDimensions(filePath);
  if (dims) return isApprox169(dims.w, dims.h);
  return false;
}

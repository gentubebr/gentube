import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { imageSize } from "image-size";
import { MAGNIFIC_API_KEY } from "../config.js";

const execFileAsync = promisify(execFile);

const BASE_URL = "https://api.magnific.com";
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

/** Alvo 16:9; tolerancia para arredondamentos de pixel e compressao. */
const ASPECT_16_9 = 16 / 9;
const ASPECT_TOLERANCE = 0.02;

function headers(): Record<string, string> {
  if (!MAGNIFIC_API_KEY) {
    throw new Error("MAGNIFIC_API_KEY nao configurada no .env");
  }
  return {
    "x-magnific-api-key": MAGNIFIC_API_KEY,
    "Accept-Language": "en-US",
  };
}

function isApprox169(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  const r = width / height;
  return Math.abs(r - ASPECT_16_9) / ASPECT_16_9 <= ASPECT_TOLERANCE;
}

function parseWxH(size: string | null | undefined): { w: number; h: number } | null {
  if (!size || typeof size !== "string") return null;
  const m = /^([1-9][0-9]*)x([1-9][0-9]*)$/.exec(size.trim());
  if (!m) return null;
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  return { w, h };
}

async function ffprobeVideoDimensions(filePath: string): Promise<{ w: number; h: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
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

export interface MagnificSearchResult {
  id: number;
  title: string;
  url: string;
  thumbnailUrl: string | null;
  /** Resposta de video: ex. "16:9", "4:3" */
  aspectRatio?: string | null;
  /** Resposta de foto: `image.source.size` tipo "1920x1080" */
  sourceSize?: string | null;
}

export async function searchVideos(
  term: string,
  opts?: { limit?: number },
): Promise<MagnificSearchResult[]> {
  const limit = opts?.limit ?? 15;
  const params = new URLSearchParams({
    term,
    order: "relevance",
    page: "1",
    limit: String(limit),
  });
  params.append("filters[aspect_ratio][]", "16:9");
  params.append("filters[orientation][]", "horizontal");
  const url = `${BASE_URL}/v1/videos?${params}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Magnific searchVideos falhou (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
  if (!json.data || !Array.isArray(json.data)) return [];

  return json.data.map((item) => {
    const thumbs = item.thumbnails as Array<{ url: string }> | undefined;
    const name = (item.name as string) ?? (item.title as string) ?? "";
    return {
      id: item.id as number,
      title: name,
      url: (item.url as string) ?? "",
      thumbnailUrl: thumbs?.[0]?.url ?? null,
      aspectRatio: (item.aspect_ratio as string) ?? null,
      sourceSize: null,
    };
  });
}

export async function searchImages(
  term: string,
  opts?: { limit?: number },
): Promise<MagnificSearchResult[]> {
  const limit = opts?.limit ?? 15;
  const params = new URLSearchParams({
    term,
    order: "relevance",
    page: "1",
    limit: String(limit),
    "filters[content_type][photo]": "1",
    "filters[orientation][landscape]": "1",
    "filters[orientation][panoramic]": "0",
  });
  const url = `${BASE_URL}/v1/resources?${params}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Magnific searchImages falhou (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
  if (!json.data || !Array.isArray(json.data)) return [];

  return json.data.map((item) => {
    const image = item.image as { source?: { url?: string; size?: string } } | undefined;
    const size = image?.source?.size ?? null;
    return {
      id: item.id as number,
      title: (item.title as string) ?? "",
      url: (item.url as string) ?? "",
      thumbnailUrl: image?.source?.url ?? null,
      aspectRatio: null,
      sourceSize: size,
    };
  });
}

export async function downloadVideo(
  videoId: number,
  destPath: string,
): Promise<string> {
  const url = `${BASE_URL}/v1/videos/${videoId}/download`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Magnific downloadVideo falhou (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data?: { url?: string; filename?: string } };
  const downloadUrl = json.data?.url;
  if (!downloadUrl) throw new Error("Magnific downloadVideo: URL de download ausente na resposta");

  const ext = path.extname(json.data?.filename ?? ".mp4") || ".mp4";
  const finalPath = destPath.includes(".") ? destPath : `${destPath}${ext}`;

  const fileRes = await fetch(downloadUrl);
  if (!fileRes.ok) throw new Error(`Falha ao baixar video Magnific (${fileRes.status})`);
  const contentLength = Number(fileRes.headers.get("content-length") || 0);
  if (contentLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Magnific video ${videoId} excede 100 MB (${(contentLength / 1024 / 1024).toFixed(1)} MB)`);
  }
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Magnific video ${videoId} excede 100 MB (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
  }
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, buffer);
  return finalPath;
}

export async function downloadImage(
  resourceId: number,
  destPath: string,
): Promise<string> {
  const url = `${BASE_URL}/v1/resources/${resourceId}/download?image_size=large`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Magnific downloadImage falhou (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data?: { url?: string; filename?: string } };
  const downloadUrl = json.data?.url;
  if (!downloadUrl) throw new Error("Magnific downloadImage: URL de download ausente na resposta");

  const ext = path.extname(json.data?.filename ?? ".jpg") || ".jpg";
  const finalPath = destPath.includes(".") ? destPath : `${destPath}${ext}`;

  const fileRes = await fetch(downloadUrl);
  if (!fileRes.ok) throw new Error(`Falha ao baixar imagem Magnific (${fileRes.status})`);
  const contentLength = Number(fileRes.headers.get("content-length") || 0);
  if (contentLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Magnific imagem ${resourceId} excede 100 MB (${(contentLength / 1024 / 1024).toFixed(1)} MB)`);
  }
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Magnific imagem ${resourceId} excede 100 MB (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
  }
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, buffer);
  return finalPath;
}

async function videoPasses169Checks(
  result: MagnificSearchResult,
  filePath: string,
): Promise<boolean> {
  if (result.aspectRatio && result.aspectRatio !== "16:9") {
    return false;
  }
  const dims = await ffprobeVideoDimensions(filePath);
  if (dims) {
    return isApprox169(dims.w, dims.h);
  }
  return result.aspectRatio === "16:9" || result.aspectRatio == null;
}

export async function searchAndDownload(input: {
  type: "image" | "video";
  keywords: string;
  destPathNoExt: string;
}): Promise<string> {
  const limit = 15;
  if (input.type === "video") {
    const results = await searchVideos(input.keywords, { limit });
    if (results.length === 0) {
      throw new Error(`Magnific: nenhum video encontrado para "${input.keywords}"`);
    }
    for (const r of results) {
      if (r.aspectRatio && r.aspectRatio !== "16:9") {
        continue;
      }
      try {
        const finalPath = await downloadVideo(r.id, input.destPathNoExt);
        const ok = await videoPasses169Checks(r, finalPath);
        if (!ok) {
          await fs.unlink(finalPath).catch(() => {});
          continue;
        }
        return finalPath;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("excede 100 MB")) continue;
        throw err;
      }
    }
    throw new Error(`Magnific: nenhum video 16:9 aceitavel para "${input.keywords}" (filtro API + verificacao)`);
  }

  const results = await searchImages(input.keywords, { limit });
  if (results.length === 0) {
    throw new Error(`Magnific: nenhuma imagem encontrada para "${input.keywords}"`);
  }
  for (const r of results) {
    const pre = parseWxH(r.sourceSize ?? undefined);
    if (pre && !isApprox169(pre.w, pre.h)) {
      continue;
    }
    try {
      const finalPath = await downloadImage(r.id, input.destPathNoExt);
      const ok = await validateImageFile169(finalPath);
      if (!ok) {
        await fs.unlink(finalPath).catch(() => {});
        continue;
      }
      return finalPath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("excede 100 MB")) continue;
      throw err;
    }
  }
  throw new Error(`Magnific: nenhuma imagem 16:9 aceitavel para "${input.keywords}" (metadados ou ficheiro)`);
}

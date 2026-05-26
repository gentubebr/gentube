import fs from "node:fs/promises";
import path from "node:path";
import { MAGNIFIC_API_KEY } from "../config.js";
import {
  downloadUrlToFile,
  ensureImage169,
  isStockSearchExhausted,
  keywordSearchVariants,
  videoFilePasses169,
} from "../utils/stock-media.js";

const BASE_URL = "https://api.magnific.com";

function headers(): Record<string, string> {
  if (!MAGNIFIC_API_KEY) {
    throw new Error("MAGNIFIC_API_KEY nao configurada no .env");
  }
  return {
    "x-magnific-api-key": MAGNIFIC_API_KEY,
    "Accept-Language": "en-US",
  };
}

function isMagnificAssetUnavailable(msg: string): boolean {
  return (
    /download(?:Image|Video) falhou \(404\)/i.test(msg) ||
    /Resource is disabled/i.test(msg)
  );
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

export { keywordSearchVariants };

export interface MagnificSearchResult {
  id: number;
  title: string;
  url: string;
  thumbnailUrl: string | null;
  aspectRatio?: string | null;
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
    throw new Error(`Magnific searchVideos falhou (${res.status}): ${body.slice(0, 200)}`);
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
    throw new Error(`Magnific searchImages falhou (${res.status}): ${body.slice(0, 200)}`);
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

async function downloadVideo(videoId: number, destPath: string): Promise<string> {
  const url = `${BASE_URL}/v1/videos/${videoId}/download`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Magnific downloadVideo falhou (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: { url?: string; filename?: string } };
  const downloadUrl = json.data?.url;
  if (!downloadUrl) throw new Error("Magnific downloadVideo: URL de download ausente na resposta");

  const ext = path.extname(json.data?.filename ?? ".mp4") || ".mp4";
  const finalPath = destPath.includes(".") ? destPath : `${destPath}${ext}`;
  return downloadUrlToFile(downloadUrl, finalPath, ext);
}

async function downloadImage(resourceId: number, destPath: string): Promise<string> {
  const url = `${BASE_URL}/v1/resources/${resourceId}/download?image_size=large`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Magnific downloadImage falhou (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: { url?: string; filename?: string } };
  const downloadUrl = json.data?.url;
  if (!downloadUrl) throw new Error("Magnific downloadImage: URL de download ausente na resposta");

  const ext = path.extname(json.data?.filename ?? ".jpg") || ".jpg";
  const finalPath = destPath.includes(".") ? destPath : `${destPath}${ext}`;
  return downloadUrlToFile(downloadUrl, finalPath, ext);
}

async function searchAndDownloadVideoOnce(input: {
  keywords: string;
  destPathNoExt: string;
  limit: number;
}): Promise<string> {
  const results = await searchVideos(input.keywords, { limit: input.limit });
  if (results.length === 0) {
    throw new Error(`Magnific: nenhum video encontrado para "${input.keywords}"`);
  }
  for (const r of results) {
    if (r.aspectRatio && r.aspectRatio !== "16:9") continue;
    try {
      const finalPath = await downloadVideo(r.id, input.destPathNoExt);
      const ok = await videoFilePasses169(finalPath);
      if (!ok) {
        await fs.unlink(finalPath).catch(() => {});
        continue;
      }
      return finalPath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("excede 100 MB") || isMagnificAssetUnavailable(msg)) continue;
      throw err;
    }
  }
  throw new Error(`Magnific: nenhum video 16:9 aceitavel para "${input.keywords}" (filtro API + verificacao)`);
}

async function searchAndDownloadImageOnce(input: {
  keywords: string;
  destPathNoExt: string;
  limit: number;
}): Promise<string> {
  const results = await searchImages(input.keywords, { limit: input.limit });
  if (results.length === 0) {
    throw new Error(`Magnific: nenhuma imagem encontrada para "${input.keywords}"`);
  }
  for (const r of results) {
    const pre = parseWxH(r.sourceSize ?? undefined);
    if (pre && pre.h > pre.w) continue;
    try {
      const finalPath = await downloadImage(r.id, input.destPathNoExt);
      const ok = await ensureImage169(finalPath);
      if (!ok) {
        await fs.unlink(finalPath).catch(() => {});
        continue;
      }
      return finalPath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("excede 100 MB") || isMagnificAssetUnavailable(msg)) continue;
      throw err;
    }
  }
  throw new Error(`Magnific: nenhuma imagem 16:9 aceitavel para "${input.keywords}" (metadados ou ficheiro)`);
}

export async function searchAndDownloadMagnific(input: {
  type: "image" | "video";
  keywords: string;
  destPathNoExt: string;
}): Promise<string> {
  const limit = 25;
  const variants = keywordSearchVariants(input.keywords);
  if (variants.length === 0) {
    throw new Error("Magnific: keywords vazias");
  }

  let lastErr: Error | null = null;
  for (let i = 0; i < variants.length; i += 1) {
    const kw = variants[i];
    try {
      const pathOut =
        input.type === "video"
          ? await searchAndDownloadVideoOnce({ keywords: kw, destPathNoExt: input.destPathNoExt, limit })
          : await searchAndDownloadImageOnce({ keywords: kw, destPathNoExt: input.destPathNoExt, limit });
      if (i > 0 && process.env.GENTUBE_VERBOSE === "1") {
        console.log(`Magnific: keywords reduzidas "${kw}" (original: "${input.keywords.trim()}")`);
      }
      return pathOut;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (i < variants.length - 1 && isStockSearchExhausted(lastErr.message)) {
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error(`Magnific: falha para "${input.keywords}"`);
}

/** @deprecated Use searchAndDownload from stock-download.js */
export const searchAndDownload = searchAndDownloadMagnific;

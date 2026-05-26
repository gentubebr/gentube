import fs from "node:fs/promises";
import { PEXELS_API_KEY } from "../config.js";
import {
  downloadUrlToFile,
  ensureImage169,
  isStockSearchExhausted,
  keywordSearchVariants,
  videoFilePasses169,
} from "../utils/stock-media.js";

const PHOTOS_BASE = "https://api.pexels.com/v1";
const VIDEOS_BASE = "https://api.pexels.com/v1/videos";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pexelsHeaders(): Record<string, string> {
  if (!PEXELS_API_KEY) {
    throw new Error("PEXELS_API_KEY nao configurada no .env");
  }
  return { Authorization: PEXELS_API_KEY };
}

async function pexelsFetch(url: string, attempt = 0): Promise<Response> {
  const res = await fetch(url, { headers: pexelsHeaders() });
  if (res.status === 429 && attempt < 3) {
    const reset = res.headers.get("X-Ratelimit-Reset");
    const resetMs = reset ? Math.max(1000, parseInt(reset, 10) * 1000 - Date.now()) : 60_000;
    const waitMs = Math.min(resetMs, 120_000);
    if (process.env.GENTUBE_VERBOSE === "1") {
      console.log(`Pexels: rate limit 429 — aguardando ${Math.round(waitMs / 1000)}s`);
    }
    await sleep(waitMs);
    return pexelsFetch(url, attempt + 1);
  }
  return res;
}

type PexelsPhoto = {
  id: number;
  width: number;
  height: number;
  src: {
    original?: string;
    large2x?: string;
    large?: string;
    landscape?: string;
  };
};

type PexelsVideoFile = {
  id: number;
  quality: string;
  width: number;
  height: number;
  link: string;
};

type PexelsVideo = {
  id: number;
  width: number;
  height: number;
  video_files: PexelsVideoFile[];
};

function photoDownloadUrls(photo: PexelsPhoto): string[] {
  const s = photo.src;
  return [s.landscape, s.large2x, s.large, s.original].filter((u): u is string => Boolean(u?.trim()));
}

function pickLandscapeVideoFile(files: PexelsVideoFile[]): PexelsVideoFile | null {
  let best: PexelsVideoFile | null = null;
  let bestScore = Infinity;
  for (const f of files) {
    if (f.width <= f.height) continue;
    const score = Math.abs(f.width / f.height - 16 / 9);
    if (score < bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return best;
}

async function searchPhotos(term: string, limit: number): Promise<PexelsPhoto[]> {
  const params = new URLSearchParams({
    query: term,
    orientation: "landscape",
    per_page: String(limit),
    page: "1",
  });
  const res = await pexelsFetch(`${PHOTOS_BASE}/search?${params}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pexels searchPhotos falhou (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { photos?: PexelsPhoto[] };
  return json.photos ?? [];
}

async function searchVideos(term: string, limit: number): Promise<PexelsVideo[]> {
  const params = new URLSearchParams({
    query: term,
    orientation: "landscape",
    per_page: String(limit),
    page: "1",
  });
  const res = await pexelsFetch(`${VIDEOS_BASE}/search?${params}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pexels searchVideos falhou (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { videos?: PexelsVideo[] };
  return json.videos ?? [];
}

async function searchAndDownloadImageOnce(input: {
  keywords: string;
  destPathNoExt: string;
  limit: number;
}): Promise<string> {
  const photos = await searchPhotos(input.keywords, input.limit);
  if (photos.length === 0) {
    throw new Error(`Pexels: nenhuma imagem encontrada para "${input.keywords}"`);
  }
  for (const photo of photos) {
    if (photo.height > photo.width) continue;
    const urls = photoDownloadUrls(photo);
    for (const url of urls) {
      try {
        const finalPath = await downloadUrlToFile(url, input.destPathNoExt, ".jpg");
        const ok = await ensureImage169(finalPath);
        if (!ok) {
          await fs.unlink(finalPath).catch(() => {});
          continue;
        }
        return finalPath;
      } catch {
        continue;
      }
    }
  }
  throw new Error(`Pexels: nenhuma imagem 16:9 aceitavel para "${input.keywords}"`);
}

async function searchAndDownloadVideoOnce(input: {
  keywords: string;
  destPathNoExt: string;
  limit: number;
}): Promise<string> {
  const videos = await searchVideos(input.keywords, input.limit);
  if (videos.length === 0) {
    throw new Error(`Pexels: nenhum video encontrado para "${input.keywords}"`);
  }
  for (const video of videos) {
    const file = pickLandscapeVideoFile(video.video_files ?? []);
    if (!file) continue;
    try {
      const finalPath = await downloadUrlToFile(file.link, input.destPathNoExt, ".mp4");
      const ok = await videoFilePasses169(finalPath);
      if (!ok) {
        await fs.unlink(finalPath).catch(() => {});
        continue;
      }
      return finalPath;
    } catch {
      continue;
    }
  }
  throw new Error(`Pexels: nenhum video 16:9 aceitavel para "${input.keywords}"`);
}

export async function searchAndDownloadPexels(input: {
  type: "image" | "video";
  keywords: string;
  destPathNoExt: string;
}): Promise<string> {
  const limit = 25;
  const variants = keywordSearchVariants(input.keywords);
  if (variants.length === 0) {
    throw new Error("Pexels: keywords vazias");
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
        console.log(`Pexels: keywords reduzidas "${kw}" (original: "${input.keywords.trim()}")`);
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
  throw lastErr ?? new Error(`Pexels: falha para "${input.keywords}"`);
}

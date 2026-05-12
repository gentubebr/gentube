import fs from "node:fs/promises";
import path from "node:path";
import { MAGNIFIC_API_KEY } from "../config.js";

const BASE_URL = "https://api.magnific.com";
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

function headers(): Record<string, string> {
  if (!MAGNIFIC_API_KEY) {
    throw new Error("MAGNIFIC_API_KEY nao configurada no .env");
  }
  return {
    "x-magnific-api-key": MAGNIFIC_API_KEY,
    "Accept-Language": "en-US",
  };
}

export interface MagnificSearchResult {
  id: number;
  title: string;
  url: string;
  thumbnailUrl: string | null;
}

export async function searchVideos(
  term: string,
  opts?: { limit?: number },
): Promise<MagnificSearchResult[]> {
  const limit = opts?.limit ?? 5;
  const params = new URLSearchParams({
    term,
    order: "relevance",
    page: "1",
    limit: String(limit),
  });
  params.append("filters[orientation][]", "landscape");
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
    return {
      id: item.id as number,
      title: (item.title as string) ?? "",
      url: (item.url as string) ?? "",
      thumbnailUrl: thumbs?.[0]?.url ?? null,
    };
  });
}

export async function searchImages(
  term: string,
  opts?: { limit?: number },
): Promise<MagnificSearchResult[]> {
  const limit = opts?.limit ?? 5;
  const params = new URLSearchParams({
    term,
    order: "relevance",
    page: "1",
    limit: String(limit),
    "filters[content_type][photo]": "1",
    "filters[orientation][landscape]": "1",
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
    const image = item.image as { source?: { url?: string } } | undefined;
    return {
      id: item.id as number,
      title: (item.title as string) ?? "",
      url: (item.url as string) ?? "",
      thumbnailUrl: image?.source?.url ?? null,
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

export async function searchAndDownload(input: {
  type: "image" | "video";
  keywords: string;
  destPathNoExt: string;
}): Promise<string> {
  const limit = 5;
  if (input.type === "video") {
    const results = await searchVideos(input.keywords, { limit });
    if (results.length === 0) {
      throw new Error(`Magnific: nenhum video encontrado para "${input.keywords}"`);
    }
    for (const r of results) {
      try {
        return await downloadVideo(r.id, input.destPathNoExt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("excede 100 MB")) continue;
        throw err;
      }
    }
    throw new Error(`Magnific: todos os ${results.length} videos para "${input.keywords}" excedem 100 MB`);
  }

  const results = await searchImages(input.keywords, { limit });
  if (results.length === 0) {
    throw new Error(`Magnific: nenhuma imagem encontrada para "${input.keywords}"`);
  }
  for (const r of results) {
    try {
      return await downloadImage(r.id, input.destPathNoExt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("excede 100 MB")) continue;
      throw err;
    }
  }
  throw new Error(`Magnific: todas as ${results.length} imagens para "${input.keywords}" excedem 100 MB`);
}

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Extrai o video ID do parametro `v=` de uma URL do YouTube.
 * Aceita formatos: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID
 */
export function extractVideoId(url: string): string {
  const trimmed = url.trim();

  // youtu.be/<id>
  const shortMatch = trimmed.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1]!;

  // youtube.com/embed/<id>
  const embedMatch = trimmed.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{11})/);
  if (embedMatch) return embedMatch[1]!;

  // youtube.com/watch?v=<id>
  try {
    const parsed = new URL(trimmed);
    const v = parsed.searchParams.get("v");
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
  } catch {
    // not a valid URL
  }

  throw new Error(
    `Nao foi possivel extrair video ID da URL: ${trimmed}\n` +
      "Formatos aceitos: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID"
  );
}

/** Monta a URL da thumbnail maxresdefault do YouTube a partir do video ID. */
export function buildThumbnailUrl(videoId: string): string {
  return `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
}

/**
 * Baixa a thumbnail de um video do YouTube para o diretorio especificado.
 * Retorna o caminho absoluto do arquivo salvo.
 */
export async function downloadYoutubeThumbnail(
  videoId: string,
  destDir: string
): Promise<string> {
  const url = buildThumbnailUrl(videoId);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Falha ao baixar thumbnail do YouTube (HTTP ${res.status}): ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const fileName = `Thumbnail_${videoId}.jpg`;
  const destPath = path.join(destDir, fileName);
  await fs.mkdir(destDir, { recursive: true });
  await fs.writeFile(destPath, buf);
  return destPath;
}

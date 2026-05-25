import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { textToSpeechMp3 } from "../integrations/elevenlabs.js";
import { stripMarkdownForSpeech } from "../utils/markdown-for-tts.js";
import { getDb, nowIso } from "../db.js";

const TTS_CACHE_DIR = path.join(DATA_DIR, "tts_cache");

function computeTtsHash(cleanText: string, voiceId: string): string {
  return crypto.createHash("sha256").update(`${cleanText}|${voiceId}`).digest("hex");
}

function findTtsCachePath(hash: string): string | null {
  const row = getDb()
    .prepare("SELECT file_path FROM tts_cache WHERE text_hash = ? LIMIT 1")
    .get(hash) as { file_path: string } | undefined;
  return row?.file_path ?? null;
}

function insertTtsCacheEntry(hash: string, voiceId: string, filePath: string, textLength: number): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO tts_cache (text_hash, voice_id, file_path, text_length, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(hash, voiceId, filePath, textLength, nowIso());
}

/**
 * Gera audio TTS com cache por hash(texto_limpo + voiceId).
 *
 * Hit:  copia o MP3 do cache para destPath sem chamar ElevenLabs.
 * Miss: chama ElevenLabs, escreve destPath, salva copia canonical no cache.
 *
 * Retorna `{ cacheHit: true }` em caso de reuso ou `{ cacheHit: false }` em geracao nova.
 */
export async function cachedTextToSpeech(
  input: { text: string; voiceId: string },
  destPath: string,
): Promise<{ cacheHit: boolean }> {
  const cleanText = stripMarkdownForSpeech(input.text);
  if (!cleanText.trim()) {
    throw new Error("Texto de narracao vazio apos remover Markdown");
  }

  const hash = computeTtsHash(cleanText, input.voiceId);
  const cachedFilePath = findTtsCachePath(hash);

  if (cachedFilePath) {
    try {
      await fs.access(cachedFilePath);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(cachedFilePath, destPath);
      return { cacheHit: true };
    } catch {
      // arquivo removido manualmente do cache — regerar
    }
  }

  const audioBuffer = await textToSpeechMp3({ text: input.text, voiceId: input.voiceId });
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, audioBuffer);

  // Salvar copia canonical no diretorio de cache para reusos futuros
  await fs.mkdir(TTS_CACHE_DIR, { recursive: true });
  const canonicalPath = path.join(TTS_CACHE_DIR, `${hash}.mp3`);
  await fs.copyFile(destPath, canonicalPath);
  insertTtsCacheEntry(hash, input.voiceId, canonicalPath, cleanText.length);

  return { cacheHit: false };
}

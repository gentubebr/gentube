import fs from "node:fs/promises";
import path from "node:path";
import {
  GEMINI_VEO_DURATION_SECONDS,
  GEMINI_VEO_MODEL,
  GEMINI_VEO_POLL_INTERVAL_MS,
  GEMINI_VEO_RESOLUTION,
  GEMINI_VEO_TIMEOUT_MS,
} from "../config.js";
import { resolveReferenceImageToLocalFile } from "./higgsfield-cli.js";
import { getGeminiClient } from "./gemini-image.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

async function saveVideoToDisk(
  ai: ReturnType<typeof getGeminiClient>,
  video: { videoBytes?: string; uri?: string; mimeType?: string },
  outPathNoExt: string
): Promise<string> {
  const localPath = `${outPathNoExt}.mp4`;
  await fs.mkdir(path.dirname(localPath), { recursive: true });

  if (video.videoBytes) {
    await fs.writeFile(localPath, Buffer.from(video.videoBytes, "base64"));
    return localPath;
  }

  if (video.uri) {
    const fileMatch = /\/files\/([^/:?]+)/.exec(video.uri);
    if (fileMatch?.[1]) {
      await ai.files.download({
        file: `files/${fileMatch[1]}`,
        downloadPath: localPath,
      });
      return localPath;
    }
    throw new Error(`Veo: URI de download nao reconhecida: ${video.uri}`);
  }

  throw new Error("Veo: resposta sem videoBytes nem uri");
}

/**
 * Gera video com Veo via LRO e polling sincrono (bloqueia ate done ou timeout).
 * Modelo/resolucao/audio: config global (veo-3.1-lite-generate-preview, 1080p, sem audio).
 */
export async function generateVeoVideoSync(input: {
  prompt: string;
  outPathNoExt: string;
  referenceImagePath?: string;
}): Promise<{ localPath: string }> {
  const ai = getGeminiClient();
  const pollMs = GEMINI_VEO_POLL_INTERVAL_MS;
  const timeoutMs = GEMINI_VEO_TIMEOUT_MS;

  let refLocal: string | undefined;
  let tempRefDir: string | undefined;
  try {
    refLocal = await resolveReferenceImageToLocalFile(input.referenceImagePath);
    if (refLocal?.includes("gentube-hf-ref-")) {
      tempRefDir = path.dirname(refLocal);
    }

    const source: {
      prompt: string;
      image?: { imageBytes: string; mimeType: string };
    } = { prompt: input.prompt };

    if (refLocal && !refLocal.match(/^[0-9a-f-]{36}$/i)) {
      const buf = await fs.readFile(refLocal);
      source.image = {
        imageBytes: buf.toString("base64"),
        mimeType: mimeFromPath(refLocal),
      };
    }

    let operation = await ai.models.generateVideos({
      model: GEMINI_VEO_MODEL,
      source,
      config: {
        aspectRatio: "16:9",
        durationSeconds: GEMINI_VEO_DURATION_SECONDS,
        resolution: GEMINI_VEO_RESOLUTION,
        numberOfVideos: 1,
        // generateAudio so na Gemini Enterprise; API Developer rejeita o campo (audio off e padrao do modelo lite).
      },
    });

    const started = Date.now();
    while (!operation.done) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Veo: timeout apos ${Math.round(timeoutMs / 1000)}s (operation=${operation.name ?? "?"})`);
      }
      await sleep(pollMs);
      operation = await ai.operations.getVideosOperation({ operation });
    }

    if (operation.error) {
      const errMsg =
        typeof operation.error === "object" && operation.error !== null && "message" in operation.error
          ? String((operation.error as { message?: unknown }).message)
          : JSON.stringify(operation.error);
      throw new Error(`Veo: operacao falhou: ${errMsg}`);
    }

    const filtered = operation.response?.raiMediaFilteredCount ?? 0;
    if (filtered > 0) {
      const reasons = operation.response?.raiMediaFilteredReasons?.join("; ") ?? "RAI";
      throw new Error(`Veo: video filtrado por politica (${reasons})`);
    }

    const video = operation.response?.generatedVideos?.[0]?.video;
    if (!video) throw new Error("Veo: resposta sem generatedVideos");

    const localPath = await saveVideoToDisk(ai, video, input.outPathNoExt);
    return { localPath };
  } finally {
    if (tempRefDir) {
      await fs.rm(tempRefDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

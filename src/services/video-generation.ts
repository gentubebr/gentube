import path from "node:path";
import fs from "node:fs/promises";
import {
  resolveVisualModality,
  videoBackendFromEnv,
  wojakVeoUsesReferenceImage,
  type VideoBackend,
} from "../config.js";
import { sanitizeWojakPromptForVeo } from "../utils/wojak-prompt.js";
import { generateVideoWithDefaultsCli } from "../integrations/higgsfield-cli.js";
import { generateVeoVideoSync } from "../integrations/gemini-video.js";
import { searchAndDownload } from "../integrations/stock-download.js";
import {
  isGoogleQuotaOrBillingError,
  isHfTransientError,
  shouldFallbackHfToVeo,
  shouldFallbackVeoToMagnific,
  type VideoProvider,
} from "../utils/provider-errors.js";

export type RenderVideoInput = {
  prompt: string;
  outPathNoExt: string;
  referenceImageUrl?: string;
  magnificKeywords?: string | null;
  /** Pula HF (ex.: job HF async ja falhou). */
  skipHiggsfield?: boolean;
};

export type RenderVideoResult = {
  localPath: string;
  provider: VideoProvider;
  mediaUrl?: string;
};

async function downloadMedia(mediaUrl: string, outPathNoExt: string): Promise<string> {
  const res = await fetch(mediaUrl);
  if (!res.ok) throw new Error(`Download midia falhou (${res.status})`);
  const arr = await res.arrayBuffer();
  const localPath = `${outPathNoExt}.mp4`;
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, Buffer.from(arr));
  return localPath;
}

async function tryHiggsfieldVideo(input: RenderVideoInput): Promise<RenderVideoResult> {
  const out = await generateVideoWithDefaultsCli({
    prompt: input.prompt,
    referenceImageUrl: input.referenceImageUrl ?? "",
  });
  const localPath = await downloadMedia(out.mediaUrl, input.outPathNoExt);
  return { localPath, provider: "higgsfield", mediaUrl: out.mediaUrl };
}

async function tryVeoVideo(input: RenderVideoInput): Promise<RenderVideoResult> {
  const wojak = resolveVisualModality() === "wojak";
  const prompt = wojak ? sanitizeWojakPromptForVeo(input.prompt) : input.prompt;
  const useRef = wojak ? wojakVeoUsesReferenceImage() : Boolean(input.referenceImageUrl);
  const { localPath } = await generateVeoVideoSync({
    prompt,
    outPathNoExt: input.outPathNoExt,
    referenceImagePath: useRef ? input.referenceImageUrl : undefined,
  });
  return { localPath, provider: "veo" };
}

async function tryMagnificVideo(keywords: string, outPathNoExt: string): Promise<RenderVideoResult> {
  const localPath = await searchAndDownload({
    type: "video",
    keywords: keywords.trim(),
    destPathNoExt: outPathNoExt,
  });
  return { localPath, provider: "magnific" };
}

function keywordsForMagnific(input: RenderVideoInput): string | null {
  const k = input.magnificKeywords?.trim();
  if (k) return k;
  const words = input.prompt.trim().split(/\s+/).slice(0, 8).join(" ");
  return words.length >= 3 ? words : null;
}

async function tryHiggsfieldWithRetries(input: RenderVideoInput): Promise<RenderVideoResult> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await tryHiggsfieldVideo(input);
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      if (shouldFallbackHfToVeo(msg)) {
        throw Object.assign(new Error(msg), { __gentubeHfCredits: true });
      }
      if (!isHfTransientError(msg) || attempt === maxAttempts) break;
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(msg);
}

/**
 * HF → Veo (sync poll) → Magnific conforme GENTUBE_VIDEO_BACKEND e matriz de erros.
 */
export async function renderVideoWithFallback(input: RenderVideoInput): Promise<RenderVideoResult> {
  if (resolveVisualModality() === "wojak") {
    return tryVeoVideo(input);
  }

  const backend: VideoBackend = videoBackendFromEnv();
  const errors: string[] = [];

  if (backend === "magnific") {
    const kw = keywordsForMagnific(input);
    if (!kw) throw new Error("Magnific: keywords ausentes (search_keywords ou prompt curto)");
    return tryMagnificVideo(kw, input.outPathNoExt);
  }

  if (backend === "veo") {
    return tryVeoVideo(input);
  }

  if (!input.skipHiggsfield) {
    try {
      return await tryHiggsfieldWithRetries(input);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const credits = Boolean((error as { __gentubeHfCredits?: boolean }).__gentubeHfCredits);
      if (backend === "higgsfield" || (!credits && !shouldFallbackHfToVeo(msg))) {
        throw error instanceof Error ? error : new Error(msg);
      }
      errors.push(`HF: ${msg}`);
    }
  }

  try {
    return await tryVeoVideo(input);
  } catch (veoErr) {
    const msg = veoErr instanceof Error ? veoErr.message : String(veoErr);
    errors.push(`Veo: ${msg}`);

    const kw = keywordsForMagnific(input);
    const tryMagnific =
      Boolean(kw) &&
      (backend === "auto" || shouldFallbackVeoToMagnific(msg) || isGoogleQuotaOrBillingError(msg));
    if (tryMagnific && kw) {
      try {
        return await tryMagnificVideo(kw, input.outPathNoExt);
      } catch (magErr) {
        const mMsg = magErr instanceof Error ? magErr.message : String(magErr);
        errors.push(`Magnific: ${mMsg}`);
      }
    }

    if (!kw) throw new Error(`${errors.join(" | ")} | Magnific: sem keywords`);
    throw new Error(errors.join(" | "));
  }
}

/** Apos falha HF async: Veo → Magnific (sem re-tentar HF). */
export async function renderVideoAfterHfFailure(input: RenderVideoInput): Promise<RenderVideoResult> {
  return renderVideoWithFallback({ ...input, skipHiggsfield: true });
}

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp"];

async function firstExistingPath(candidates: string[]): Promise<string | undefined> {
  for (const p of candidates) {
    try {
      await fs.access(p);
      return p;
    } catch {
      /* next */
    }
  }
  return undefined;
}

async function resolveReferenceImageForVideo(
  rendersDir: string,
  shotId: string,
  priorSceneIds: string[]
): Promise<string | undefined> {
  const bootstrap = await firstExistingPath([
    path.join(rendersDir, `${shotId}__bootstrap.png`),
    path.join(rendersDir, `${shotId}__bootstrap.jpg`),
    path.join(rendersDir, `${shotId}.jpg`),
    path.join(rendersDir, `${shotId}.png`),
  ]);
  if (bootstrap) return bootstrap;

  for (let i = priorSceneIds.length - 1; i >= 0; i -= 1) {
    const id = priorSceneIds[i]!;
    for (const ext of IMAGE_EXTS) {
      const candidate = path.join(rendersDir, `${id}${ext}`);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        /* next */
      }
    }
  }
  return undefined;
}

/** Metadados de cena para fallback no higgsfield:sync / video:retry. */
export async function loadSceneVideoMetaFromProject(
  projectPath: string,
  blockNumber: number,
  shotId: string
): Promise<{ prompt: string; searchKeywords: string | null; referenceImagePath?: string } | null> {
  const pad = String(blockNumber).padStart(2, "0");
  const jsonPath = path.join(projectPath, "03 - Imagens e Videos", `block${pad}.assets.json`);
  const rendersDir = path.join(projectPath, "03 - Imagens e Videos", "renders", `block${pad}`);
  try {
    const raw = await fs.readFile(jsonPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      scenes?: Array<{ id: string; visual?: { type?: string; description?: string; search_keywords?: string | null } }>;
    };
    const scenes = parsed.scenes ?? [];
    const idx = scenes.findIndex((s) => s.id === shotId);
    if (idx < 0) return null;
    const scene = scenes[idx]!;
    if (!scene.visual || scene.visual.type !== "video") return null;
    const desc = scene.visual.description?.trim();
    if (!desc) return null;

    const priorIds = scenes.slice(0, idx).map((s) => s.id);
    const referenceImagePath = await resolveReferenceImageForVideo(rendersDir, shotId, priorIds);

    return {
      prompt: desc,
      searchKeywords: scene.visual.search_keywords?.trim() ?? null,
      referenceImagePath,
    };
  } catch {
    return null;
  }
}

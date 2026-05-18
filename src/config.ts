import path from "node:path";
import { homedir } from "node:os";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

export const ROOT_DIR = process.cwd();
export const VIDEOS_DIR = path.join(ROOT_DIR, "Videos");
export const TEMPLATE_CHANNEL_DIR = path.join(ROOT_DIR, "Template", "[Nome do Canal]");
export const PROMPTS_DIR = path.join(ROOT_DIR, "Prompts");
/** Caminho fixo do prompt classico (referencia; o pipeline usa `resolvePromptMatrixPath`). */
export const PROMPT_MATRIX_PATH = path.join(PROMPTS_DIR, "matriz.md");
export const PROMPT_MATRIX02_PATH = path.join(PROMPTS_DIR, "matriz02.md");
/** Segmentacao verbatim por cena (schema 2.0). */
export const PROMPT_SEGMENTA01_PATH = path.join(PROMPTS_DIR, "segmenta01.md");
/** Direcao visual por cena (schema 2.0). */
export const PROMPT_VISUALIZA01_PATH = path.join(PROMPTS_DIR, "visualiza01.md");
/** PNG dummy copiado para renders quando visual.source === manual_capture */
export const MANUAL_CAPTURE_PLACEHOLDER_PATH = path.join(ROOT_DIR, "src", "assets", "manual_capture", "placeholder.png");

/**
 * Ficheiro de prompt da etapa roteiro (sob `Prompts/`).
 * Prioridade: `cliOverride` (`--prompt-matrix`) > `GENTUBE_PROMPT_MATRIX` > `GENTUBE_ROTEIRO_MODE=tutorial` > default `matriz.md`.
 */
export function resolvePromptMatrixPath(cliOverride?: string): string {
  const fromCli = (cliOverride ?? "").trim();
  const fromEnvMatrix = (process.env.GENTUBE_PROMPT_MATRIX ?? "").trim();
  const mode = (process.env.GENTUBE_ROTEIRO_MODE ?? "").trim().toLowerCase();
  const raw =
    fromCli ||
    fromEnvMatrix ||
    (mode === "tutorial" ? "matriz_tutorial.md" : "");
  const nameIn = raw === "" ? "matriz.md" : raw;
  const baseName = path.basename(nameIn.replace(/^\.\//, ""));
  const withMd = baseName.toLowerCase().endsWith(".md") ? baseName : `${baseName}.md`;

  let resolved: string;
  if (path.isAbsolute(nameIn)) {
    resolved = path.normalize(nameIn);
  } else {
    resolved = path.resolve(PROMPTS_DIR, withMd);
  }

  const promptsResolved = path.resolve(PROMPTS_DIR);
  const rel = path.relative(promptsResolved, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Prompt de roteiro deve estar dentro de ${PROMPTS_DIR}. Recebido: ${raw || "(vazio)"}`);
  }

  return resolved;
}

/**
 * Ficheiro Markdown com voz e persona do canal (bloco 1 do roteiro).
 * `cliOverride` ou `GENTUBE_PROMPT_CANAL_VOICE`: nome em Prompts/ ou caminho absoluto sob Prompts/.
 * `none` ou `-` = nao carregar ficheiro. Desativar injecao: `GENTUBE_ROTEIRO_CANAL_VOICE=0`.
 */
export function resolveCanalVoicePath(cliOverride?: string): string | null {
  if (!roteiroCanalVoiceEnabled()) return null;
  const raw = (cliOverride ?? process.env.GENTUBE_PROMPT_CANAL_VOICE ?? "").trim();
  if (["-", "none"].includes(raw.toLowerCase())) return null;
  const nameIn = raw === "" ? "canal_voice.md" : raw;
  const baseName = path.basename(nameIn.replace(/^\.\//, ""));
  const withMd = baseName.toLowerCase().endsWith(".md") ? baseName : `${baseName}.md`;

  let resolved: string;
  if (path.isAbsolute(nameIn)) {
    resolved = path.normalize(nameIn);
  } else {
    resolved = path.resolve(PROMPTS_DIR, withMd);
  }

  const promptsResolved = path.resolve(PROMPTS_DIR);
  const rel = path.relative(promptsResolved, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Prompt de voz do canal deve estar dentro de ${PROMPTS_DIR}. Recebido: ${raw || "(vazio)"}`);
  }

  return resolved;
}

export const DATA_DIR = path.join(ROOT_DIR, "data");
export const DB_PATH = path.join(DATA_DIR, "gentube.db");

export const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY ?? "";

/** Modelo Claude (default: claude-opus-4-7) */
export const CLAUDE_MODEL = (process.env.CLAUDE_MODEL ?? "claude-opus-4-7").trim();

/** Max tokens de saida (default: 16000) */
export const CLAUDE_MAX_TOKENS = Math.max(
  1024,
  parseInt(process.env.CLAUDE_MAX_TOKENS ?? "16000", 10) || 16000,
);

/** Modo thinking: "adaptive" | "disabled" | "" (default: "") */
export const CLAUDE_THINKING = (process.env.CLAUDE_THINKING ?? "").trim().toLowerCase();

/**
 * Injeta o texto dos blocos 1..N-1 no prompt do roteiro (coesao entre blocos).
 * Desative com GENTUBE_ROTEIRO_PREV_CONTEXT=0 | false | off.
 */
export function roteiroPrevContextEnabled(): boolean {
  const v = String(process.env.GENTUBE_ROTEIRO_PREV_CONTEXT ?? "1").toLowerCase();
  return !["0", "false", "no", "off"].includes(v);
}

/**
 * Injeta `canal_voice.md` (ou GENTUBE_PROMPT_CANAL_VOICE) so no bloco 1 do roteiro.
 * Desative com GENTUBE_ROTEIRO_CANAL_VOICE=0 | false | off.
 */
export function roteiroCanalVoiceEnabled(): boolean {
  const v = String(process.env.GENTUBE_ROTEIRO_CANAL_VOICE ?? "1").toLowerCase();
  return !["0", "false", "no", "off"].includes(v);
}

/**
 * Limite de caracteres do contexto cumulativo dos blocos anteriores (0 = sem limite).
 * Se exceder, mantem-se o fim (blocos mais recentes). Default: 100000.
 */
export const ROTEIRO_PREV_CONTEXT_MAX_CHARS = (() => {
  const raw = process.env.GENTUBE_ROTEIRO_PREV_CONTEXT_CHARS ?? "100000";
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 100_000;
})();
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? "";
/** Voice ID padrao quando --voice-id nao e passado no CLI */
export const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID ?? "").trim();
export const HIGGSFIELD_API_KEY_ID = (process.env.HIGGSFIELD_API_KEY_ID ?? "").trim();
export const HIGGSFIELD_API_KEY_SECRET = (process.env.HIGGSFIELD_API_KEY_SECRET ?? "").trim();

/** Base da API usada pelo CLI oficial (`hf`): sobrescreve com HIGGSFIELD_API_URL. */
export const HIGGSFIELD_AGENTS_BASE_URL = (
  process.env.HIGGSFIELD_API_URL ?? "https://fnf.higgsfield.ai"
).replace(/\/+$/, "");

/** Arquivo de credenciais do CLI (access_token / refresh_token). */
export function higgsfieldCliCredentialsPath(): string {
  const fromEnv = (process.env.HIGGSFIELD_CREDENTIALS_PATH ?? "").trim();
  if (fromEnv) return fromEnv;
  return path.join(homedir(), ".config", "higgsfield", "credentials.json");
}

/** Caminho absoluto do binario `hf` / `higgsfield` (opcional; senao usa PATH). */
export const HIGGSFIELD_CLI_PATH = (process.env.HIGGSFIELD_CLI_PATH ?? "").trim();

/** API key da Magnific (ex-Freepik) para stock footage/imagens */
export const MAGNIFIC_API_KEY = (process.env.MAGNIFIC_API_KEY ?? "").trim();

/** % de shots do bloco 1 vindos do stock Magnific (default: 50) */
export const STOCK_RATIO_BLOCK1 = Math.min(
  100,
  Math.max(0, parseInt(process.env.GENTUBE_STOCK_RATIO_BLOCK1 ?? "50", 10) || 50),
);

/** % de shots dos blocos 2..N vindos do stock Magnific (default: 90) */
export const STOCK_RATIO_OTHER = Math.min(
  100,
  Math.max(0, parseInt(process.env.GENTUBE_STOCK_RATIO_OTHER ?? "90", 10) || 90),
);

export const DEFAULT_BLOCKS = 8;

function envNonNegativeInt(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * Step imagens: caps por bloco (Claude + plano). Padrao bloco 1: 16 videos, 20 imagens.
 * `.env`: `GENTUBE_MAX_VIDEOS_BLOCK1`, `GENTUBE_MAX_IMAGES_BLOCK1`. Flags CLI `--max-*-block1` tem prioridade sobre o valor efetivo usado na corrida (o fallback do parser e estes exports, ja resolvidos do env).
 */
export const DEFAULT_MAX_VIDEOS_BLOCK1 = envNonNegativeInt("GENTUBE_MAX_VIDEOS_BLOCK1", 16);
export const DEFAULT_MAX_IMAGES_BLOCK1 = envNonNegativeInt("GENTUBE_MAX_IMAGES_BLOCK1", 20);
/**
 * Blocos 2..N: padrao 10 videos, 40 imagens.
 * `.env`: `GENTUBE_MAX_VIDEOS_OTHER_BLOCKS`, `GENTUBE_MAX_IMAGES_OTHER_BLOCKS`.
 */
export const DEFAULT_MAX_VIDEOS_OTHER_BLOCKS = envNonNegativeInt("GENTUBE_MAX_VIDEOS_OTHER_BLOCKS", 10);
export const DEFAULT_MAX_IMAGES_OTHER_BLOCKS = envNonNegativeInt("GENTUBE_MAX_IMAGES_OTHER_BLOCKS", 40);

/** Google GenAI — chave (GEMINI_API_KEY ou alias google_api_key). */
export function geminiApiKey(): string {
  return (process.env.GEMINI_API_KEY ?? process.env.google_api_key ?? "").trim();
}

export const GEMINI_IMAGE_MODEL = (process.env.GEMINI_IMAGE_MODEL ?? "gemini-2.5-flash-image").trim();
export const GEMINI_IMAGE_MODEL_PRO = (process.env.GEMINI_IMAGE_MODEL_PRO ?? "gemini-3-pro-image-preview").trim();
export const GEMINI_PROJECT_NAME = (process.env.google_project_name ?? process.env.GEMINI_PROJECT_NAME ?? "").trim();
export const GEMINI_PARENT_FOLDER_ID = (
  process.env.google_parent_folder_id ?? process.env.GEMINI_PARENT_FOLDER_ID ?? ""
).trim();

export type ImageBackend = "auto" | "higgsfield" | "gemini";
export type ImageDeliveryMode = "sync" | "google_batch" | "local_batch";

export function imageBackendFromEnv(): ImageBackend {
  const v = (process.env.GENTUBE_IMAGE_BACKEND ?? "auto").trim().toLowerCase();
  if (v === "higgsfield" || v === "gemini") return v;
  return "auto";
}

export function imageDeliveryFromEnv(): ImageDeliveryMode {
  const v = (process.env.GENTUBE_IMAGE_DELIVERY ?? "google_batch").trim().toLowerCase();
  if (v === "sync" || v === "local_batch") return v;
  return "google_batch";
}

export const GEMINI_IMAGE_ASPECT_RATIO = (process.env.GENTUBE_GEMINI_IMAGE_ASPECT_RATIO ?? "16:9").trim();
export const GEMINI_IMAGE_SIZE = (process.env.GENTUBE_GEMINI_IMAGE_SIZE ?? "1K").trim();
export const GEMINI_LOCAL_BATCH_CONCURRENCY = Math.max(
  1,
  envNonNegativeInt("GENTUBE_GEMINI_LOCAL_CONCURRENCY", 4) || 4,
);

export function parseDurationMs(raw: string | undefined, fallbackMs: number): number {
  const s = (raw ?? "").trim();
  if (!s) return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(s);
  if (!m) return fallbackMs;
  const n = parseFloat(m[1]!);
  const unit = (m[2] ?? "s").toLowerCase();
  if (unit === "ms") return n;
  if (unit === "m") return n * 60_000;
  if (unit === "h") return n * 3_600_000;
  return n * 1000;
}

export const GEMINI_BATCH_POLL_INTERVAL_MS = parseDurationMs(process.env.GENTUBE_GEMINI_BATCH_POLL_INTERVAL, 60_000);

/** Veo — video IA (fallback quando HF sem creditos). */
export const GEMINI_VEO_MODEL = (
  process.env.GEMINI_VEO_MODEL ?? "veo-3.1-lite-generate-preview"
).trim();
export const GEMINI_VEO_RESOLUTION = (process.env.GEMINI_VEO_RESOLUTION ?? "1080p").trim();
/** Veo 3.1 lite: API aceita 4–8s (valores discretos; padrao 8). */
export const GEMINI_VEO_DURATION_SECONDS = (() => {
  const n = parseInt(process.env.GENTUBE_VEO_DURATION_SECONDS ?? "8", 10);
  const v = Number.isFinite(n) ? n : 8;
  if (v <= 4) return 4;
  if (v <= 5) return 4;
  if (v <= 7) return 6;
  return 8;
})();
export const GEMINI_VEO_POLL_INTERVAL_MS = parseDurationMs(process.env.GENTUBE_VEO_POLL_INTERVAL, 15_000);
export const GEMINI_VEO_TIMEOUT_MS = parseDurationMs(process.env.GENTUBE_VEO_TIMEOUT, 10 * 60_000);

export type VideoBackend = "auto" | "higgsfield" | "veo" | "magnific";

export function videoBackendFromEnv(): VideoBackend {
  const v = (process.env.GENTUBE_VIDEO_BACKEND ?? "auto").trim().toLowerCase();
  if (v === "higgsfield" || v === "veo" || v === "magnific") return v;
  return "auto";
}

export type ImageRunFlags = {
  googleBatchMode?: boolean;
  batchLocal?: boolean;
};

/** Resolve delivery: flags CLI > env. Mutuamente exclusivas (validar no CLI). */
export function resolveImageDelivery(flags?: ImageRunFlags): ImageDeliveryMode {
  if (flags?.batchLocal) return "local_batch";
  if (flags?.googleBatchMode) return "google_batch";
  return imageDeliveryFromEnv();
}

export function resolveImageBackend(flags?: ImageRunFlags, delivery?: ImageDeliveryMode): ImageBackend {
  if (flags?.googleBatchMode || flags?.batchLocal || delivery === "google_batch" || delivery === "local_batch") {
    const env = imageBackendFromEnv();
    if (env === "higgsfield") return "gemini";
    return env === "auto" ? "gemini" : "gemini";
  }
  return imageBackendFromEnv();
}

/** Flags --google-batch-mode e --batch-local nao podem ser usadas juntas. */
export function assertImageFlagsExclusive(flags?: ImageRunFlags): void {
  if (flags?.googleBatchMode && flags?.batchLocal) {
    throw new Error("--google-batch-mode e --batch-local sao mutuamente exclusivas");
  }
}

export function imageRunFlagsFromCli(opts: {
  googleBatchMode?: boolean;
  batchLocal?: boolean;
}): ImageRunFlags {
  const flags: ImageRunFlags = {
    googleBatchMode: Boolean(opts.googleBatchMode),
    batchLocal: Boolean(opts.batchLocal),
  };
  assertImageFlagsExclusive(flags);
  return flags;
}

/** `--plan-only` e `--enqueue-only` sao mutuamente exclusivas. */
export function assertImagensPhaseFlagsExclusive(opts: { planOnly?: boolean; enqueueOnly?: boolean }): void {
  if (opts.planOnly && opts.enqueueOnly) {
    throw new Error("--plan-only e --enqueue-only sao mutuamente exclusivas");
  }
}

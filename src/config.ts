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
/** Addon Wojak (composicao com visualiza01 quando modality=wojak). */
export const PROMPT_VISUALIZA_WOJAK_PATH = path.join(PROMPTS_DIR, "visualiza_wojak.md");
/** Addon segmentacao Stoic Patrol. */
export const PROMPT_SEGMENTA_STOIC_PATROL_PATH = path.join(PROMPTS_DIR, "segmenta_stoic_patrol.md");
/** Addon visualizacao Stoic Patrol. */
export const PROMPT_VISUALIZA_STOIC_PATROL_PATH = path.join(PROMPTS_DIR, "visualiza_stoic_patrol.md");
/** Matriz de roteiro Stoic Patrol. */
export const PROMPT_MATRIX_STOIC_PATROL_PATH = path.join(PROMPTS_DIR, "matriz_stoic_patrol.md");
/** Voz do canal Stoic Patrol (bloco 1). */
export const PROMPT_CANAL_VOICE_STOIC_PATROL_PATH = path.join(PROMPTS_DIR, "canal_voice_stoic_patrol.md");
/** PNG dummy copiado para renders quando visual.source === manual_capture */
export const MANUAL_CAPTURE_PLACEHOLDER_PATH = path.join(ROOT_DIR, "src", "assets", "manual_capture", "placeholder.png");

export type VisualModality = "default" | "wojak" | "stoic_patrol";

export type WojakCharacterVariant =
  | "neutral"
  | "happy"
  | "smiling"
  | "tired"
  | "doomer"
  | "frontal"
  | "impressed"
  | "pain";

const WOJAK_ASSETS_DIR = path.join(ROOT_DIR, "src", "assets", "wojak");

export const WOJAK_REF_PATHS: Record<WojakCharacterVariant, string> = {
  neutral: path.join(WOJAK_ASSETS_DIR, "wojak_neutral.png"),
  happy: path.join(WOJAK_ASSETS_DIR, "wojak_happy.png"),
  smiling: path.join(WOJAK_ASSETS_DIR, "wojak_smiling.png"),
  tired: path.join(WOJAK_ASSETS_DIR, "wojak_tired.png"),
  doomer: path.join(WOJAK_ASSETS_DIR, "wojak_doomer.png"),
  frontal: path.join(WOJAK_ASSETS_DIR, "wojak_frontal.png"),
  impressed: path.join(WOJAK_ASSETS_DIR, "wojak_impressed.png"),
  pain: path.join(WOJAK_ASSETS_DIR, "wojak_pain.png"),
};

const DEFAULT_WOJAK_STYLE_TOKEN = [
  "minimalist line drawing character, bold black outlines, white fill, subtle gray shading,",
  "bald head, no hair, small beady eyes, flat nose, thin lips,",
  "clean white background, wojak meme face style, channel avatar,",
].join(" ");

export function wojakStyleToken(): string {
  const fromEnv = (process.env.GENTUBE_WOJAK_STYLE_TOKEN ?? "").trim();
  return fromEnv || DEFAULT_WOJAK_STYLE_TOKEN;
}

/** Veo: por defeito nao envia PNG/bootstrap (evita RAI third-party). `1` para image-to-video com ref. */
export function wojakVeoUsesReferenceImage(): boolean {
  return ["1", "true", "yes"].includes(String(process.env.GENTUBE_WOJAK_VEO_USE_REF ?? "0").toLowerCase());
}

export function resolveVisualModality(): VisualModality {
  const raw = (process.env.GENTUBE_VISUAL_MODALITY ?? "default").trim().toLowerCase();
  if (raw === "wojak") return "wojak";
  if (raw === "stoic_patrol" || raw === "stoic-patrol" || raw === "religious") return "stoic_patrol";
  return "default";
}

/** Em modo Wojak o plano nao usa stock; Stoic Patrol 100% stock entre quotes. */
export function resolveStockRatioForBlock(blockNumber: number): number {
  if (resolveVisualModality() === "wojak") return 0;
  if (resolveVisualModality() === "stoic_patrol") return 100;
  return blockNumber === 1 ? STOCK_RATIO_BLOCK1 : STOCK_RATIO_OTHER;
}

/** Segmentacao v2: base + addon por modalidade. */
export async function resolveSegmentaPromptContent(): Promise<string> {
  const fs = await import("node:fs/promises");
  const base = await fs.readFile(PROMPT_SEGMENTA01_PATH, "utf-8");
  if (resolveVisualModality() !== "stoic_patrol") return base;
  const addon = await fs.readFile(PROMPT_SEGMENTA_STOIC_PATROL_PATH, "utf-8");
  return `${base}\n\n---\n\n${addon}`;
}

function resolvePromptFileInPromptsDir(raw: string): string {
  const nameIn = raw.trim();
  const baseName = path.basename(nameIn.replace(/^\.\//, ""));
  const withMd = baseName.toLowerCase().endsWith(".md") ? baseName : `${baseName}.md`;
  const resolved = path.isAbsolute(nameIn) ? path.normalize(nameIn) : path.resolve(PROMPTS_DIR, withMd);
  const rel = path.relative(path.resolve(PROMPTS_DIR), resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Prompt de visualizacao deve estar dentro de ${PROMPTS_DIR}. Recebido: ${raw}`);
  }
  return resolved;
}

/** Conteudo do prompt Claude de visualizacao (v2). */
export async function resolveVisualizaPromptContent(): Promise<string> {
  const fs = await import("node:fs/promises");
  const fromEnv = (process.env.GENTUBE_PROMPT_VISUALIZA ?? "").trim();
  if (fromEnv) {
    const p = resolvePromptFileInPromptsDir(fromEnv);
    return fs.readFile(p, "utf-8");
  }
  const base = await fs.readFile(PROMPT_VISUALIZA01_PATH, "utf-8");
  const modality = resolveVisualModality();
  if (modality === "wojak") {
    const addon = await fs.readFile(PROMPT_VISUALIZA_WOJAK_PATH, "utf-8");
    return `${base}\n\n---\n\n${addon}`;
  }
  if (modality === "stoic_patrol") {
    const addon = await fs.readFile(PROMPT_VISUALIZA_STOIC_PATROL_PATH, "utf-8");
    return `${base}\n\n---\n\n${addon}`;
  }
  return base;
}

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
  let nameIn = raw === "" ? "matriz.md" : raw;
  if (raw === "" && resolveVisualModality() === "stoic_patrol") {
    nameIn = "matriz_stoic_patrol.md";
  }
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
  let nameIn = raw === "" ? "canal_voice.md" : raw;
  if (raw === "" && resolveVisualModality() === "stoic_patrol") {
    nameIn = "canal_voice_stoic_patrol.md";
  }
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

export type ClaudeDeliveryMode = "sync" | "batch";

/** Entrega Claude: batch (50% custo, assincrono) ou sync (debug). Default: batch. */
export function claudeDeliveryFromEnv(): ClaudeDeliveryMode {
  const v = (process.env.GENTUBE_CLAUDE_DELIVERY ?? "batch").trim().toLowerCase();
  if (v === "sync") return "sync";
  return "batch";
}

/**
 * Batch de roteiro por etapa: submete todos os blocos pendentes em 1 unico Message Batch
 * (vs 1 batch por bloco). Economiza latencia de API e simplifica rastreio.
 * Tradeoff: blocos submetidos em paralelo — sem contexto cruzado entre blocos em execucao inicial.
 * Ativar com GENTUBE_ROTEIRO_STAGE_BATCH=1.
 */
export function roteiroStageBatchEnabled(): boolean {
  return ["1", "true", "yes"].includes(
    (process.env.GENTUBE_ROTEIRO_STAGE_BATCH ?? "").trim().toLowerCase(),
  );
}

export type ClaudeBatchStage = "roteiro" | "segmentation" | "visualization";

/** Modelo por etapa; fallback CLAUDE_MODEL. */
export function claudeModelForStage(stage: ClaudeBatchStage): string {
  const key =
    stage === "roteiro"
      ? "GENTUBE_CLAUDE_MODEL_ROTEIRO"
      : stage === "segmentation"
        ? "GENTUBE_CLAUDE_MODEL_SEGMENTATION"
        : "GENTUBE_CLAUDE_MODEL_VISUALIZATION";
  const specific = (process.env[key] ?? "").trim();
  return specific || CLAUDE_MODEL;
}

/** Thinking em pedidos JSON estruturados (seg/viz): default disabled em batch. */
export function claudeThinkingForStage(stage: ClaudeBatchStage): string {
  const key =
    stage === "roteiro"
      ? "GENTUBE_CLAUDE_THINKING_ROTEIRO"
      : "GENTUBE_CLAUDE_THINKING_PLAN";
  const v = (process.env[key] ?? "").trim().toLowerCase();
  if (v) return v;
  if (stage === "roteiro") return CLAUDE_THINKING;
  return process.env.GENTUBE_CLAUDE_THINKING_PLAN?.trim().toLowerCase() || "disabled";
}

export const CLAUDE_BATCH_POLL_INTERVAL_MS = parseDurationMs(
  process.env.GENTUBE_CLAUDE_BATCH_POLL_INTERVAL,
  60_000,
);

/** max_scenes = min(cap, ceil(palavras/divisor)) quando dinamico ativo. */
export const MAX_SCENES_DYNAMIC_ENABLED = !["0", "false", "no", "off"].includes(
  String(process.env.GENTUBE_MAX_SCENES_DYNAMIC ?? "1").toLowerCase(),
);
export const MAX_SCENES_WORDS_DIVISOR = Math.max(
  8,
  parseInt(process.env.GENTUBE_MAX_SCENES_WORDS_DIVISOR ?? "18", 10) || 18,
);
export const MAX_SCENES_CAP = Math.max(
  20,
  parseInt(process.env.GENTUBE_MAX_SCENES_CAP ?? "120", 10) || 120,
);

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
/** Render de quote cards: auto | hyperframes | ffmpeg (fallback ASS typing). */
export function quoteRenderEngine(): "auto" | "hyperframes" | "ffmpeg" {
  const v = (process.env.GENTUBE_QUOTE_RENDER ?? "auto").trim().toLowerCase();
  if (v === "hyperframes" || v === "ffmpeg") return v;
  return "auto";
}

// --- QualityGateAgent ---

/** Ativa/desativa o agente de avaliacao de qualidade do roteiro (default: ativo). */
export function qualityGateEnabled(): boolean {
  return !["0", "false", "no", "off"].includes(
    String(process.env.GENTUBE_QUALITY_GATE_ENABLED ?? "1").toLowerCase(),
  );
}

/** Score minimo (0-100) para aprovacao direta; abaixo disso regenera (max QUALITY_GATE_MAX_REGEN vezes). */
export const QUALITY_GATE_THRESHOLD = Math.min(
  100,
  Math.max(0, parseInt(process.env.GENTUBE_QUALITY_GATE_THRESHOLD ?? "65", 10) || 65),
);

/** Maximo de regeneracoes por bloco quando score abaixo do threshold (default 1). */
export const QUALITY_GATE_MAX_REGEN = Math.max(
  0,
  parseInt(process.env.GENTUBE_QUALITY_GATE_MAX_REGEN ?? "1", 10) || 1,
);

/** Modelo usado pelo QualityGateAgent (default Sonnet — avaliacao estruturada JSON). */
export const QUALITY_GATE_MODEL = (
  process.env.GENTUBE_CLAUDE_MODEL_QUALITY_GATE ?? "claude-sonnet-4-6"
).trim();

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

/** API key Pexels — stock alternativo (https://www.pexels.com/api/documentation/) */
export const PEXELS_API_KEY = (process.env.PEXELS_API_KEY ?? "").trim();

export type StockProviderMode = "magnific" | "pexels" | "magnific_then_pexels" | "pexels_then_magnific";

/** Provedor de stock no step imagens (default: magnific). */
export function resolveStockProvider(): StockProviderMode {
  const raw = (process.env.GENTUBE_STOCK_PROVIDER ?? "magnific").trim().toLowerCase();
  if (raw === "pexels") return "pexels";
  if (raw === "magnific_then_pexels" || raw === "magnific-then-pexels") return "magnific_then_pexels";
  if (raw === "pexels_then_magnific" || raw === "pexels-then-magnific") return "pexels_then_magnific";
  return "magnific";
}

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

/**
 * Entrega de imagem por cena. Modo Wojak (opcao B): google_batch com PNG de referencia no job;
 * bootstrap de video (forceSync) permanece sync.
 */
export function resolveSceneImageDelivery(
  flags?: ImageRunFlags,
  opts?: { forceSync?: boolean },
): ImageDeliveryMode {
  if (opts?.forceSync) return "sync";
  if (resolveVisualModality() === "wojak") return "google_batch";
  return resolveImageDelivery(flags);
}

export function isWojakGoogleBatchMode(flags?: ImageRunFlags): boolean {
  return resolveSceneImageDelivery(flags) === "google_batch";
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

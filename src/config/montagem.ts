import path from "node:path";
import { ROOT_DIR } from "../config.js";

function envBool(key: string, defaultOn: boolean): boolean {
  const raw = (process.env[key] ?? "").trim().toLowerCase();
  if (raw === "") return defaultOn;
  return !["0", "false", "no", "off"].includes(raw);
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envList(key: string, fallback: string[]): string[] {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export type KenBurnsMode = "zoom_in" | "static";

/** full = clipes + blocos no mesmo passo; scenes = só scXX.mp4; assemble = só blockNN.mp4 a partir dos clipes */
export type MontagemPhase = "full" | "scenes" | "assemble";

function parseMontagemPhase(): MontagemPhase {
  const raw = (process.env.GENTUBE_MONTAGEM_PHASE ?? "").trim().toLowerCase();
  if (raw === "scenes") return "scenes";
  if (raw === "assemble") return "assemble";
  return "full";
}

export type MontagemConfig = {
  /** Controla se gera clipes, blocos ou ambos (CLI sobrescreve com --montagem-scenes-only / --montagem-assemble-only). */
  montagemPhase: MontagemPhase;
  requireScenePlanV2: boolean;
  montagemDir: string;
  scenesSubdir: string;
  blocksSubdir: string;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  videoPreset: string;
  videoCrf: number;
  audioCodec: string;
  audioBitrate: string;
  pixelFormat: string;
  kenBurnsMode: KenBurnsMode;
  kenBurnsZoomStart: number;
  kenBurnsZoomEnd: number;
  kenBurnsZoomStep: number;
  /** Largura intermédia antes do zoompan (menor = mais rápido; 3840 costuma bastar para 1080p). */
  kenBurnsScaleWidth: number;
  trimRatio: number;
  maxSpeed: number;
  loopVideo: boolean;
  xfadeDuration: number;
  xfadeTransition: string;
  audioCrossfade: boolean;
  /** single = um ffmpeg com cadeia xfade (rapido); pairwise = um encode por par (lento, legado) */
  xfadeConcatMode: "single" | "pairwise";
  /** Acima deste N de clipes, divide em lotes single-pass e funde os lotes (evita OOM no bloco inteiro). */
  xfadeMaxScenesSinglePass: number;
  partialSegments: boolean;
  minScenesPerSegment: number;
  stopOnBlockError: boolean;
  writeErrFile: boolean;
  skipExisting: boolean;
  minMp3Bytes: number;
  videoExts: string[];
  imageExts: string[];
  ffmpegPath: string;
  ffprobePath: string;
};

export function resolveMontagemConfig(overrides?: Partial<MontagemConfig>): MontagemConfig {
  const ffmpegFromEnv = (process.env.GENTUBE_FFMPEG_PATH ?? "").trim();
  const ffprobeFromEnv = (process.env.GENTUBE_FFPROBE_PATH ?? "").trim();
  const bundledFfmpeg = path.join(ROOT_DIR, "experiments", "ffmpeg-bin", "ffmpeg");
  const bundledFfprobe = path.join(ROOT_DIR, "experiments", "ffmpeg-bin", "ffprobe");

  const kenMode = (process.env.GENTUBE_KEN_BURNS_MODE ?? "zoom_in").trim().toLowerCase();
  const base: MontagemConfig = {
    montagemPhase: parseMontagemPhase(),
    requireScenePlanV2: envBool("GENTUBE_MONTAGEM_REQUIRE_SCENE_PLAN_V2", true),
    montagemDir: process.env.GENTUBE_MONTAGEM_DIR?.trim() || "06 - Montagem",
    scenesSubdir: process.env.GENTUBE_MONTAGEM_SCENES_SUBDIR?.trim() || "scenes",
    blocksSubdir: process.env.GENTUBE_MONTAGEM_BLOCKS_SUBDIR?.trim() || "blocks",
    width: envInt("GENTUBE_MONTAGEM_WIDTH", 1920),
    height: envInt("GENTUBE_MONTAGEM_HEIGHT", 1080),
    fps: envInt("GENTUBE_MONTAGEM_FPS", 30),
    videoCodec: process.env.GENTUBE_MONTAGEM_VIDEO_CODEC?.trim() || "libx264",
    videoPreset: process.env.GENTUBE_MONTAGEM_VIDEO_PRESET?.trim() || "fast",
    videoCrf: envInt("GENTUBE_MONTAGEM_VIDEO_CRF", 23),
    audioCodec: process.env.GENTUBE_MONTAGEM_AUDIO_CODEC?.trim() || "aac",
    audioBitrate: process.env.GENTUBE_MONTAGEM_AUDIO_BITRATE?.trim() || "192k",
    pixelFormat: process.env.GENTUBE_MONTAGEM_PIXEL_FORMAT?.trim() || "yuv420p",
    kenBurnsMode: kenMode === "static" ? "static" : "zoom_in",
    kenBurnsZoomStart: envFloat("GENTUBE_KEN_BURNS_ZOOM_START", 1.0),
    kenBurnsZoomEnd: envFloat("GENTUBE_KEN_BURNS_ZOOM_END", 1.12),
    kenBurnsZoomStep: envFloat("GENTUBE_KEN_BURNS_ZOOM_STEP", 0.0004),
    kenBurnsScaleWidth: envInt("GENTUBE_KEN_BURNS_SCALE_WIDTH", 3840),
    trimRatio: envFloat("GENTUBE_MONTAGEM_TRIM_RATIO", 1.25),
    maxSpeed: envFloat("GENTUBE_MONTAGEM_MAX_SPEED", 2.0),
    loopVideo: envBool("GENTUBE_MONTAGEM_LOOP_VIDEO", true),
    xfadeDuration: envFloat("GENTUBE_MONTAGEM_XFADE_DURATION", 0.1),
    xfadeTransition: process.env.GENTUBE_MONTAGEM_XFADE_TRANSITION?.trim() || "fade",
    audioCrossfade: envBool("GENTUBE_MONTAGEM_AUDIO_CROSSFADE", true),
    xfadeConcatMode:
      (process.env.GENTUBE_MONTAGEM_XFADE_CONCAT ?? "single").trim().toLowerCase() === "pairwise"
        ? "pairwise"
        : "single",
    xfadeMaxScenesSinglePass: envInt("GENTUBE_MONTAGEM_XFADE_MAX_SCENES_SINGLE", 40),
    partialSegments: envBool("GENTUBE_MONTAGEM_PARTIAL_SEGMENTS", true),
    minScenesPerSegment: envInt("GENTUBE_MONTAGEM_MIN_SCENES_PER_SEGMENT", 1),
    stopOnBlockError: envBool("GENTUBE_MONTAGEM_STOP_ON_BLOCK_ERROR", false),
    writeErrFile: envBool("GENTUBE_MONTAGEM_WRITE_ERR_FILE", true),
    skipExisting: envBool("GENTUBE_MONTAGEM_SKIP_EXISTING", true),
    minMp3Bytes: envInt("GENTUBE_MONTAGEM_MIN_MP3_BYTES", 1024),
    videoExts: envList("GENTUBE_MONTAGEM_VIDEO_EXTS", ["mp4", "mov", "webm"]),
    imageExts: envList("GENTUBE_MONTAGEM_IMAGE_EXTS", ["png", "jpg", "jpeg", "webp"]),
    ffmpegPath: ffmpegFromEnv || "ffmpeg",
    ffprobePath: ffprobeFromEnv || "ffprobe",
  };

  if (!ffmpegFromEnv && !ffprobeFromEnv) {
    base.ffmpegPath = bundledFfmpeg;
    base.ffprobePath = bundledFfprobe;
  }

  return { ...base, ...overrides };
}

export type MontagemRunOptions = {
  force?: boolean;
  blockNumber?: number;
  xfadeDuration?: number;
  xfadeTransition?: string;
  partialSegments?: boolean;
  montagemPhase?: MontagemPhase;
};

export function mergeMontagemRunOptions(
  cfg: MontagemConfig,
  cli?: MontagemRunOptions,
): MontagemConfig & { force: boolean; blockNumber?: number } {
  return {
    ...cfg,
    montagemPhase: cli?.montagemPhase ?? cfg.montagemPhase,
    xfadeDuration: cli?.xfadeDuration ?? cfg.xfadeDuration,
    xfadeTransition: cli?.xfadeTransition ?? cfg.xfadeTransition,
    partialSegments: cli?.partialSegments ?? cfg.partialSegments,
    skipExisting: cli?.force ? false : cfg.skipExisting,
    force: Boolean(cli?.force),
    blockNumber: cli?.blockNumber,
  };
}

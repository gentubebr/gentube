import path from "node:path";
import { homedir } from "node:os";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

export const ROOT_DIR = process.cwd();
export const VIDEOS_DIR = path.join(ROOT_DIR, "Videos");
export const TEMPLATE_CHANNEL_DIR = path.join(ROOT_DIR, "Template", "[Nome do Canal]");
export const PROMPT_MATRIX_PATH = path.join(ROOT_DIR, "Prompts", "matriz.md");
export const PROMPT_MATRIX02_PATH = path.join(ROOT_DIR, "Prompts", "matriz02.md");
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
export const DEFAULT_MAX_VIDEOS_BLOCK1 = 4;
export const DEFAULT_MAX_IMAGES_BLOCK1 = 6;
export const DEFAULT_MAX_VIDEOS_OTHER_BLOCKS = 2;
export const DEFAULT_MAX_IMAGES_OTHER_BLOCKS = 6;

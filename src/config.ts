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

export const DEFAULT_BLOCKS = 8;
export const DEFAULT_MAX_VIDEOS_BLOCK1 = 4;
export const DEFAULT_MAX_IMAGES_BLOCK1 = 6;
export const DEFAULT_MAX_VIDEOS_OTHER_BLOCKS = 2;
export const DEFAULT_MAX_IMAGES_OTHER_BLOCKS = 6;

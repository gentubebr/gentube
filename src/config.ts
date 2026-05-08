import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

export const ROOT_DIR = process.cwd();
export const VIDEOS_DIR = path.join(ROOT_DIR, "Videos");
export const TEMPLATE_CHANNEL_DIR = path.join(ROOT_DIR, "Template", "[Nome do Canal]");
export const PROMPT_MATRIX_PATH = path.join(ROOT_DIR, "Prompts", "matriz.md");
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const DB_PATH = path.join(DATA_DIR, "gentube.db");

export const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY ?? "";
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? "";

export const DEFAULT_BLOCKS = 8;

import fs from "node:fs/promises";
import path from "node:path";
import slugify from "slugify";

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export const MODELAGEM_DIR_NAME = "05 - Modelagem";
export const MODELAGEM_TRANSCRIPT_FILE = "transcript.txt";
export const MODELAGEM_ELEVENLABS_VOICE_FILE = "elevenlabs-voice-id.txt";

export const MONTAGEM_DIR_NAME = "06 - Montagem";

export async function ensureTemplateStructure(targetVideoDir: string): Promise<void> {
  const subfolders = [
    "01 - Roteiro",
    "02 - Narracao",
    "03 - Imagens e Videos",
    "04 - Thumbnails",
    MODELAGEM_DIR_NAME,
    MONTAGEM_DIR_NAME,
  ];

  for (const subfolder of subfolders) {
    await ensureDir(path.join(targetVideoDir, subfolder));
  }
}

/** Grava transcricao / notas de referencia na pasta de modelagem do projeto. */
export async function writeModelagemTranscript(projectPath: string, transcript: string): Promise<string> {
  const dir = path.join(projectPath, MODELAGEM_DIR_NAME);
  await ensureDir(dir);
  const filePath = path.join(dir, MODELAGEM_TRANSCRIPT_FILE);
  await fs.writeFile(filePath, transcript, "utf-8");
  return filePath;
}

/** Voice ID ElevenLabs por projeto (prioridade na narracao quando --voice-id omitido). */
export async function writeModelagemElevenlabsVoiceId(
  projectPath: string,
  voiceId: string,
): Promise<string> {
  const dir = path.join(projectPath, MODELAGEM_DIR_NAME);
  await ensureDir(dir);
  const filePath = path.join(dir, MODELAGEM_ELEVENLABS_VOICE_FILE);
  await fs.writeFile(filePath, `${voiceId.trim()}\n`, "utf-8");
  return filePath;
}

export async function readModelagemElevenlabsVoiceId(projectPath: string): Promise<string | null> {
  const filePath = path.join(projectPath, MODELAGEM_DIR_NAME, MODELAGEM_ELEVENLABS_VOICE_FILE);
  try {
    const raw = (await fs.readFile(filePath, "utf-8")).trim();
    return raw.length > 0 ? raw.split(/\s+/)[0]! : null;
  } catch {
    return null;
  }
}

export function toSlug(value: string): string {
  return slugify(value, { lower: false, strict: true, trim: true });
}

export function formatDateYYYYMMDD(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

import fs from "node:fs/promises";
import path from "node:path";
import slugify from "slugify";

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function ensureTemplateStructure(targetVideoDir: string): Promise<void> {
  const subfolders = [
    "01 - Roteiro",
    "02 - Narracao",
    "03 - Imagens e Videos",
    "04 - Thumbnails",
  ];

  for (const subfolder of subfolders) {
    await ensureDir(path.join(targetVideoDir, subfolder));
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

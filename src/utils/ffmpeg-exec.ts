import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import type { MontagemConfig } from "../config/montagem.js";

export class FfmpegNotFoundError extends Error {
  constructor(paths: string[]) {
    super(`ffmpeg/ffprobe nao encontrado. Defina GENTUBE_FFMPEG_PATH ou instale ffmpeg. Tentado: ${paths.join(", ")}`);
    this.name = "FfmpegNotFoundError";
  }
}

export async function assertFfmpegAvailable(cfg: MontagemConfig): Promise<void> {
  const missing: string[] = [];
  for (const bin of [cfg.ffmpegPath, cfg.ffprobePath]) {
    let ok = false;
    try {
      await fs.access(bin, fs.constants.X_OK);
      ok = true;
    } catch {
      const r = spawnSync(bin, ["-version"], { encoding: "utf-8" });
      ok = r.status === 0;
    }
    if (!ok) missing.push(bin);
  }
  if (missing.length > 0) {
    throw new FfmpegNotFoundError(missing);
  }
}

export function ffprobeDurationSeconds(cfg: MontagemConfig, filePath: string): number {
  const r = spawnSync(
    cfg.ffprobePath,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) {
    throw new Error(`ffprobe falhou em ${filePath}: ${(r.stderr || r.stdout || "").trim()}`);
  }
  const n = parseFloat((r.stdout || "").trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`duracao invalida em ${filePath}`);
  }
  return n;
}

export function runFfmpeg(cfg: MontagemConfig, args: string[]): void {
  const r = spawnSync(cfg.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || "").trim() || `exit ${r.status}`;
    throw new Error(`ffmpeg: ${msg}`);
  }
}

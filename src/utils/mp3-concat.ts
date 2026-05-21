import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_DIR } from "../config.js";

function resolveFfmpegForConcat(): string {
  const fromEnv = (process.env.GENTUBE_FFMPEG_PATH ?? "").trim();
  if (fromEnv) return fromEnv;
  return path.join(ROOT_DIR, "experiments", "ffmpeg-bin", "ffmpeg");
}

/** Concatena MP3s na ordem com ffmpeg (-c copy). Uma faixa: copia para o destino. */
export async function tryConcatMp3WithFfmpeg(sceneMp3Paths: string[], outputMp3Path: string): Promise<boolean> {
  if (sceneMp3Paths.length === 0) return false;
  if (sceneMp3Paths.length === 1) {
    await fs.copyFile(sceneMp3Paths[0], outputMp3Path);
    return true;
  }
  const listPath = `${outputMp3Path}.gentube-concat.txt`;
  const lines = sceneMp3Paths
    .map((p) => path.resolve(p))
    .map((abs) => `file '${abs.replace(/'/g, `'\\''`)}'`)
    .join("\n");
  await fs.writeFile(listPath, `${lines}\n`, "utf-8");
  const ffmpeg = resolveFfmpegForConcat();
  const r = spawnSync(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputMp3Path],
    { encoding: "utf-8" },
  );
  await fs.unlink(listPath).catch(() => {});
  return r.status === 0;
}

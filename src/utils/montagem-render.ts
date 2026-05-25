import fs from "node:fs/promises";
import path from "node:path";
import type { MontagemConfig } from "../config/montagem.js";
import { ffprobeDurationSeconds, runFfmpeg } from "./ffmpeg-exec.js";

function scalePadFilter(cfg: MontagemConfig): string {
  return `scale=${cfg.width}:${cfg.height}:force_original_aspect_ratio=decrease,pad=${cfg.width}:${cfg.height}:(ow-iw)/2:(oh-ih)/2`;
}

function encodeOutArgs(cfg: MontagemConfig, outputPath: string): string[] {
  return [
    "-c:v",
    cfg.videoCodec,
    "-preset",
    cfg.videoPreset,
    "-crf",
    String(cfg.videoCrf),
    "-c:a",
    cfg.audioCodec,
    "-b:a",
    cfg.audioBitrate,
    "-pix_fmt",
    cfg.pixelFormat,
    outputPath,
  ];
}

function kenBurnsFilter(cfg: MontagemConfig, frames: number): string {
  const zEnd = cfg.kenBurnsZoomEnd;
  const step = cfg.kenBurnsZoomStep;
  if (cfg.kenBurnsMode === "static") {
    return `${scalePadFilter(cfg)},format=${cfg.pixelFormat}`;
  }
  const sw = cfg.kenBurnsScaleWidth;
  return `scale=${sw}:-1,zoompan=z='min(zoom+${step},${zEnd})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${cfg.width}x${cfg.height}:fps=${cfg.fps},format=${cfg.pixelFormat}`;
}

export async function renderSceneClip(input: {
  cfg: MontagemConfig;
  mp3Path: string;
  visualPath: string;
  isImage: boolean;
  outPath: string;
}): Promise<void> {
  const { cfg, mp3Path, visualPath, isImage, outPath } = input;
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const tAudio = ffprobeDurationSeconds(cfg, mp3Path);
  const frames = Math.max(1, Math.round(tAudio * cfg.fps));

  if (isImage) {
    const vf =
      cfg.kenBurnsMode === "zoom_in"
        ? kenBurnsFilter(cfg, frames)
        : `${scalePadFilter(cfg)},format=${cfg.pixelFormat}`;
    runFfmpeg(cfg, [
      "-loop",
      "1",
      "-i",
      visualPath,
      "-i",
      mp3Path,
      "-vf",
      vf,
      "-t",
      String(tAudio),
      ...encodeOutArgs(cfg, outPath),
    ]);
    return;
  }

  const tVideo = ffprobeDurationSeconds(cfg, visualPath);
  const ratio = tVideo / tAudio;
  const vfBase = `${scalePadFilter(cfg)},format=${cfg.pixelFormat}`;

  if (tAudio > tVideo * 1.01 && cfg.loopVideo) {
    runFfmpeg(cfg, [
      "-stream_loop",
      "-1",
      "-i",
      visualPath,
      "-i",
      mp3Path,
      "-vf",
      vfBase,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-t",
      String(tAudio),
      ...encodeOutArgs(cfg, outPath),
    ]);
    return;
  }

  if (tAudio < tVideo) {
    if (ratio > cfg.trimRatio) {
      runFfmpeg(cfg, [
        "-i",
        visualPath,
        "-i",
        mp3Path,
        "-vf",
        vfBase,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-t",
        String(tAudio),
        ...encodeOutArgs(cfg, outPath),
      ]);
      return;
    }
    const speed = Math.min(cfg.maxSpeed, ratio);
    runFfmpeg(cfg, [
      "-i",
      visualPath,
      "-i",
      mp3Path,
      "-vf",
      `${scalePadFilter(cfg)},setpts=PTS/${speed},format=${cfg.pixelFormat}`,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      ...encodeOutArgs(cfg, outPath),
      "-shortest",
    ]);
    return;
  }

  runFfmpeg(cfg, [
    "-i",
    visualPath,
    "-i",
    mp3Path,
    "-vf",
    vfBase,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    ...encodeOutArgs(cfg, outPath),
    "-shortest",
  ]);
}

export async function concatClipsWithXfade(input: {
  cfg: MontagemConfig;
  clipPaths: string[];
  outPath: string;
}): Promise<void> {
  const { cfg, clipPaths, outPath } = input;
  if (clipPaths.length === 0) throw new Error("concatClipsWithXfade: lista vazia");
  if (clipPaths.length === 1) {
    await fs.copyFile(clipPaths[0]!, outPath);
    return;
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const maxSingle = cfg.xfadeMaxScenesSinglePass;
  if (clipPaths.length > maxSingle) {
    await concatClipsWithXfadeChunked(cfg, clipPaths, outPath, maxSingle);
    return;
  }

  if (cfg.xfadeConcatMode === "pairwise") {
    await concatClipsWithXfadePairwise(cfg, clipPaths, outPath);
    return;
  }

  await concatClipsWithXfadeSinglePass(cfg, clipPaths, outPath);
}

/** Lotes single-pass + merge final (blocos com 80+ cenas). */
async function concatClipsWithXfadeChunked(
  cfg: MontagemConfig,
  clipPaths: string[],
  outPath: string,
  chunkSize: number,
): Promise<void> {
  const chunks: string[][] = [];
  for (let i = 0; i < clipPaths.length; i += chunkSize) {
    chunks.push(clipPaths.slice(i, i + chunkSize));
  }

  const chunkOuts: string[] = [];
  const base = path.basename(outPath);
  for (let i = 0; i < chunks.length; i += 1) {
    const part = chunks[i]!;
    const chunkPath =
      chunks.length === 1
        ? outPath
        : path.join(path.dirname(outPath), `.xfade-chunk-${i}-${base}`);
    if (part.length === 1) {
      await fs.copyFile(part[0]!, chunkPath);
    } else if (cfg.xfadeConcatMode === "pairwise") {
      await concatClipsWithXfadePairwise(cfg, part, chunkPath);
    } else {
      await concatClipsWithXfadeSinglePass(cfg, part, chunkPath);
    }
    chunkOuts.push(chunkPath);
  }

  if (chunkOuts.length === 1) {
    if (chunkOuts[0] !== outPath) await fs.copyFile(chunkOuts[0]!, outPath);
    return;
  }

  try {
    await concatClipsWithXfade({ cfg, clipPaths: chunkOuts, outPath });
  } finally {
    for (const p of chunkOuts) {
      if (p !== outPath) await fs.unlink(p).catch(() => {});
    }
  }
}

/** Um encode para N cenas (em vez de N-1 encodes sobre video cada vez maior). */
async function concatClipsWithXfadeSinglePass(
  cfg: MontagemConfig,
  clipPaths: string[],
  outPath: string,
): Promise<void> {
  const durations = clipPaths.map((p) => ffprobeDurationSeconds(cfg, p));
  const d = cfg.xfadeDuration;
  const tr = cfg.xfadeTransition;
  const fps = cfg.fps;
  const pix = cfg.pixelFormat;

  const inputArgs: string[] = [];
  for (const p of clipPaths) {
    inputArgs.push("-i", p);
  }

  const parts: string[] = [];
  for (let i = 0; i < clipPaths.length; i += 1) {
    parts.push(`[${i}:v]fps=${fps},format=${pix},settb=AVTB[v${i}]`);
    if (cfg.audioCrossfade) {
      parts.push(
        `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`,
      );
    }
  }

  let vLabel = "v0";
  let aLabel = "a0";
  let accumulated = durations[0]!;

  for (let i = 1; i < clipPaths.length; i += 1) {
    const offset = Math.max(0, accumulated - d);
    const outV = i === clipPaths.length - 1 ? "vout" : `vx${i}`;
    parts.push(
      `[${vLabel}][v${i}]xfade=transition=${tr}:duration=${d}:offset=${offset.toFixed(3)}[${outV}]`,
    );
    vLabel = outV;

    if (cfg.audioCrossfade) {
      const outA = i === clipPaths.length - 1 ? "aout" : `ax${i}`;
      parts.push(`[${aLabel}][a${i}]acrossfade=d=${d}:c1=tri:c2=tri[${outA}]`);
      aLabel = outA;
    }

    accumulated += durations[i]! - d;
  }

  const maps = cfg.audioCrossfade
    ? ["-map", "[vout]", "-map", "[aout]"]
    : ["-map", "[vout]", "-map", `${clipPaths.length - 1}:a`];

  runFfmpeg(cfg, [
    ...inputArgs,
    "-filter_complex",
    parts.join(";"),
    ...maps,
    "-c:v",
    cfg.videoCodec,
    "-preset",
    cfg.videoPreset,
    "-crf",
    String(cfg.videoCrf),
    "-c:a",
    cfg.audioCodec,
    "-b:a",
    cfg.audioBitrate,
    outPath,
  ]);
}

async function concatClipsWithXfadePairwise(
  cfg: MontagemConfig,
  clipPaths: string[],
  outPath: string,
): Promise<void> {
  let current = clipPaths[0]!;
  for (let i = 1; i < clipPaths.length; i += 1) {
    const next = clipPaths[i]!;
    const tmp =
      i < clipPaths.length - 1
        ? path.join(path.dirname(outPath), `.xfade-tmp-${i}-${path.basename(outPath)}`)
        : outPath;
    await xfadePair(cfg, current, next, tmp);
    if (tmp !== current && current !== clipPaths[0]) {
      await fs.unlink(current).catch(() => {});
    }
    current = tmp;
  }
}

async function xfadePair(cfg: MontagemConfig, aPath: string, bPath: string, outPath: string): Promise<void> {
  const dA = ffprobeDurationSeconds(cfg, aPath);
  const offset = Math.max(0, dA - cfg.xfadeDuration);
  const d = String(cfg.xfadeDuration);
  const tr = cfg.xfadeTransition;

  const vNorm = `[0:v]fps=${cfg.fps},format=${cfg.pixelFormat},settb=AVTB[v0];[1:v]fps=${cfg.fps},format=${cfg.pixelFormat},settb=AVTB[v1];[v0][v1]xfade=transition=${tr}:duration=${d}:offset=${offset.toFixed(3)}[v]`;
  let filter = vNorm;
  let maps = ["-map", "[v]"];

  if (cfg.audioCrossfade) {
    filter += `;[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0];[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1];[a0][a1]acrossfade=d=${d}:c1=tri:c2=tri[a]`;
    maps = ["-map", "[v]", "-map", "[a]"];
  } else {
    maps = ["-map", "[v]", "-map", "1:a"];
  }

  runFfmpeg(cfg, [
    "-i",
    aPath,
    "-i",
    bPath,
    "-filter_complex",
    filter,
    ...maps,
    "-c:v",
    cfg.videoCodec,
    "-preset",
    cfg.videoPreset,
    "-crf",
    String(cfg.videoCrf),
    "-c:a",
    cfg.audioCodec,
    "-b:a",
    cfg.audioBitrate,
    outPath,
  ]);
}

export async function isOutputStale(outputPath: string, inputPaths: string[]): Promise<boolean> {
  try {
    const outStat = await fs.stat(outputPath);
    for (const p of inputPaths) {
      const st = await fs.stat(p);
      if (st.mtimeMs > outStat.mtimeMs) return true;
    }
    return false;
  } catch {
    return true;
  }
}

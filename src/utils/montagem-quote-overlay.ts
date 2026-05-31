import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MontagemConfig } from "../config/montagem.js";
import type { QuoteOverlay } from "../types/quotes-plan.js";
import { runFfmpeg } from "./ffmpeg-exec.js";

function escapeAssText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\n/g, "\\N");
}

function formatAssTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

function buildOverlayAss(overlays: QuoteOverlay[], fadeSec: number): string {
  const lines: string[] = [
    `[Script Info]`,
    `ScriptType: v4.00+`,
    `PlayResX: 1920`,
    `PlayResY: 1080`,
    ``,
    `[V4+ Styles]`,
    `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding`,
    `Style: Quote,Montserrat,52,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,3,2,0,5,120,120,80,1`,
    `Style: Impact,Montserrat,64,&H00FFFFFF,&H000000FF,&H00000000,&H60000000,1,0,0,0,100,100,0,0,1,2,1,5,100,100,120,1`,
    `Style: Attr,Montserrat,28,&H00DDDDDD,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,120,120,48,1`,
    ``,
    `[Events]`,
    `Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`,
  ];

  for (const ov of overlays) {
    const start = Math.max(0, ov.start_time_seconds);
    const end = Math.max(start + 0.2, ov.end_time_seconds);
    const t0 = formatAssTime(start);
    const t1 = formatAssTime(end);
    const style = ov.overlay_style === "impact" ? "Impact" : "Quote";
    const text = escapeAssText(ov.text.trim());
    lines.push(`Dialogue: 0,${t0},${t1},${style},,0,0,0,,${text}`);
    if (ov.reference && ov.overlay_style !== "impact") {
      const attrStart = formatAssTime(start + fadeSec);
      lines.push(`Dialogue: 0,${attrStart},${t1},Attr,,0,0,0,,${escapeAssText(ov.reference)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Aplica overlays ASS sobre clipe de cena ja renderizado (stock + narracao). */
export async function applyQuoteOverlaysToClip(input: {
  cfg: MontagemConfig;
  clipPath: string;
  overlays: QuoteOverlay[];
}): Promise<void> {
  if (input.overlays.length === 0) return;

  const fadeSec = Math.max(
    0.05,
    parseFloat(process.env.GENTUBE_OVERLAY_FADE_DURATION ?? "0.15") || 0.15,
  );
  const assContent = buildOverlayAss(input.overlays, fadeSec);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gentube-overlay-"));
  const assPath = path.join(tmpDir, "overlays.ass");
  const outPath = path.join(tmpDir, "out.mp4");
  await fs.writeFile(assPath, assContent, "utf-8");

  const assEsc = assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
  try {
    runFfmpeg(input.cfg, [
      "-i",
      input.clipPath,
      "-vf",
      `ass='${assEsc}'`,
      "-c:a",
      "copy",
      ...["-c:v", input.cfg.videoCodec, "-preset", input.cfg.videoPreset, "-crf", String(input.cfg.videoCrf)],
      outPath,
    ]);
    await fs.copyFile(outPath, input.clipPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_DIR, ROOT_DIR } from "../config.js";
import { resolveMontagemConfig } from "../config/montagem.js";
import { runFfmpeg } from "../utils/ffmpeg-exec.js";
import {
  pickAssQuoteFontSizePx,
  QUOTE_CARD_LAYOUT_VERSION,
  resolveQuoteAttributionFontSizePx,
  resolveQuoteCardDurationSeconds,
} from "../utils/quote-card-layout.js";

const execFileAsync = promisify(execFile);

const QUOTE_CACHE_DIR = path.join(DATA_DIR, "quote_cache");
const HF_TEMPLATE_DIR = path.join(ROOT_DIR, "src", "assets", "stoic-patrol", "hyperframes-quote");

export type QuoteCardRenderInput = {
  quoteText: string;
  quoteAttribution?: string | null;
  durationSeconds: number;
  outPath: string;
};

export type QuoteRenderEngine = "auto" | "hyperframes" | "ffmpeg";

function quoteRenderEngine(): QuoteRenderEngine {
  const v = (process.env.GENTUBE_QUOTE_RENDER ?? "auto").trim().toLowerCase();
  if (v === "hyperframes" || v === "ffmpeg") return v;
  return "auto";
}

function computeQuoteCacheHash(input: QuoteCardRenderInput): string {
  const payload = [
    input.quoteText.trim(),
    (input.quoteAttribution ?? "").trim(),
    String(Math.round(input.durationSeconds * 10) / 10),
    quoteRenderEngine(),
    QUOTE_CARD_LAYOUT_VERSION,
  ].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function escapeAssText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\n/g, "\\N");
}

/** Karaoke \\k tags — typing reveal synced to duration. */
function buildTypingAssDialogue(text: string, durationSec: number): string {
  const chars = [...text];
  if (chars.length === 0) return "";
  const totalCs = Math.max(20, Math.floor((durationSec * 72) / 1.4));
  const perChar = Math.max(2, Math.floor((totalCs * 0.85) / chars.length));
  return chars.map((ch) => `{\\k${perChar}}${escapeAssText(ch)}`).join("");
}

function buildAssFile(input: QuoteCardRenderInput): string {
  const duration = resolveQuoteCardDurationSeconds(input.quoteText.trim(), input.durationSeconds);
  const end = formatAssTime(duration);
  const quoteLine = buildTypingAssDialogue(input.quoteText.trim(), duration * 0.75);
  const attr = (input.quoteAttribution ?? "").trim();
  const quoteFs = pickAssQuoteFontSizePx(input.quoteText.trim(), Boolean(attr));
  const attrFs = resolveQuoteAttributionFontSizePx(quoteFs);
  const attrLine = attr
    ? `Dialogue: 0,0:00:01.20,${end},Attr,,0,0,0,,${escapeAssText(attr)}`
    : "";

  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Quote,Montserrat,${quoteFs},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,5,140,140,100,1
Style: Attr,Montserrat,${attrFs},&H00DDDDDD,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,140,140,48,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,${end},Quote,,0,0,0,,${quoteLine}
${attrLine}
`;
}

function formatAssTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

async function renderQuoteCardFfmpeg(input: QuoteCardRenderInput): Promise<void> {
  const cfg = resolveMontagemConfig();
  const duration = resolveQuoteCardDurationSeconds(input.quoteText.trim(), input.durationSeconds);
  const assPath = `${input.outPath}.ass`;
  await fs.mkdir(path.dirname(input.outPath), { recursive: true });
  await fs.writeFile(assPath, buildAssFile(input), "utf-8");

  const assEsc = assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
  await runFfmpeg(cfg, [
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${cfg.width}x${cfg.height}:d=${duration.toFixed(2)}`,
    "-vf",
    `ass='${assEsc}'`,
    "-c:v",
    cfg.videoCodec,
    "-pix_fmt",
    cfg.pixelFormat,
    "-an",
    "-t",
    String(duration),
    input.outPath,
  ]);
  await fs.unlink(assPath).catch(() => {});
}

async function hyperframesAvailable(): Promise<boolean> {
  const cfg = resolveMontagemConfig();
  try {
    await fs.access(cfg.ffmpegPath);
  } catch {
    return false;
  }
  try {
    await execFileAsync("npx", ["hyperframes", "--version"], {
      timeout: 90_000,
      maxBuffer: 512 * 1024,
      env: { ...process.env, PATH: ffmpegPathForSubprocess() },
    });
    return true;
  } catch {
    return false;
  }
}

function ffmpegPathForSubprocess(): string {
  const cfg = resolveMontagemConfig();
  const dir = path.dirname(cfg.ffmpegPath);
  return `${dir}:${process.env.PATH ?? ""}`;
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) await copyDirRecursive(s, d);
    else await fs.copyFile(s, d);
  }
}

async function renderQuoteCardHyperframes(input: QuoteCardRenderInput): Promise<void> {
  const workDir = path.join(DATA_DIR, "quote_render_work", crypto.randomBytes(8).toString("hex"));
  await copyDirRecursive(HF_TEMPLATE_DIR, workDir);
  await fs.mkdir(path.dirname(input.outPath), { recursive: true });

  const durationSec = resolveQuoteCardDurationSeconds(input.quoteText.trim(), input.durationSeconds);
  const vars = {
    quote_text: input.quoteText.trim(),
    quote_attribution: (input.quoteAttribution ?? "").trim(),
    duration_seconds: durationSec,
  };
  const varsPath = path.join(workDir, "variables.json");
  await fs.writeFile(varsPath, JSON.stringify(vars), "utf-8");

  const indexPath = path.join(workDir, "index.html");
  let indexHtml = await fs.readFile(indexPath, "utf-8");
  indexHtml = indexHtml.replace(/data-duration="[^"]*"/, `data-duration="${durationSec}"`);
  await fs.writeFile(indexPath, indexHtml, "utf-8");

  await execFileAsync(
    "npx",
    [
      "hyperframes",
      "render",
      workDir,
      "-o",
      input.outPath,
      "--variables-file",
      varsPath,
      "--resolution",
      "landscape",
      "-q",
      "standard",
      "--quiet",
    ],
    {
      timeout: 600_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PATH: ffmpegPathForSubprocess() },
    },
  );

  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
}

async function findCachedQuoteMp4(hash: string): Promise<string | null> {
  const cached = path.join(QUOTE_CACHE_DIR, `${hash}.mp4`);
  try {
    await fs.access(cached);
    return cached;
  } catch {
    return null;
  }
}

async function saveQuoteCache(hash: string, sourcePath: string): Promise<void> {
  await fs.mkdir(QUOTE_CACHE_DIR, { recursive: true });
  await fs.copyFile(sourcePath, path.join(QUOTE_CACHE_DIR, `${hash}.mp4`));
}

/**
 * Renderiza cartao de citacao (MP4 mudo 1920x1080).
 * Cache em data/quote_cache/{hash}.mp4
 */
export async function renderQuoteCardMp4(
  input: QuoteCardRenderInput,
): Promise<{ cacheHit: boolean; engine: "hyperframes" | "ffmpeg" }> {
  const hash = computeQuoteCacheHash(input);
  const cached = await findCachedQuoteMp4(hash);
  if (cached) {
    await fs.mkdir(path.dirname(input.outPath), { recursive: true });
    await fs.copyFile(cached, input.outPath);
    return { cacheHit: true, engine: quoteRenderEngine() === "ffmpeg" ? "ffmpeg" : "hyperframes" };
  }

  const enginePref = quoteRenderEngine();
  let engine: "hyperframes" | "ffmpeg" = "ffmpeg";

  if (enginePref === "hyperframes" || enginePref === "auto") {
    if (await hyperframesAvailable()) {
      try {
        await renderQuoteCardHyperframes(input);
        engine = "hyperframes";
      } catch (e) {
        if (enginePref === "hyperframes") throw e;
        await renderQuoteCardFfmpeg(input);
        engine = "ffmpeg";
      }
    } else if (enginePref === "hyperframes") {
      throw new Error(
        "Hyperframes indisponivel (FFmpeg/Node). Instale ffmpeg ou use GENTUBE_QUOTE_RENDER=ffmpeg",
      );
    } else {
      await renderQuoteCardFfmpeg(input);
      engine = "ffmpeg";
    }
  } else {
    await renderQuoteCardFfmpeg(input);
    engine = "ffmpeg";
  }

  await saveQuoteCache(hash, input.outPath);
  return { cacheHit: false, engine };
}

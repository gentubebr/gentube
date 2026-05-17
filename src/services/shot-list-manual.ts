import fs from "node:fs/promises";
import path from "node:path";
import { isBlockScenesPlanV2 } from "../utils/scenes-plan.js";

type ManualRow = {
  block_number: number;
  scene_id: string;
  narration_text: string;
  estimated_duration_seconds: number;
  method: string;
  target: string;
  actions: string;
  highlights: string;
  duration_hint_seconds?: number;
  ip_risk: string;
};

function csvEscape(val: unknown): string {
  if (val == null) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Lista `block*.assets.json` sob `03 - Imagens e Videos`, extrai cenas manual_capture (schema 2.0). */
export async function collectManualCaptureRows(projectPath: string): Promise<ManualRow[]> {
  const imagesDir = path.join(projectPath, "03 - Imagens e Videos");
  let entries: string[];
  try {
    entries = await fs.readdir(imagesDir);
  } catch {
    return [];
  }
  const jsonFiles = entries.filter((f) => /^block\d+\.assets\.json$/i.test(f));
  jsonFiles.sort((a, b) => {
    const na = parseInt(a.match(/\d+/)?.[0] ?? "0", 10);
    const nb = parseInt(b.match(/\d+/)?.[0] ?? "0", 10);
    return na - nb;
  });

  const allScenes: ManualRow[] = [];

  for (const fname of jsonFiles) {
    const blockNum = parseInt(fname.match(/\d+/)?.[0] ?? "0", 10);
    const raw = await fs.readFile(path.join(imagesDir, fname), "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isBlockScenesPlanV2(parsed)) continue;
    if (typeof parsed.block_number === "number" && parsed.block_number !== blockNum) continue;

    for (const scene of parsed.scenes) {
      const v = scene.visual;
      if (v?.source !== "manual_capture" || !v.capture_brief) continue;
      const brief = v.capture_brief;
      allScenes.push({
        block_number: parsed.block_number,
        scene_id: scene.id,
        narration_text: scene.narration_text,
        estimated_duration_seconds: scene.estimated_duration_seconds,
        method: brief.method,
        target: brief.target,
        actions: brief.actions,
        highlights: brief.highlights,
        duration_hint_seconds: brief.duration_hint_seconds,
        ip_risk: v.ip_risk ?? "none",
      });
    }
  }

  allScenes.sort((a, b) => {
    if (a.block_number !== b.block_number) return a.block_number - b.block_number;
    return a.scene_id.localeCompare(b.scene_id);
  });

  return allScenes;
}

export function buildShotListMarkdown(rows: ManualRow[]): { recordingOrder: string; batchedByTarget: string } {
  const mdLines: string[] = [];
  mdLines.push("# Shot List — Recording Order");
  mdLines.push("");
  mdLines.push(`Total manual captures: **${rows.length}**`);
  mdLines.push("");

  let currentBlock: number | null = null;
  for (const s of rows) {
    if (s.block_number !== currentBlock) {
      currentBlock = s.block_number;
      mdLines.push(`## Block ${currentBlock}`);
      mdLines.push("");
    }
    mdLines.push(`### ☐ ${s.scene_id} — ${s.target}`);
    mdLines.push("");
    mdLines.push(`**Method:** ${s.method}  `);
    mdLines.push(
      `**Raw duration:** ~${s.duration_hint_seconds ?? ""}s · **Narration:** ~${s.estimated_duration_seconds}s  `,
    );
    if (s.ip_risk === "high") mdLines.push("**⚠ IP risk: high** — trim clip to ≤5s in edit  ");
    mdLines.push("");
    mdLines.push(`> *Narration:* "${s.narration_text}"`);
    mdLines.push("");
    mdLines.push(`**Actions:** ${s.actions}`);
    mdLines.push("");
    mdLines.push(`**Highlights:** ${s.highlights}`);
    mdLines.push("");
    mdLines.push("---");
    mdLines.push("");
  }

  const batched: Record<string, ManualRow[]> = {};
  for (const s of rows) {
    if (!batched[s.target]) batched[s.target] = [];
    batched[s.target].push(s);
  }
  const batchedKeys = Object.keys(batched).sort();

  const bmdLines: string[] = [];
  bmdLines.push("# Shot List — Batched by Target");
  bmdLines.push("");
  bmdLines.push("Open each app/site once, record all its shots in a single session.");
  bmdLines.push("");

  for (const target of batchedKeys) {
    const shots = batched[target];
    bmdLines.push(`## ${target}  *(${shots.length} shot${shots.length > 1 ? "s" : ""})*`);
    bmdLines.push("");
    for (const s of shots) {
      bmdLines.push(`### ☐ Block ${s.block_number} / ${s.scene_id}`);
      bmdLines.push(`**Method:** ${s.method} · **Duration:** ~${s.duration_hint_seconds ?? ""}s`);
      bmdLines.push("");
      bmdLines.push(`> *Narration:* "${s.narration_text}"`);
      bmdLines.push("");
      bmdLines.push(`**Actions:** ${s.actions}`);
      bmdLines.push("");
      bmdLines.push(`**Highlights:** ${s.highlights}`);
      bmdLines.push("");
      bmdLines.push("---");
      bmdLines.push("");
    }
  }

  return { recordingOrder: mdLines.join("\n"), batchedByTarget: bmdLines.join("\n") };
}

export function buildShotListCsv(rows: ManualRow[]): string {
  const csvHeader = ["done", "block", "scene_id", "method", "target", "duration_s", "narration", "actions", "highlights", "ip_risk"];
  const csvRows = [csvHeader.join(",")];
  for (const s of rows) {
    csvRows.push(
      ["", s.block_number, s.scene_id, s.method, s.target, s.duration_hint_seconds ?? "", s.narration_text, s.actions, s.highlights, s.ip_risk]
        .map(csvEscape)
        .join(","),
    );
  }
  return csvRows.join("\n");
}

/** Escreve markdown + CSV em `05 - Modelagem/` do projeto. */
export async function writeShotListManualFiles(projectPath: string): Promise<{
  mdPath: string;
  csvPath: string;
  totalCaptures: number;
}> {
  const rows = await collectManualCaptureRows(projectPath);
  const modelagemDir = path.join(projectPath, "05 - Modelagem");
  await fs.mkdir(modelagemDir, { recursive: true });
  const mdPath = path.join(modelagemDir, "shot_list_manual.md");
  const csvPath = path.join(modelagemDir, "shot_list_manual.csv");
  const { recordingOrder, batchedByTarget } = buildShotListMarkdown(rows);
  const mdOut = `${recordingOrder}\n\n${batchedByTarget}\n`;
  await fs.writeFile(mdPath, mdOut, "utf-8");
  await fs.writeFile(csvPath, buildShotListCsv(rows), "utf-8");
  return { mdPath, csvPath, totalCaptures: rows.length };
}

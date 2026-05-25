import fs from "node:fs/promises";
import path from "node:path";
import { Step3Limits } from "../types/step3-limits.js";
import { assertWojakBlockPlan, isWojakCharacterVariant } from "./wojak-prompt.js";
import type { BlockScenesPlanV2, ScenePlanV2, SceneVisualPlanV2, SegmentationPlanV2 } from "../types/scenes-plan.js";
import {
  estimatedSpeechSecondsFromWordCount,
  validateSceneTextsCoverBlock,
  wordCountForCoverage,
} from "./text-coverage.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Remove cercas ```json e extrai o primeiro objeto `{...}` quando o modelo envolve texto extra. */
export function unwrapJsonFromModel(text: string): string {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```/im.exec(t);
  if (fenced) return fenced[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return t.slice(start, end + 1).trim();
  return t;
}

export type PlanParseErrorPayload = {
  at: string;
  stage: "segmentation" | "visualization";
  parse_error: string;
  raw_response: string;
  raw_response_length: number;
  unwrapped_for_json_parse: string;
  unwrapped_length: number;
  /** Segmentacao valida quando a falha e na visualizacao */
  segmentation_json?: SegmentationPlanV2;
};

/** Grava resposta bruta do Claude ao lado do plano (`block08.assets.json.error`) para debug sem repetir API. */
export async function writePlanParseError(
  assetsJsonPath: string,
  payload: Omit<PlanParseErrorPayload, "at" | "raw_response_length" | "unwrapped_length"> & {
    raw_response: string;
    unwrapped_for_json_parse: string;
  }
): Promise<string> {
  const errorPath = `${assetsJsonPath}.error`;
  await fs.mkdir(path.dirname(errorPath), { recursive: true });
  const doc: PlanParseErrorPayload = {
    at: new Date().toISOString(),
    stage: payload.stage,
    parse_error: payload.parse_error,
    raw_response: payload.raw_response,
    raw_response_length: payload.raw_response.length,
    unwrapped_for_json_parse: payload.unwrapped_for_json_parse,
    unwrapped_length: payload.unwrapped_for_json_parse.length,
    ...(payload.segmentation_json ? { segmentation_json: payload.segmentation_json } : {}),
  };
  await fs.writeFile(errorPath, JSON.stringify(doc, null, 2), "utf-8");
  return errorPath;
}

export async function clearPlanParseError(assetsJsonPath: string): Promise<void> {
  const errorPath = `${assetsJsonPath}.error`;
  const resolvedPath = `${assetsJsonPath}.error.resolved`;
  try {
    await fs.rename(errorPath, resolvedPath);
  } catch {
    /* ausente */
  }
}

export type VisualizationErrorResume = {
  stage: string;
  parse_error: string;
  raw_response: string;
  segmentation_json: SegmentationPlanV2;
};

/** Le `.assets.json.error` para reutilizar segmentacao + resposta de visualizacao (evita novo Claude). */
export async function loadVisualizationErrorResume(
  assetsJsonPath: string
): Promise<VisualizationErrorResume | null> {
  const errorPath = `${assetsJsonPath}.error`;
  try {
    const raw = await fs.readFile(errorPath, "utf-8");
    const doc = JSON.parse(raw) as PlanParseErrorPayload;
    if (doc.stage !== "visualization" || !doc.raw_response?.trim()) return null;
    if (!doc.segmentation_json?.scenes?.length) return null;
    return {
      stage: doc.stage,
      parse_error: doc.parse_error,
      raw_response: doc.raw_response,
      segmentation_json: doc.segmentation_json,
    };
  } catch {
    return null;
  }
}

export type ParseSegmentationOptions = {
  /** Maximo de cenas (normalmente max_images + max_videos do bloco). */
  maxScenes?: number;
};

export function parseSegmentationJson(
  raw: string,
  expectedBlockNumber: number,
  totalBlocks: number,
  blockText: string,
  opts?: ParseSegmentationOptions,
): SegmentationPlanV2 {
  let parsed: unknown;
  const unwrapped = unwrapJsonFromModel(raw);
  try {
    parsed = JSON.parse(unwrapped);
  } catch (e) {
    const detail = e instanceof SyntaxError ? e.message : String(e);
    throw new Error(`Segmentacao: resposta nao e JSON valido (${detail})`);
  }
  if (!isObject(parsed)) throw new Error("Segmentacao: raiz deve ser objeto");
  if (parsed.schema_version !== "2.0-segmentation") {
    throw new Error(`Segmentacao: schema_version esperado "2.0-segmentation", recebido ${String(parsed.schema_version)}`);
  }
  if (parsed.stage !== "segmentation") throw new Error('Segmentacao: stage deve ser "segmentation"');
  if (typeof parsed.block_number !== "number" || parsed.block_number !== expectedBlockNumber) {
    throw new Error(`Segmentacao: block_number esperado ${expectedBlockNumber}`);
  }
  if (typeof parsed.total_blocks !== "number" || parsed.total_blocks !== totalBlocks) {
    throw new Error(`Segmentacao: total_blocks esperado ${totalBlocks}`);
  }
  if (!Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
    throw new Error("Segmentacao: scenes vazio");
  }
  const scenes: SegmentationPlanV2["scenes"] = [];
  for (let i = 0; i < parsed.scenes.length; i += 1) {
    const s = parsed.scenes[i];
    if (!isObject(s)) throw new Error(`Segmentacao: cena ${i + 1} invalida`);
    if (typeof s.id !== "string" || !s.id.trim()) throw new Error(`Segmentacao: cena ${i + 1} sem id`);
    if (typeof s.narration_text !== "string") throw new Error(`Segmentacao: ${s.id} sem narration_text`);
    if (typeof s.narration_word_count !== "number" || s.narration_word_count < 0) {
      throw new Error(`Segmentacao: ${s.id} narration_word_count invalido`);
    }
    scenes.push({
      id: s.id.trim(),
      narration_text: s.narration_text,
      narration_word_count: wordCountForCoverage(s.narration_text),
    });
  }
  validateSceneTextsCoverBlock(blockText, scenes.map((x) => x.narration_text));
  const maxWordsPerScene = Math.max(
    40,
    parseInt(process.env.GENTUBE_MAX_WORDS_PER_SCENE ?? "120", 10) || 120,
  );
  for (const s of scenes) {
    if (s.narration_word_count > maxWordsPerScene) {
      throw new Error(
        `Segmentacao: ${s.id} tem ${s.narration_word_count} palavras (limite ${maxWordsPerScene}). ` +
          `Aumente max_images/max_videos (max_scenes) ou regenere a segmentacao.`,
      );
    }
  }
  if (opts?.maxScenes !== undefined && scenes.length > opts.maxScenes) {
    throw new Error(
      `Segmentacao: ${scenes.length} cenas excede o limite ${opts.maxScenes} para este bloco (ajuste max_images/max_videos ou regenere)`,
    );
  }
  return {
    schema_version: "2.0-segmentation",
    stage: "segmentation",
    block_number: expectedBlockNumber,
    total_blocks: totalBlocks,
    scenes,
  };
}

/** Ajusta type image/video para respeitar caps sem nova chamada ao Claude. */
export function enforceScenePlanCaps(
  scenes: ScenePlanV2[],
  blockNumber: number,
  limits: Step3Limits
): string[] {
  const maxVideos = blockNumber === 1 ? limits.maxVideosBlock1 : limits.maxVideosOtherBlocks;
  const maxImages = blockNumber === 1 ? limits.maxImagesBlock1 : limits.maxImagesOtherBlocks;
  const notes: string[] = [];

  const count = () => ({
    images: scenes.filter((s) => s.visual.type === "image").length,
    videos: scenes.filter((s) => s.visual.type === "video").length,
  });

  const isHook = (s: ScenePlanV2) => s.visual.role === "hook";

  let guard = 0;
  while (guard++ < 100) {
    const { images, videos } = count();
    if (images <= maxImages && videos <= maxVideos) return notes;

    if (images > maxImages && videos < maxVideos) {
      let idx = -1;
      for (let i = scenes.length - 1; i >= 0; i -= 1) {
        if (scenes[i].visual.type === "image" && !isHook(scenes[i])) {
          idx = i;
          break;
        }
      }
      if (idx < 0) break;
      scenes[idx].visual.type = "video";
      notes.push(`${scenes[idx].id}: image→video (cap ${images}/${maxImages} imagens)`);
      continue;
    }

    if (videos > maxVideos && images < maxImages) {
      let idx = -1;
      for (let i = scenes.length - 1; i >= 0; i -= 1) {
        if (scenes[i].visual.type === "video" && !isHook(scenes[i])) {
          idx = i;
          break;
        }
      }
      if (idx < 0) break;
      scenes[idx].visual.type = "image";
      notes.push(`${scenes[idx].id}: video→image (cap ${videos}/${maxVideos} videos)`);
      continue;
    }

    break;
  }

  const after = count();
  if (after.images > maxImages || after.videos > maxVideos) {
    throw new Error(
      `Plano v2: bloco ${blockNumber} excedeu caps apos ajuste (${after.images}/${maxImages} imagens, ${after.videos}/${maxVideos} videos)`
    );
  }
  return notes;
}

function assertVisual(v: unknown, sceneId: string): asserts v is SceneVisualPlanV2 {
  if (!isObject(v)) throw new Error(`Visual ${sceneId}: objeto ausente`);
  if (v.type !== "image" && v.type !== "video") throw new Error(`Visual ${sceneId}: type image|video`);
  if (v.source !== "ai_generated" && v.source !== "stock" && v.source !== "manual_capture") {
    throw new Error(`Visual ${sceneId}: source invalido`);
  }
  if (typeof v.role !== "string" || !v.role.trim()) throw new Error(`Visual ${sceneId}: role ausente`);
  if (typeof v.duration_seconds_max !== "number" || v.duration_seconds_max < 0) {
    throw new Error(`Visual ${sceneId}: duration_seconds_max invalido`);
  }
  if (typeof v.description !== "string" || !v.description.trim()) throw new Error(`Visual ${sceneId}: description ausente`);
  if (v.ip_risk !== "none" && v.ip_risk !== "low" && v.ip_risk !== "high") {
    throw new Error(`Visual ${sceneId}: ip_risk invalido`);
  }
  if (v.source === "stock") {
    if (typeof v.search_keywords !== "string" || !v.search_keywords.trim()) {
      throw new Error(`Visual ${sceneId}: search_keywords obrigatorio para stock`);
    }
  }
  if (v.character_variant !== undefined && v.character_variant !== null && v.character_variant !== "") {
    const cv = String(v.character_variant).trim().toLowerCase();
    if (!isWojakCharacterVariant(cv)) {
      throw new Error(
        `Visual ${sceneId}: character_variant invalido (${String(v.character_variant)}). Use neutral|happy|smiling|tired|doomer|frontal|impressed|pain`,
      );
    }
    (v as { character_variant: string }).character_variant = cv;
  }
  if (v.source === "manual_capture") {
    const brief = v.capture_brief;
    if (!isObject(brief)) throw new Error(`Visual ${sceneId}: capture_brief obrigatorio para manual_capture`);
    if (typeof brief.method !== "string" || !brief.method.trim()) throw new Error(`Visual ${sceneId}: capture_brief.method`);
    if (typeof brief.target !== "string" || !brief.target.trim()) throw new Error(`Visual ${sceneId}: capture_brief.target`);
    if (typeof brief.actions !== "string") throw new Error(`Visual ${sceneId}: capture_brief.actions`);
    if (typeof brief.highlights !== "string") throw new Error(`Visual ${sceneId}: capture_brief.highlights`);
  }
  // Normalizar duracao: o modelo por vezes excede caps; aplicar politica em vez de falhar o bloco inteiro
  let d = v.duration_seconds_max;
  if (v.type === "video") d = Math.min(d, 7);
  if (v.ip_risk === "high") d = Math.min(d, 5);
  (v as { duration_seconds_max: number }).duration_seconds_max = d;
}

export function parseVisualizationMerge(
  raw: string,
  segmentation: SegmentationPlanV2,
  blockText: string,
  limits?: Step3Limits,
): BlockScenesPlanV2 {
  let parsed: unknown;
  const unwrapped = unwrapJsonFromModel(raw);
  try {
    parsed = JSON.parse(unwrapped);
  } catch (e) {
    const detail = e instanceof SyntaxError ? e.message : String(e);
    throw new Error(`Visualizacao: resposta nao e JSON valido (${detail})`);
  }
  if (!isObject(parsed)) throw new Error("Visualizacao: raiz deve ser objeto");
  if (parsed.schema_version !== "2.0-visualization") {
    throw new Error(`Visualizacao: schema_version esperado "2.0-visualization", recebido ${String(parsed.schema_version)}`);
  }
  if (typeof parsed.block_number !== "number" || parsed.block_number !== segmentation.block_number) {
    throw new Error("Visualizacao: block_number inconsistente");
  }
  if (!Array.isArray(parsed.scenes) || parsed.scenes.length !== segmentation.scenes.length) {
    throw new Error("Visualizacao: numero de cenas deve igualar a segmentacao");
  }

  const scenes: ScenePlanV2[] = [];
  for (let i = 0; i < segmentation.scenes.length; i += 1) {
    const seg = segmentation.scenes[i];
    const row = parsed.scenes[i];
    if (!isObject(row)) throw new Error(`Visualizacao: cena ${i + 1} invalida`);
    if (row.id !== seg.id) throw new Error(`Visualizacao: ordem/id mismatch em ${seg.id}`);
    if (row.narration_text !== seg.narration_text) {
      throw new Error(`Visualizacao: narration_text nao pode alterar em ${seg.id}`);
    }
    assertVisual(row.visual, seg.id);
    const visual = row.visual as SceneVisualPlanV2;
    const estimated = estimatedSpeechSecondsFromWordCount(seg.narration_word_count);
    scenes.push({
      id: seg.id,
      narration_text: seg.narration_text,
      narration_word_count: seg.narration_word_count,
      estimated_duration_seconds: estimated,
      visual,
    });
  }

  validateSceneTextsCoverBlock(
    blockText,
    scenes.map((s) => s.narration_text),
  );

  if (limits) {
    enforceScenePlanCaps(scenes, segmentation.block_number, limits);
  }

  const plan: BlockScenesPlanV2 = {
    schema_version: "2.0",
    block_number: segmentation.block_number,
    total_blocks: segmentation.total_blocks,
    scenes,
  };
  assertWojakBlockPlan(plan);
  return plan;
}

/** Une duas metades de visualizacao (split por limite de tokens) num unico JSON bruto. */
export function mergeVisualizationRawHalves(rawA: string, rawB: string): string {
  const unwrap = (raw: string) => {
    const u = unwrapJsonFromModel(raw);
    return JSON.parse(u) as Record<string, unknown>;
  };
  const a = unwrap(rawA);
  const b = unwrap(rawB);
  const scenesA = Array.isArray(a.scenes) ? a.scenes : [];
  const scenesB = Array.isArray(b.scenes) ? b.scenes : [];
  const merged = {
    schema_version: a.schema_version ?? b.schema_version ?? "2.0-visualization",
    block_number: a.block_number ?? b.block_number,
    total_blocks: a.total_blocks ?? b.total_blocks,
    scenes: [...scenesA, ...scenesB],
  };
  return JSON.stringify(merged);
}

export function isBlockScenesPlanV2(raw: unknown): raw is BlockScenesPlanV2 {
  return (
    isObject(raw) &&
    raw.schema_version === "2.0" &&
    typeof raw.block_number === "number" &&
    typeof raw.total_blocks === "number" &&
    Array.isArray(raw.scenes)
  );
}

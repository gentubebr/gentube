import { BlockAssetsPlan, ShotPlan } from "../types/assets-plan.js";
import { Step3Limits } from "../types/step3-limits.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertShot(shot: unknown, index: number): asserts shot is ShotPlan {
  if (!isObject(shot)) throw new Error(`Shot ${index} invalido: esperado objeto`);
  if (typeof shot.id !== "string" || !shot.id.trim()) throw new Error(`Shot ${index} invalido: id ausente`);
  if (shot.type !== "image" && shot.type !== "video") throw new Error(`Shot ${index} invalido: type deve ser image|video`);
  if (typeof shot.role !== "string" || !shot.role.trim()) throw new Error(`Shot ${index} invalido: role ausente`);
  if (typeof shot.duration_seconds_max !== "number" || shot.duration_seconds_max < 0) {
    throw new Error(`Shot ${index} invalido: duration_seconds_max invalido`);
  }
  if (typeof shot.description !== "string" || !shot.description.trim()) throw new Error(`Shot ${index} invalido: description ausente`);
  if (typeof shot.aligns_with_excerpt !== "string" || !shot.aligns_with_excerpt.trim()) {
    throw new Error(`Shot ${index} invalido: aligns_with_excerpt ausente`);
  }
  if (shot.ip_risk !== "none" && shot.ip_risk !== "low" && shot.ip_risk !== "high") {
    throw new Error(`Shot ${index} invalido: ip_risk deve ser none|low|high`);
  }
  if (shot.source !== "ai_generated" && shot.source !== "stock") {
    throw new Error(`Shot ${index} invalido: source deve ser ai_generated|stock`);
  }
  if (shot.source === "stock") {
    if (typeof shot.search_keywords !== "string" || !shot.search_keywords.trim()) {
      throw new Error(`Shot ${index} invalido: search_keywords obrigatorio quando source=stock`);
    }
  }
  if (shot.type === "video" && shot.duration_seconds_max > 7) {
    throw new Error(`Shot ${index} invalido: video nao pode passar de 7s`);
  }
  if (shot.ip_risk === "high" && shot.duration_seconds_max > 5) {
    throw new Error(`Shot ${index} invalido: com ip_risk high, maximo 5s`);
  }
}

export function parseAndValidateAssetsPlan(raw: string, expectedBlockNumber: number, limits?: Step3Limits): BlockAssetsPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Resposta da direcao nao e JSON valido");
  }
  if (!isObject(parsed)) throw new Error("Plano invalido: raiz deve ser objeto");
  if (typeof parsed.schema_version !== "string" || !parsed.schema_version.trim()) {
    throw new Error("Plano invalido: schema_version ausente");
  }
  if (typeof parsed.block_number !== "number") throw new Error("Plano invalido: block_number ausente");
  if (parsed.block_number !== expectedBlockNumber) {
    throw new Error(`Plano invalido: block_number esperado ${expectedBlockNumber}, recebido ${parsed.block_number}`);
  }
  if (!Array.isArray(parsed.shots) || parsed.shots.length === 0) throw new Error("Plano invalido: shots vazio");
  parsed.shots.forEach((shot, idx) => assertShot(shot, idx + 1));
  const plan = parsed as BlockAssetsPlan;

  if (limits) {
    const videos = plan.shots.filter((s) => s.type === "video").length;
    const images = plan.shots.filter((s) => s.type === "image").length;
    const isBlock1 = expectedBlockNumber === 1;
    const maxVideos = isBlock1 ? limits.maxVideosBlock1 : limits.maxVideosOtherBlocks;
    const maxImages = isBlock1 ? limits.maxImagesBlock1 : limits.maxImagesOtherBlocks;

    if (videos > maxVideos) {
      throw new Error(`Plano invalido: bloco ${expectedBlockNumber} excedeu maximo de videos (${videos}/${maxVideos})`);
    }
    if (images > maxImages) {
      throw new Error(`Plano invalido: bloco ${expectedBlockNumber} excedeu maximo de imagens (${images}/${maxImages})`);
    }
  }

  return plan;
}

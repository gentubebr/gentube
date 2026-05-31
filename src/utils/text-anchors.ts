import { normalizeForCoverage } from "./text-coverage.js";

export type AnchorSpan = {
  starts_with: string;
  ends_with: string;
};

/** Localiza substring verbatim em `haystack`; opcionalmente com normalizacao de cobertura. */
export function findSubstringIndex(haystack: string, needle: string, normalized = false): number {
  if (!needle) return -1;
  if (!normalized) return haystack.indexOf(needle);
  const h = normalizeForCoverage(haystack);
  const n = normalizeForCoverage(needle);
  return h.indexOf(n);
}

/** Indice do fim (exclusivo) de `needle` em `haystack`. */
export function findSubstringEndIndex(haystack: string, needle: string, normalized = false): number {
  const start = findSubstringIndex(haystack, needle, normalized);
  if (start < 0) return -1;
  const len = normalized ? normalizeForCoverage(needle).length : needle.length;
  return start + len;
}

/** Extrai texto entre ancoras; verbatim primeiro, fallback normalizado (aspas/markdown). */
export function extractSpanFromAnchors(blockText: string, span: AnchorSpan): string {
  const trimmedStart = span.starts_with.trim();
  const trimmedEnd = span.ends_with.trim();
  if (!trimmedStart || !trimmedEnd) throw new Error("ancora vazia");

  const verbatimStart = blockText.indexOf(trimmedStart);
  if (verbatimStart >= 0) {
    const verbatimEndRel = blockText.indexOf(trimmedEnd, verbatimStart);
    if (verbatimEndRel >= 0) {
      const endExclusive = verbatimEndRel + trimmedEnd.length;
      if (endExclusive > verbatimStart) return blockText.slice(verbatimStart, endExclusive);
    }
  }

  const blockNorm = normalizeForCoverage(blockText);
  const sw = normalizeForCoverage(trimmedStart);
  const ew = normalizeForCoverage(trimmedEnd);
  const normStart = blockNorm.indexOf(sw);
  const normEndRel = normStart >= 0 ? blockNorm.indexOf(ew, normStart) : -1;
  if (normStart < 0 || normEndRel < 0) {
    throw new Error("ancoras nao encontradas no bloco");
  }
  const normEnd = normEndRel + ew.length;
  if (normEnd <= normStart) throw new Error("ends_with deve terminar apos starts_with");
  return blockNorm.slice(normStart, normEnd);
}

function findNormSpan(
  blockNorm: string,
  sw: string,
  ew: string,
  fromIndex: number,
): { start: number; end: number } | null {
  const normStart = blockNorm.indexOf(sw, fromIndex);
  if (normStart < 0) return null;
  const normEndRel = blockNorm.indexOf(ew, normStart);
  if (normEndRel < 0) return null;
  const end = normEndRel + ew.length;
  if (end <= normStart) return null;
  return { start: normStart, end };
}

/** Extrai cenas em ordem; fallback: cursor ate inicio da cena seguinte se ends_with falhar. */
export function extractScenesFromAnchorSegmentation(
  blockText: string,
  scenes: AnchorSpan[],
): Array<{ narration_text: string }> {
  const blockNorm = normalizeForCoverage(blockText);
  let cursor = 0;
  const out: Array<{ narration_text: string }> = [];

  for (let i = 0; i < scenes.length; i += 1) {
    const scene = scenes[i]!;
    const trimmedStart = scene.starts_with.trim();
    const trimmedEnd = scene.ends_with.trim();
    if (!trimmedStart || !trimmedEnd) throw new Error("ancora vazia");
    const sw = normalizeForCoverage(trimmedStart);
    const ew = normalizeForCoverage(trimmedEnd);
    const next = scenes[i + 1];
    const nextSw = next ? normalizeForCoverage(next.starts_with.trim()) : "";
    const nextStart = nextSw ? blockNorm.indexOf(nextSw, cursor + 1) : blockNorm.length;

    let span = findNormSpan(blockNorm, sw, ew, cursor);
    if (!span) {
      const boundary = nextStart >= 0 ? nextStart : blockNorm.length;
      if (boundary > cursor) {
        out.push({ narration_text: blockNorm.slice(cursor, boundary) });
        cursor = boundary;
        continue;
      }
      throw new Error(`ancoras nao encontradas no bloco (apos pos ${cursor})`);
    }
    // Se ends_with cair muito a frente e engolir a proxima cena, limita no inicio da proxima.
    const clampedEnd =
      nextStart > span.start && nextStart >= 0 && span.end > nextStart ? nextStart : span.end;
    // Mantem cobertura contigua do bloco: inclui eventual "lacuna" entre cenas.
    out.push({ narration_text: blockNorm.slice(cursor, clampedEnd) });
    cursor = clampedEnd;
  }

  return out;
}

/** Indice de caractere de `needle` dentro de `sceneText` (para alignment). */
export function findCharRangeInSceneText(
  sceneText: string,
  startsWith: string,
  endsWith: string,
): { startIndex: number; endIndex: number } | null {
  const startNeedle = startsWith.trim();
  const endNeedle = endsWith.trim();
  let startIndex = sceneText.indexOf(startNeedle);
  if (startIndex >= 0) {
    const endRel = sceneText.indexOf(endNeedle, startIndex);
    if (endRel >= 0) return { startIndex, endIndex: endRel + endNeedle.length - 1 };
  }
  const norm = normalizeForCoverage(sceneText);
  const sw = normalizeForCoverage(startNeedle);
  const ew = normalizeForCoverage(endNeedle);
  startIndex = norm.indexOf(sw);
  if (startIndex < 0) return null;
  const endRel = norm.indexOf(ew, startIndex);
  if (endRel < 0) return null;
  return { startIndex, endIndex: endRel + ew.length - 1 };
}

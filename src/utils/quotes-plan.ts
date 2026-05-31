import type { BlockQuote, BlockQuotesPlan } from "../types/quotes-plan.js";
import { findSubstringIndex } from "./text-anchors.js";
import { normalizeForCoverage } from "./text-coverage.js";
import chalk from "chalk";

function anchorMatchesBlock(blockText: string, anchor: string): boolean {
  if (!anchor.trim()) return false;
  if (findSubstringIndex(blockText, anchor, false) >= 0) return true;
  return findSubstringIndex(blockText, anchor, true) >= 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const VALID_TYPES = new Set(["biblical", "philosophical", "impact_phrase", "rhetorical_question"]);
const VALID_STYLES = new Set(["quote_card", "impact", "attribution"]);

export function parseBlockQuotesJson(
  raw: string,
  expectedBlockNumber: number,
  totalBlocks: number,
  blockText: string,
): BlockQuotesPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const detail = e instanceof SyntaxError ? e.message : String(e);
    throw new Error(`Quotizador: JSON invalido (${detail})`);
  }
  if (!isObject(parsed)) throw new Error("Quotizador: raiz deve ser objeto");
  if (parsed.schema_version !== "1.0-quotes") {
    throw new Error(`Quotizador: schema_version esperado "1.0-quotes"`);
  }
  if (parsed.stage !== "quotizador") throw new Error('Quotizador: stage deve ser "quotizador"');
  if (parsed.block_number !== expectedBlockNumber) {
    throw new Error(`Quotizador: block_number esperado ${expectedBlockNumber}`);
  }
  if (parsed.total_blocks !== totalBlocks) {
    throw new Error(`Quotizador: total_blocks esperado ${totalBlocks}`);
  }
  if (!Array.isArray(parsed.quotes)) throw new Error("Quotizador: quotes deve ser array");

  const quotes: BlockQuote[] = [];
  for (let i = 0; i < parsed.quotes.length; i += 1) {
    const q = parsed.quotes[i];
    if (!isObject(q)) throw new Error(`Quotizador: quote ${i + 1} invalida`);
    const id = typeof q.id === "string" ? q.id.trim() : "";
    const type = typeof q.type === "string" ? q.type.trim() : "";
    const starts_with = typeof q.starts_with === "string" ? q.starts_with : "";
    const ends_with = typeof q.ends_with === "string" ? q.ends_with : "";
    const overlay_style = typeof q.overlay_style === "string" ? q.overlay_style.trim() : "";
    if (!id) throw new Error(`Quotizador: quote ${i + 1} sem id`);
    if (!VALID_TYPES.has(type)) throw new Error(`Quotizador: ${id} type invalido`);
    if (!VALID_STYLES.has(overlay_style)) throw new Error(`Quotizador: ${id} overlay_style invalido`);
    if (!anchorMatchesBlock(blockText, starts_with)) {
      console.warn(chalk.yellow(`[quotizador] ${id}: starts_with ignorado (nao encontrado no bloco)`));
      continue;
    }
    if (!anchorMatchesBlock(blockText, ends_with)) {
      console.warn(chalk.yellow(`[quotizador] ${id}: ends_with ignorado (nao encontrado no bloco)`));
      continue;
    }
    const reference = typeof q.reference === "string" ? q.reference.trim() : undefined;
    quotes.push({
      id,
      type: type as BlockQuote["type"],
      starts_with,
      ends_with,
      overlay_style: overlay_style as BlockQuote["overlay_style"],
      ...(reference ? { reference } : {}),
    });
  }
  const deduped = filterQuotesNoOverlap(blockText, quotes);
  return {
    schema_version: "1.0-quotes",
    stage: "quotizador",
    block_number: expectedBlockNumber,
    total_blocks: totalBlocks,
    quotes: deduped,
  };
}

function quoteSpanIndices(blockText: string, q: BlockQuote): { start: number; end: number } {
  let start = blockText.indexOf(q.starts_with);
  let endRel = start >= 0 ? blockText.indexOf(q.ends_with, start) : -1;
  if (start >= 0 && endRel >= 0) {
    return { start, end: endRel + q.ends_with.length };
  }
  const norm = normalizeForCoverage(blockText);
  const sw = normalizeForCoverage(q.starts_with);
  const ew = normalizeForCoverage(q.ends_with);
  start = norm.indexOf(sw);
  endRel = start >= 0 ? norm.indexOf(ew, start) : -1;
  if (start < 0 || endRel < 0) return { start: -1, end: -1 };
  return { start, end: endRel + ew.length };
}

/** Remove quotes com overlap de texto (mantém a anterior; não aborta o bloco). */
function filterQuotesNoOverlap(blockText: string, quotes: BlockQuote[]): BlockQuote[] {
  const byId = new Map(quotes.map((q) => [q.id, q]));
  const spans = quotes.map((q) => ({ id: q.id, ...quoteSpanIndices(blockText, q) }));
  const validSpans = spans.filter((s) => {
    if (s.start >= 0) return true;
    console.warn(chalk.yellow(`[quotizador] ${s.id}: overlap check ignorado (âncoras)`));
    return false;
  });
  validSpans.sort((a, b) => a.start - b.start);
  const kept: BlockQuote[] = [];
  let lastEnd = -1;
  for (const s of validSpans) {
    const q = byId.get(s.id);
    if (!q) continue;
    if (kept.length > 0 && s.start < lastEnd) {
      console.warn(
        chalk.yellow(`[quotizador] ${s.id}: ignorado (overlap com citação anterior)`),
      );
      continue;
    }
    kept.push(q);
    lastEnd = s.end;
  }
  return kept;
}

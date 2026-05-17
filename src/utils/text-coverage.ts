/**
 * Normalização partilhada para comparar texto do bloco com concatenação das narrações das cenas.
 */

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

export function normalizeForCoverage(raw: string): string {
  return raw
    .replace(/\uFEFF/g, "")
    .replace(ZERO_WIDTH, "")
    .normalize("NFC")
    // Aspas/apóstrofos tipográficos → ASCII (evita falha de cobertura quando o modelo copia ' mas o bloco tem ')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Contagem de palavras alinhada à validação de cobertura (após normalização de espaços). */
export function wordCountForCoverage(text: string): number {
  const t = normalizeForCoverage(text);
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

export function validateSceneTextsCoverBlock(blockText: string, narrationTexts: string[]): void {
  const original = normalizeForCoverage(blockText);
  const reconstructed = normalizeForCoverage(narrationTexts.join(" "));
  if (original !== reconstructed) {
    const prefixLen = 80;
    throw new Error(
      `Cobertura de texto falhou: texto normalizado do bloco !== concatenacao das cenas.\n` +
        `Bloco (inicio): ${original.slice(0, prefixLen)}...\n` +
        `Reconstruido (inicio): ${reconstructed.slice(0, prefixLen)}...`
    );
  }
}

/** ~150 wpm → 2.5 palavras/s */
export function estimatedSpeechSecondsFromWordCount(words: number): number {
  return Math.round((words / 2.5) * 10) / 10;
}

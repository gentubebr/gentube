/**
 * Normalização partilhada para comparar texto do bloco com concatenação das narrações das cenas.
 */

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

export function normalizeForCoverage(raw: string): string {
  return raw
    .replace(/\uFEFF/g, "")
    .replace(ZERO_WIDTH, "")
    // Separadores Markdown no roteiro (---) nao entram na narracao por cena
    .replace(/^\s*---\s*$/gm, " ")
    // Rotulos de versiculo/citacao (faixa 13:14–15 usa travessao sem espacos; atribuicao usa " — ")
    .replace(
      /(?:\*\*)?(?:Genesis|Psalm|Romans|John|Matthew|Mark|Luke|Acts|Hebrews|Proverbs|Ecclesiastes)\s+\d+:\d+(?:[—–]\d+)?\s+[—–]\s+/gi,
      "",
    )
    // Rotulos em negrito com versiculo/indice antes do travessao (**Provérbios 14:1 —** / **Virtue 1 —**)
    // Evita remover texto narrativo comum em negrito (ex.: "**perceives —**").
    .replace(/\*\*[^*\n]{0,80}(?::|\d)[^*\n]{0,80}\*\*\s+[—–]\s+/g, "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/__/g, "")
    .normalize("NFC")
    // Aspas/apóstrofos tipográficos → ASCII (evita falha de cobertura quando o modelo copia ' mas o bloco tem ')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    // Aspas duplas nao sao relevantes para cobertura verbatim (modelo pode abrir/fechar quotes em cortes diferentes)
    .replace(/"/g, "")
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

/**
 * Quando o modelo trunca o fim do bloco, o texto reconstruido e prefixo do roteiro normalizado.
 * Anexa o sufixo em falta na ultima cena (evita nova chamada de segmentacao).
 */
export function repairSegmentationCoverageTail<T extends { narration_text: string }>(
  blockText: string,
  scenes: T[],
): T[] {
  if (scenes.length === 0) return scenes;
  const blockNorm = normalizeForCoverage(blockText);
  const joinedNorm = normalizeForCoverage(scenes.map((s) => s.narration_text).join(" "));
  if (blockNorm === joinedNorm) return scenes;
  if (!blockNorm.startsWith(joinedNorm)) return scenes;
  const suffix = blockNorm.slice(joinedNorm.length).trim();
  if (!suffix) return scenes;
  const last = scenes[scenes.length - 1];
  const patchedText = `${last.narration_text.trimEnd()} ${suffix}`.trim();
  return [
    ...scenes.slice(0, -1),
    { ...last, narration_text: patchedText },
  ];
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

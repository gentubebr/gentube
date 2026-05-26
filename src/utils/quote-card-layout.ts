/** Versao do layout — invalida cache de quote quando tipografia muda. */
export const QUOTE_CARD_LAYOUT_VERSION = "4";

const FRAME_HEIGHT = 1080;
const FRAME_WIDTH = 1920;
const ROOT_PAD_V = 80;
const ROOT_PAD_H = 120;
const QUOTE_MAX_WIDTH = FRAME_WIDTH - ROOT_PAD_H * 2;
const ATTR_GAP = 36;

const QUOTE_FONT_CANDIDATES_PX = [48, 44, 40, 36, 32, 28, 26, 24, 22] as const;

/** Altura util para citacao + atribuicao (px). */
export function quoteTextAreaMaxHeightPx(hasAttribution: boolean): number {
  const attrReserve = hasAttribution ? 90 : 0;
  return FRAME_HEIGHT - ROOT_PAD_V * 2 - attrReserve - ATTR_GAP;
}

/**
 * Estimativa conservadora de linhas (~chars por linha cai com fonte maior).
 */
function estimatedLines(charCount: number, fontPx: number): number {
  const charsPerLine = Math.max(28, Math.floor(QUOTE_MAX_WIDTH / (fontPx * 0.52)));
  return Math.ceil(charCount / charsPerLine);
}

/**
 * Tamanho da fonte da citacao conforme comprimento (evita truncar em 1920x1080).
 */
export function resolveQuoteFontSizePx(quoteText: string, hasAttribution: boolean): number {
  const len = quoteText.trim().length;
  const maxH = quoteTextAreaMaxHeightPx(hasAttribution);
  const lineHeight = 1.32;

  for (const px of QUOTE_FONT_CANDIDATES_PX) {
    const lines = estimatedLines(len, px);
    const quoteH = lines * px * lineHeight;
    const attrH = hasAttribution ? Math.max(22, Math.round(px * 0.5)) * 1.35 : 0;
    if (quoteH + attrH <= maxH) return px;
  }
  return 22;
}

export function resolveQuoteAttributionFontSizePx(quoteFontPx: number): number {
  return Math.max(22, Math.round(quoteFontPx * 0.5));
}

export function pickAssQuoteFontSizePx(quoteText: string, hasAttribution: boolean): number {
  return resolveQuoteFontSizePx(quoteText, hasAttribution);
}

/** Duracao minima para typing terminar + pausa no fim (segundos). */
export function resolveQuoteCardDurationSeconds(quoteText: string, requested: number): number {
  const len = quoteText.trim().length;
  const typingSec = Math.max(3.5, (len * 0.042) / 1.4 + 1.5);
  const holdSec = 2;
  const fromText = Math.ceil(typingSec + holdSec);
  const req = Number.isFinite(requested) && requested > 0 ? requested : 6;
  return Math.max(6, Math.min(30, Math.max(req, fromText)));
}

/**
 * Remove artefatos comuns da LLM no texto do bloco: cabeçalho "# Block N" e
 * perguntas meta de continuação (herdadas do prompt interativo do matriz.md).
 */
export function sanitizeScriptBlockContent(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").trimEnd().split("\n");

  while (lines.length && lines[0]!.trim() === "") {
    lines.shift();
  }

  if (lines.length) {
    const first = lines[0]!.trim();
    if (/^#{1,6}\s*(block|bloco)\s*\d+/i.test(first)) {
      lines.shift();
      while (lines.length && lines[0]!.trim() === "") {
        lines.shift();
      }
    }
  }

  const isJunkLine = (line: string): boolean => {
    const t = line.trim();
    if (!t) return false;
    const lower = t.toLowerCase();
    if (/\*\*/.test(t) && /continu/.test(lower) && /\?/.test(t)) return true;
    if (/continu(ar|e|ar para)/.test(lower) && /\?/.test(t)) return true;
    if (/pr[oó]xim[oa]?\s+bloco/.test(lower)) return true;
    if (/^(digite|type)\s+["']?ok["']?/i.test(t)) return true;
    if (/want\s+to\s+continue/i.test(t)) return true;
    if (/^#{1,6}\s*(block|bloco)\s*\d+/i.test(t)) return true;
    if (/^respond(a|er)?\s+com\s+/i.test(lower)) return true;
    return false;
  };

  while (lines.length && isJunkLine(lines[lines.length - 1]!)) {
    lines.pop();
  }
  while (lines.length && lines[lines.length - 1]!.trim() === "") {
    lines.pop();
  }

  return lines.join("\n").trim();
}

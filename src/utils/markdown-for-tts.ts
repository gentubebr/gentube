/**
 * Converte texto com Markdown leve (roteiro / narration_text) em texto adequado a TTS:
 * remove **negrito**, _itálico_, links, cercas de código, marcadores de lista, etc.
 */
export function stripMarkdownForSpeech(raw: string): string {
  let s = raw.replace(/\r\n/g, "\n").trim();
  if (!s) return "";

  // Blocos de código: omitir conteúdo (evita ler backticks e código)
  s = s.replace(/```[\s\S]*?```/g, " ");

  // Imagem ![alt](url) → alt
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Link [texto](url) → texto
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Código inline `assim`
  s = s.replace(/`([^`]+)`/g, "$1");

  // Negrito ** ... ** e __ ... __ (várias passagens por aninhamento raro)
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
    s = s.replace(/__([^_]+)__/g, "$1");
  }

  // Itálico com um asterisco/piso (linha a linha para não confundir com lista)
  const lines = s.split("\n");
  const normalizedLines = lines.map((line) => {
    const L = line.trimEnd();
    const trimmedStart = L.trimStart();
    const indent = L.slice(0, L.length - trimmedStart.length);

    // Listas: "- item", "* item", "+ item", "1. item"
    let body = trimmedStart.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "");

    // Cabeçalhos markdown no início da linha
    body = body.replace(/^#{1,6}\s+/, "");

    // Itálico *palavra* (evita linhas que são só bullet "* ")
    let b = body;
    let bp = "";
    while (bp !== b) {
      bp = b;
      b = b.replace(/\*([^*\n]+)\*/g, "$1");
      b = b.replace(/\b_([^_\n]+)_\b/g, "$1");
    }
    body = b;

    // Asteriscos órfãos (ex.: modelo fechou mal **)
    body = body.replace(/\*\*/g, "").replace(/\*/g, "");

    return (indent + body).trimEnd();
  });

  s = normalizedLines.join("\n");

  // Riscado ~~texto~~
  s = s.replace(/~~([^~]+)~~/g, "$1");

  // Normaliza espaços / quebras para uma leitura contínua (TTS)
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{2,}/g, ". ");
  s = s.replace(/\n/g, " ");
  s = s.replace(/\s{2,}/g, " ").trim();

  return s;
}

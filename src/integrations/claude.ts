import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_API_KEY } from "../config.js";
import { sanitizeScriptBlockContent } from "../utils/sanitize-script-block.js";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!CLAUDE_API_KEY) {
    throw new Error("CLAUDE_API_KEY nao configurada no .env");
  }
  if (!client) {
    client = new Anthropic({ apiKey: CLAUDE_API_KEY });
  }
  return client;
}

export async function generateScriptBlock(input: {
  promptBase: string;
  title: string;
  niche: string;
  audience: string;
  transcript?: string;
  blockNumber: number;
  totalBlocks: number;
}): Promise<string> {
  const anthropic = getClient();

  const formattedPrompt = input.promptBase
    .replaceAll("[NOME DO NICHO]", input.niche)
    .replaceAll("[PUBLICO]", input.audience);

  const referenceBlock = input.transcript
    ? `
REFERENCIA (video ou transcricao similar — use apenas estrutura, ritmo e mensagens-chave; NAO copie frases nem paragrafos; utilize-o como modelagem apenas; caso seja necessario, reescreva com voz, tom e estilo original do roteiro):
---
${input.transcript}
---
`.trim()
    : "";

  const formatRules = `
FORMATO OBRIGATORIO DA RESPOSTA (o pipeline e automatico; nao simule chat):
- Entregue SOMENTE o texto narrado deste bloco (o que sera lido em voz alta).
- NAO escreva cabecalhos de bloco como "# Block 1", "## Bloco 2", etc.
- NAO faca perguntas ao usuario, pedidos de "ok", "digite ok", nem convites para continuar o roteiro.
- NAO inclua notas ao roteirista ou meta-dialogo; nenhuma linha final perguntando se deseja o proximo bloco.
- Markdown leve no corpo e permitido (negrito, listas) quando fizer sentido na narracao.
`.trim();

  const userPrompt = `
${formattedPrompt}

Titulo do video: ${input.title}
Quantidade total de blocos: ${input.totalBlocks}
Gere apenas o bloco ${input.blockNumber} de ${input.totalBlocks}.

${formatRules}
${referenceBlock ? `${referenceBlock}` : ""}
`.trim();

  const response = await anthropic.messages.create({
    model: "claude-opus-4-1-20250805",
    max_tokens: 4096,
    temperature: 0.7,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textChunks = response.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (!textChunks) {
    throw new Error(`Claude retornou conteudo vazio para bloco ${input.blockNumber}`);
  }

  const cleaned = sanitizeScriptBlockContent(textChunks);
  if (!cleaned) {
    throw new Error(`Apos limpeza, o bloco ${input.blockNumber} ficou vazio; ajuste o prompt ou regenere`);
  }

  return cleaned;
}

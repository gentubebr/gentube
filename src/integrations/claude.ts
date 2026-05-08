import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_API_KEY } from "../config.js";

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

  const userPrompt = `
${formattedPrompt}

Titulo do video: ${input.title}
Quantidade total de blocos: ${input.totalBlocks}
Gere apenas o bloco ${input.blockNumber} de ${input.totalBlocks}.
Retorne apenas o texto do bloco em markdown, sem explicacoes extras.
${input.transcript ? `Transcricao de referencia:\n${input.transcript}` : ""}
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

  return textChunks;
}

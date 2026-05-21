import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import {
  CLAUDE_API_KEY,
  CLAUDE_MODEL,
  CLAUDE_MAX_TOKENS,
  CLAUDE_THINKING,
} from "../config.js";
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

/** Chamadas que exigem JSON no corpo: effort baixo evita thinking esgotar max_tokens (Opus 4.7). */
function applyStructuredJsonCallParams(
  createParams: MessageCreateParamsNonStreaming & {
    thinking?: { type: "adaptive" };
    output_config?: { effort: "low" };
    temperature?: number;
  }
): void {
  if (CLAUDE_THINKING === "adaptive") {
    createParams.thinking = { type: "adaptive" };
    createParams.output_config = { effort: "low" };
  } else {
    createParams.temperature = 0.35;
  }
}

export async function generateScriptBlock(input: {
  promptBase: string;
  title: string;
  niche: string;
  audience: string;
  transcript?: string;
  /** Voz/persona do canal — tipicamente bloco 1; opcional. */
  channelVoiceContext?: string;
  /** Texto dos blocos anteriores (1..N-1) para continuidade; opcional. */
  previousBlocksText?: string;
  blockNumber: number;
  totalBlocks: number;
}): Promise<string> {
  const anthropic = getClient();

  const formattedPrompt = input.promptBase
    .replaceAll("[NOME DO NICHO]", input.niche)
    .replaceAll("[PUBLICO]", input.audience)
    .replace(/dividido em \d+ blocos/i, `dividido em ${input.totalBlocks} blocos`);

  const channelVoiceSection = input.channelVoiceContext?.trim()
    ? `
VOZ E PERSONA DO CANAL (aplique em todo este bloco; alinha tom e promessa com a matriz acima — nao contradizer regras de formato nem idioma do roteiro):
---
${input.channelVoiceContext.trim()}
---
`.trim()
    : "";

  const referenceBlock = input.transcript
    ? `
REFERENCIA (video ou transcricao similar — use apenas estrutura, ritmo e mensagens-chave; NAO copie frases nem paragrafos; utilize-o como modelagem apenas; caso seja necessario, reescreva com voz, tom e estilo original do roteiro):
---
${input.transcript}
---
`.trim()
    : "";

  const previousBlocksSection = input.previousBlocksText?.trim()
    ? `
ROTEIRO JA GERADO (blocos anteriores — use apenas para manter coerencia de tom, referencias e continuidade logica; NAO repetir nem parafrasear longamente o que ja foi dito; nao voltar ao hook inicial; produza somente o material novo do bloco ${input.blockNumber}):
---
${input.previousBlocksText.trim()}
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

${channelVoiceSection ? `${channelVoiceSection}\n\n` : ""}Titulo do video: ${input.title}
Quantidade total de blocos: ${input.totalBlocks}
Gere apenas o bloco ${input.blockNumber} de ${input.totalBlocks}.

${formatRules}
${previousBlocksSection ? `${previousBlocksSection}\n\n` : ""}${referenceBlock ? `${referenceBlock}` : ""}
`.trim();

  const createParams: MessageCreateParamsNonStreaming = {
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    messages: [{ role: "user" as const, content: userPrompt }],
  };

  if (CLAUDE_THINKING === "adaptive") {
    (createParams as MessageCreateParamsNonStreaming & { thinking: unknown }).thinking = { type: "adaptive" };
  } else {
    createParams.temperature = 0.7;
  }

  const response = await anthropic.messages.create(createParams);

  const textChunks = response.content
    .filter((part: { type: string }) => part.type === "text")
    .map((part) => ("text" in part ? part.text : ""))
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

export async function generateAssetsPlanJson(input: {
  promptBase: string;
  blockNumber: number;
  totalBlocks: number;
  scriptText: string;
  audience: string;
  avatarPath?: string;
  maxVideos: number;
  maxImages: number;
  stockRatio: number;
}): Promise<string> {
  const anthropic = getClient();

  const userPrompt = `
${input.promptBase}

Context:
- block_number: ${input.blockNumber}
- total_blocks: ${input.totalBlocks}
- audience: ${input.audience}
- avatar_reference_optional: ${input.avatarPath ? input.avatarPath : "none"}
- max_videos_for_this_block: ${input.maxVideos}
- max_images_for_this_block: ${input.maxImages}
- stock_ratio: ${input.stockRatio} (target % of shots that should have source "stock"; remaining should be "ai_generated")

Script block to analyze:
---
${input.scriptText}
---

Return ONLY JSON for this block, following the schema in the prompt.
Do not exceed max_videos_for_this_block and max_images_for_this_block.
Respect the stock_ratio for source distribution.
`.trim();

  const createParams: MessageCreateParamsNonStreaming = {
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    messages: [{ role: "user" as const, content: userPrompt }],
  };

  if (CLAUDE_THINKING === "adaptive") {
    (createParams as MessageCreateParamsNonStreaming & { thinking: unknown }).thinking = { type: "adaptive" };
  } else {
    createParams.temperature = 0.4;
  }

  const response = await anthropic.messages.create(createParams);

  const text = response.content
    .filter((part: { type: string }) => part.type === "text")
    .map((part) => ("text" in part ? part.text : ""))
    .join("\n")
    .trim();

  if (!text) {
    throw new Error(`Claude retornou plano vazio para bloco ${input.blockNumber}`);
  }
  return text;
}

export async function generateSegmentationPlanJson(input: {
  promptBase: string;
  blockNumber: number;
  totalBlocks: number;
  blockText: string;
  maxScenes: number;
}): Promise<string> {
  const anthropic = getClient();
  const userPrompt = `
${input.promptBase}

Context:
- block_number: ${input.blockNumber}
- total_blocks: ${input.totalBlocks}
- max_scenes_for_this_block: ${input.maxScenes}
- block_text:
---
${input.blockText}
---

Return ONLY JSON following segmenta01 schema (schema_version "2.0-segmentation", stage "segmentation").
`.trim();

  const createParams: MessageCreateParamsNonStreaming & {
    thinking?: { type: "adaptive" };
    output_config?: { effort: "low" };
    temperature?: number;
  } = {
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    messages: [{ role: "user" as const, content: userPrompt }],
  };
  applyStructuredJsonCallParams(createParams);

  const response = await anthropic.messages.create(createParams);
  const textOut = response.content
    .filter((part: { type: string }) => part.type === "text")
    .map((part) => ("text" in part ? part.text : ""))
    .join("\n")
    .trim();

  if (!textOut) {
    const reason = "stop_reason" in response ? String(response.stop_reason) : "unknown";
    throw new Error(
      `Claude retornou segmentacao vazia para bloco ${input.blockNumber} (stop_reason=${reason})`
    );
  }
  return textOut;
}

export async function generateVisualizationPlanJson(input: {
  promptBase: string;
  blockNumber: number;
  totalBlocks: number;
  audience: string;
  stockRatio: number;
  manualCaptureSignals: string[];
  segmentationJson: string;
  maxVideos: number;
  maxImages: number;
  visualModality?: "default" | "wojak";
}): Promise<string> {
  const anthropic = getClient();
  const signals =
    input.manualCaptureSignals.length > 0
      ? JSON.stringify(input.manualCaptureSignals)
      : "[]";
  const wojakMode = input.visualModality === "wojak";
  const wojakContext = wojakMode
    ? `
- visual_modality: wojak (MANDATORY)
- stock_ratio: 0 — do NOT use source "stock" or "manual_capture" on any scene
- Every scene: source "ai_generated", character_required true, character_variant set, search_keywords null
- Wojak must comically act out each narration_text; prefer type "video" with motion cues in description
`.trim()
    : "";
  const userPrompt = `
${input.promptBase}

Context:
- block_number: ${input.blockNumber}
- total_blocks: ${input.totalBlocks}
- audience: ${input.audience}
- stock_ratio: ${input.stockRatio}${wojakMode ? " (wojak mode: must be 0% stock)" : ""}
- manual_capture_signals: ${signals}${wojakMode ? " (wojak mode: ignore — no manual_capture)" : ""}
- max_videos_for_this_block: ${input.maxVideos} — HARD CAP: count of scenes with visual.type "video" must be ≤ this number.
- max_images_for_this_block: ${input.maxImages} — HARD CAP: count of scenes with visual.type "image" must be ≤ this number.
${wojakContext ? `${wojakContext}\n` : ""}- scenes (segmentation output — copy narration fields verbatim in output):
${input.segmentationJson}

Return ONLY JSON following visualiza01 schema (schema_version "2.0-visualization").
`.trim();

  const createParams: MessageCreateParamsNonStreaming & {
    thinking?: { type: "adaptive" };
    output_config?: { effort: "low" };
    temperature?: number;
  } = {
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    messages: [{ role: "user" as const, content: userPrompt }],
  };
  applyStructuredJsonCallParams(createParams);

  const response = await anthropic.messages.create(createParams);
  const textOut = response.content
    .filter((part: { type: string }) => part.type === "text")
    .map((part) => ("text" in part ? part.text : ""))
    .join("\n")
    .trim();

  if (!textOut) {
    const reason = "stop_reason" in response ? String(response.stop_reason) : "unknown";
    throw new Error(
      `Claude retornou visualizacao vazia para bloco ${input.blockNumber} (stop_reason=${reason})`
    );
  }
  return textOut;
}


import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import {
  CLAUDE_API_KEY,
  CLAUDE_BATCH_POLL_INTERVAL_MS,
  claudeModelForStage,
  type ClaudeBatchStage,
} from "../config.js";

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

export type ClaudeBatchRequestItem = {
  custom_id: string;
  params: MessageCreateParamsNonStreaming;
};

export type ClaudeBatchResultLine = {
  custom_id: string;
  result?: {
    type: string;
    message?: {
      content: Array<{ type: string; text?: string }>;
      stop_reason?: string | null;
    };
    error?: { type: string; message?: string };
  };
};

export function extractTextFromBatchMessage(message: unknown): string {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const parts = (message as { content: Array<{ type: string; text?: string }> }).content;
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
}

export async function createClaudeMessageBatch(
  requests: ClaudeBatchRequestItem[],
): Promise<{ id: string; processing_status: string }> {
  if (requests.length === 0) {
    throw new Error("createClaudeMessageBatch: lista vazia");
  }
  const anthropic = getClient();
  const batch = await anthropic.messages.batches.create({ requests });
  if (!batch.id?.trim()) {
    throw new Error("Claude batch: resposta sem id");
  }
  return { id: batch.id, processing_status: batch.processing_status };
}

export async function retrieveClaudeMessageBatch(batchId: string): Promise<{
  id: string;
  processing_status: string;
  request_counts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
  results_url: string | null;
  ended_at: string | null;
}> {
  const anthropic = getClient();
  const batch = await anthropic.messages.batches.retrieve(batchId);
  return {
    id: batch.id,
    processing_status: batch.processing_status,
    request_counts: batch.request_counts,
    results_url: batch.results_url ?? null,
    ended_at: batch.ended_at ?? null,
  };
}

export async function streamClaudeBatchResults(
  batchId: string,
): Promise<ClaudeBatchResultLine[]> {
  const anthropic = getClient();
  const decoder = await anthropic.messages.batches.results(batchId);
  const lines: ClaudeBatchResultLine[] = [];
  for await (const entry of decoder) {
    lines.push(entry as ClaudeBatchResultLine);
  }
  return lines;
}

export function isClaudeBatchTerminal(status: string): boolean {
  return status === "ended";
}

export function isClaudeBatchSuccess(status: string, errored: number, expired: number): boolean {
  return status === "ended" && errored === 0 && expired === 0;
}

export async function pollClaudeBatchUntilEnded(
  batchId: string,
  opts?: { pollIntervalMs?: number; maxRounds?: number; onStatus?: (status: string) => void },
): Promise<Awaited<ReturnType<typeof retrieveClaudeMessageBatch>>> {
  const interval = opts?.pollIntervalMs ?? CLAUDE_BATCH_POLL_INTERVAL_MS;
  const maxRounds = opts?.maxRounds ?? 500;
  for (let i = 0; i < maxRounds; i += 1) {
    const batch = await retrieveClaudeMessageBatch(batchId);
    opts?.onStatus?.(batch.processing_status);
    if (isClaudeBatchTerminal(batch.processing_status)) {
      return batch;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Claude batch ${batchId}: timeout aguardando conclusao (${maxRounds} rodadas)`);
}

export function buildBatchCustomId(
  projectId: number,
  stage: ClaudeBatchStage,
  blockNumber: number,
  suffix?: string,
): string {
  const base = `p${projectId}-${stage}-b${blockNumber}`;
  return suffix ? `${base}-${suffix}` : base;
}

export { claudeModelForStage };

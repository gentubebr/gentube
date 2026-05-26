import { sanitizeScriptBlockContent } from "../utils/sanitize-script-block.js";
import { insertClaudeBatchJob, updateClaudeBatchJob } from "../repository-claude-batch.js";
import {
  buildBatchCustomId,
  createClaudeMessageBatch,
  extractTextFromBatchMessage,
  isClaudeBatchSuccess,
  pollClaudeBatchUntilEnded,
  streamClaudeBatchResults,
} from "./claude-batch.js";
import { buildMessageCreateParams, buildRoteiroUserPrompt, type RoteiroPromptInput } from "./claude.js";

/**
 * Submete todos os blocos de roteiro de um projeto como um unico Message Batch da Anthropic
 * (~50% de economia vs chamadas sincronas individuais).
 *
 * Retorna Map<blockNumber, textoLimpo>. Lanca erro se algum bloco falhar ou retornar vazio.
 */
export async function runRoteiroBatchAll(
  items: Array<RoteiroPromptInput & { projectId: number }>,
  opts?: {
    onStatus?: (status: string, batchId: string) => void;
    pollIntervalMs?: number;
  },
): Promise<Map<number, string>> {
  if (items.length === 0) {
    return new Map();
  }

  // Todos os items devem pertencer ao mesmo projeto
  const projectId = items[0].projectId;

  const requests = items.map((item) => {
    const customId = buildBatchCustomId(projectId, "roteiro", item.blockNumber);
    const userPrompt = buildRoteiroUserPrompt(item);
    const params = buildMessageCreateParams("roteiro", userPrompt);
    return { custom_id: customId, params };
  });

  const batch = await createClaudeMessageBatch(requests);
  const batchId = batch.id;

  // Registrar job por bloco no banco para rastreabilidade
  const jobIdByBlock = new Map<number, number>();
  for (const item of items) {
    const customId = buildBatchCustomId(projectId, "roteiro", item.blockNumber);
    const rowId = insertClaudeBatchJob({
      projectId,
      stage: "roteiro",
      blockNumber: item.blockNumber,
      customId,
      batchId,
    });
    jobIdByBlock.set(item.blockNumber, rowId);
  }

  opts?.onStatus?.(batch.processing_status, batchId);

  const ended = await pollClaudeBatchUntilEnded(batchId, {
    pollIntervalMs: opts?.pollIntervalMs,
    onStatus: (s, _counts) => opts?.onStatus?.(s, batchId),
  });

  if (!isClaudeBatchSuccess(ended.processing_status, ended.request_counts.errored, ended.request_counts.expired)) {
    throw new Error(
      `Batch roteiro ${batchId} terminou com erros: errored=${ended.request_counts.errored} expired=${ended.request_counts.expired}`,
    );
  }

  const resultLines = await streamClaudeBatchResults(batchId);

  const results = new Map<number, string>();
  const errors: string[] = [];

  for (const line of resultLines) {
    // custom_id format: p{projectId}-roteiro-b{blockNumber}
    const match = line.custom_id.match(/-b(\d+)$/);
    if (!match) continue;
    const blockNumber = parseInt(match[1], 10);
    const jobRowId = jobIdByBlock.get(blockNumber);

    if (line.result?.type !== "succeeded" || !line.result.message) {
      const errMsg = line.result?.error?.message ?? "resultado nao-sucesso";
      errors.push(`bloco ${blockNumber}: ${errMsg}`);
      if (jobRowId !== undefined) {
        updateClaudeBatchJob(jobRowId, { status: "ended", outcome: "error", error_message: errMsg });
      }
      continue;
    }

    const rawText = extractTextFromBatchMessage(line.result.message);
    const cleaned = sanitizeScriptBlockContent(rawText);

    if (!cleaned) {
      const errMsg = "resposta vazia apos limpeza";
      errors.push(`bloco ${blockNumber}: ${errMsg}`);
      if (jobRowId !== undefined) {
        updateClaudeBatchJob(jobRowId, { status: "ended", outcome: "error", error_message: errMsg });
      }
      continue;
    }

    if (jobRowId !== undefined) {
      updateClaudeBatchJob(jobRowId, { status: "ended", outcome: "done", error_message: null });
    }
    results.set(blockNumber, cleaned);
  }

  if (errors.length > 0) {
    throw new Error(`runRoteiroBatchAll: ${errors.length} bloco(s) com erro:\n${errors.join("\n")}`);
  }

  return results;
}

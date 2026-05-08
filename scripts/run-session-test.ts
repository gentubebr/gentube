/**
 * Execucao nao-interativa para testes (canal + projeto + pipeline).
 * Uso: npx tsx scripts/run-session-test.ts
 *
 * Opcional: ELEVENLABS_VOICE_ID no .env para rodar narracao apos roteiro.
 */
import path from "node:path";
import { ELEVENLABS_VOICE_ID, VIDEOS_DIR } from "../src/config.js";
import { getDb } from "../src/db.js";
import {
  createChannel,
  createProject,
  getProjectByIdOrSlug,
  listChannels,
} from "../src/repository.js";
import { runNarracao, runRoteiro } from "../src/services/pipeline.js";
import { ensureDir, ensureTemplateStructure, formatDateYYYYMMDD, toSlug } from "../src/utils/fs.js";

getDb();

const CANAL = "Late Bloomer Lou";
const TITULO = "5 Ways Rich People Make Money With Debt";
const NICHO = "personal finance, wealth building, and investing";
const PUBLICO =
  "Americans in the United States, age 30 and above, interested in money and financial independence";
const TOTAL_BLOCOS = 1;

async function main(): Promise<void> {
  let channel = listChannels().find((c) => c.nome_canal === CANAL);
  if (!channel) {
    const slug = toSlug(CANAL);
    const basePath = path.join(VIDEOS_DIR, slug);
    await ensureDir(basePath);
    const id = createChannel(CANAL, slug, basePath);
    channel = listChannels().find((c) => c.id === id)!;
    console.log(`Canal criado: id=${id} path=${basePath}`);
  } else {
    console.log(`Canal existente: id=${channel.id} path=${channel.base_path}`);
  }

  const dataProjeto = formatDateYYYYMMDD();
  const folderName = `${dataProjeto}-${toSlug(TITULO)}`;
  const projectPath = path.join(channel.base_path, folderName);

  await ensureDir(projectPath);
  await ensureTemplateStructure(projectPath);

  const projectId = createProject({
    channelId: channel.id,
    titulo: TITULO,
    slug: folderName,
    dataProjeto,
    projectPath,
    totalBlocos: TOTAL_BLOCOS,
    niche: NICHO,
    audience: PUBLICO,
  });

  console.log(`Projeto criado: id=${projectId} path=${projectPath}`);

  const project = getProjectByIdOrSlug(String(projectId));
  if (!project) throw new Error("Projeto nao encontrado apos criacao");

  console.log("Gerando roteiro (Claude)...");
  await runRoteiro(project);
  console.log("Roteiro concluido.");

  const voiceId = ELEVENLABS_VOICE_ID || undefined;
  if (voiceId) {
    const refreshed = getProjectByIdOrSlug(String(projectId));
    if (!refreshed) throw new Error("Projeto nao encontrado");
    console.log("Gerando narracao (ElevenLabs)...");
    await runNarracao(refreshed, voiceId);
    console.log("Narracao concluida.");
  } else {
    console.log(
      "Pule narracao: defina ELEVENLABS_VOICE_ID no .env ou rode: npm run gentube -- run-step --project <id> --step narracao"
    );
  }

  console.log(`Status final — use: npm run gentube -- status --project ${projectId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

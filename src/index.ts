#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { confirm, input, number, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import {
  DEFAULT_BLOCKS,
  DEFAULT_MAX_IMAGES_BLOCK1,
  DEFAULT_MAX_IMAGES_OTHER_BLOCKS,
  DEFAULT_MAX_VIDEOS_BLOCK1,
  DEFAULT_MAX_VIDEOS_OTHER_BLOCKS,
  ELEVENLABS_VOICE_ID,
  GEMINI_LOCAL_BATCH_CONCURRENCY,
  assertImagensPhaseFlagsExclusive,
  imageRunFlagsFromCli,
  ROOT_DIR,
  VIDEOS_DIR,
} from "./config.js";
import { getPackageVersion } from "./version.js";
import { getDb } from "./db.js";
import {
  addProjectLog,
  countHfCliJobsPending,
  countImageJobsPending,
  createChannel,
  createProject,
  deleteProject,
  getProjectByIdOrSlug,
  listChannels,
  listProjectsSummary,
} from "./repository.js";
import { generateGeminiImageSync } from "./integrations/gemini-image.js";
import {
  applyGoogleBatchResults,
  pollGoogleBatchOnce,
  submitGoogleImageBatch,
} from "./integrations/gemini-batch.js";
import type { ImageJobRow } from "./types/image-jobs.js";
import {
  countAllImageJobsPending,
  GEMINI_BATCH_POLL_INTERVAL_MS,
  submitPendingGoogleBatches,
  syncImageJobsOnce,
} from "./services/image-sync.js";
import type { ImagensVideosOptions } from "./services/pipeline.js";
import { processLocalImageBatch } from "./services/image-local-batch.js";
import { syncHiggsfieldCliJobsOnce } from "./services/hf-cli-sync.js";
import { printVideoProjectStatus } from "./services/video-status-cli.js";
import { retryMissingVideos } from "./services/video-retry.js";
import { runInit } from "./init-setup.js";
import {
  runImagensVideos,
  runImagensVideosBlock,
  runNarracao,
  runNarracaoBlock,
  runRoteiro,
  runRoteiroBlock,
  runThumbnails,
} from "./services/pipeline.js";
import { syncProjectFromDisk, type SyncFromDiskScope } from "./services/sync-from-disk.js";
import { writeShotListManualFiles } from "./services/shot-list-manual.js";
import { ensureDir, ensureTemplateStructure, formatDateYYYYMMDD, toSlug, writeModelagemTranscript } from "./utils/fs.js";
import { Step3Limits } from "./types/step3-limits.js";
import {
  fetchAccountStatus,
  forwardArgvAfterSubcommand,
  runHiggsfieldCli,
} from "./integrations/higgsfield-agents.js";
import { getSubscriptionInfo } from "./integrations/elevenlabs.js";
import { CLI_HELP } from "./cli-help.js";

type ProjectRow = Record<string, unknown>;

function parseHfSyncIntervalMs(raw: string | undefined): number {
  const t = (raw ?? "30s").trim().toLowerCase();
  if (!t) return 30_000;
  if (/^\d+$/.test(t)) return Math.max(1_000, parseInt(t, 10) * 1000);
  if (t.endsWith("ms")) return Math.max(500, parseFloat(t) * 1);
  if (t.endsWith("s")) return Math.max(1_000, (parseFloat(t) || 1) * 1000);
  if (t.endsWith("m")) return Math.max(5_000, (parseFloat(t) || 1) * 60_000);
  return 30_000;
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain) return "***";
  if (local.length <= 1) return `*@${domain}`;
  return `${local[0]}***@${domain}`;
}

getDb();

const VERSION = getPackageVersion();

const program = new Command();
program
  .name("gentube")
  .description(
    "CLI de producao de video por canal: roteiro (Claude), narracao (ElevenLabs), " +
      "imagens/videos (HF, Gemini, Magnific, Veo), thumbnails e status no SQLite. " +
      "Use: gentube help <comando> para detalhes de cada etapa."
  )
  .version(VERSION, "-V, --version", "Exibe a versao e encerra")
  .helpOption("-h, --help", "Exibe ajuda geral (ou use: help <comando>)");

program.configureHelp({ sortSubcommands: true });

program.helpCommand(
  "help [comando]",
  "Ajuda detalhada de um subcomando (ex.: help run-step, help video:retry)"
);

program.addHelpText("after", CLI_HELP.main);

program.showHelpAfterError(chalk.dim("(use --help ou help <comando> para mais detalhes)"));

program
  .command("init")
  .description(
    "Primeira vez no projeto: cria .env a partir do exemplo, pastas, opcao de chaves API e cadastro de canal"
  )
  .action(async () => {
    await runInit();
  });

program
  .command("channel:create")
  .description("Cadastra um canal (pasta em Videos/<slug>). Canais nao podem ser removidos pelo CLI")
  .action(async () => {
    const nomeCanal = await input({ message: "Nome do canal:", validate: (v) => (!!v.trim() ? true : "Informe o nome do canal") });
    const slugCanal = toSlug(nomeCanal);
    const basePath = path.join(VIDEOS_DIR, slugCanal);
    await ensureDir(basePath);
    const id = createChannel(nomeCanal, slugCanal, basePath);
    console.log(chalk.green(`Canal criado com sucesso (id: ${id}, slug: ${slugCanal})`));
  });

program
  .command("channel:list")
  .description("Lista canais com id, slug e caminho (use o id em create-video ou em --project quando for o caso)")
  .action(() => {
    const channels = listChannels();
    if (channels.length === 0) {
      console.log(chalk.yellow("Nenhum canal cadastrado."));
      return;
    }
    console.log(chalk.cyan("Canais cadastrados:"));
    channels.forEach((channel) => {
      console.log(`- [${channel.id}] ${channel.nome_canal} (${channel.slug_canal}) -> ${channel.base_path}`);
    });
  });

program
  .command("projects:list")
  .description("Lista canais e projetos de video registados no SQLite (por canal)")
  .option("--json", "Saida em JSON (canais com array projects)")
  .action((opts: { json?: boolean }) => {
    const channels = listChannels();
    const projects = listProjectsSummary();
    const byChannel = new Map<number, typeof projects>();
    for (const p of projects) {
      const arr = byChannel.get(p.channel_id) ?? [];
      arr.push(p);
      byChannel.set(p.channel_id, arr);
    }

    if (opts.json) {
      const payload = channels.map((c) => ({
        id: c.id,
        nome_canal: c.nome_canal,
        slug_canal: c.slug_canal,
        base_path: c.base_path,
        projects: (byChannel.get(c.id) ?? []).map((p) => ({
          id: p.id,
          titulo: p.titulo,
          slug: p.slug,
          data_projeto: p.data_projeto,
          project_path: p.project_path,
          total_blocos: p.total_blocos,
          status_roteiro: p.status_roteiro,
          status_narracao: p.status_narracao,
          status_imagens_videos: p.status_imagens_videos,
          status_thumbnails: p.status_thumbnails,
        })),
      }));
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    if (channels.length === 0) {
      console.log(chalk.yellow("Nenhum canal cadastrado."));
      return;
    }

    console.log(chalk.cyan.bold("Canais e projetos"));
    for (const c of channels) {
      console.log("");
      console.log(chalk.cyan(`Canal [${c.id}] ${c.nome_canal} (${c.slug_canal})`));
      console.log(chalk.dim(`  ${c.base_path}`));
      const list = byChannel.get(c.id) ?? [];
      if (list.length === 0) {
        console.log(chalk.dim("  (nenhum projeto)"));
        continue;
      }
      for (const p of list) {
        const st = `${p.status_roteiro} | ${p.status_narracao} | ${p.status_imagens_videos} | ${p.status_thumbnails}`;
        console.log(
          `  - [${p.id}] ${p.titulo}  ${chalk.dim(`(${p.slug})`)}  ${chalk.dim(`${p.total_blocos} blocos`)}  ${chalk.dim(st)}`
        );
        console.log(chalk.dim(`      ${p.project_path}`));
      }
    }
    console.log("");
  });

type CreateVideoCliOptions = {
  channel?: string;
  title?: string;
  niche?: string;
  audience?: string;
  blocks?: string;
  transcriptFile?: string;
  transcriptText?: string;
  mode?: string;
  promptMatrix?: string;
  promptCanalVoice?: string;
};

program
  .command("create-video")
  .description("Cria pasta do projeto + SQLite; modo iterativo ou sequencial apos criar")
  .addHelpText("after", CLI_HELP.createVideo)
  .option("--channel <id>", "ID do canal (channel:list). Sem flag, abre menu")
  .option("--title <texto>", "Titulo do video")
  .option("--niche <texto>", "Nicho ([NOME DO NICHO] no prompt de roteiro)")
  .option("--audience <texto>", "Publico alvo ([PUBLICO])")
  .option("--blocks <n>", `Quantidade de blocos (1-64; padrao interativo: ${DEFAULT_BLOCKS})`)
  .option(
    "--transcript-file <caminho>",
    "Arquivo UTF-8: transcricao ou notas de um video de referencia (estrutura e mensagens-chave; o roteiro nao deve copiar o texto)"
  )
  .option(
    "--transcript-text <texto>",
    "Mesmo papel de --transcript-file, em uma linha (textos longos: prefira arquivo)"
  )
  .option("--mode <modo>", "Apos criar: iterativo | sequencial (sem flag, pergunta)")
  .option(
    "--prompt-matrix <ficheiro>",
    "Prompt da etapa roteiro: nome em Prompts/ (ex.: matriz_tutorial.md) ou caminho absoluto sob Prompts/. Sobrescreve GENTUBE_PROMPT_MATRIX"
  )
  .option(
    "--prompt-canal-voice <ficheiro>",
    "Bloco 1: voz/persona do canal (Markdown em Prompts/; padrao canal_voice.md). Sobrescreve GENTUBE_PROMPT_CANAL_VOICE; use none para nao injetar"
  )
  .action(async (opts: CreateVideoCliOptions) => {
    const channels = listChannels();
    if (channels.length === 0) {
      console.log(chalk.red("Nao existe canal cadastrado. Rode primeiro: gentube channel:create"));
      return;
    }

    let selectedChannel: (typeof channels)[0];
    if (opts.channel !== undefined && opts.channel !== "") {
      const id = parseInt(opts.channel, 10);
      if (Number.isNaN(id)) {
        throw new Error("--channel deve ser um ID numerico (veja channel:list)");
      }
      const found = channels.find((c) => c.id === id);
      if (!found) {
        throw new Error(`Canal id=${id} nao encontrado. Use channel:list`);
      }
      selectedChannel = found;
    } else {
      const channelId = await select<number>({
        message: "Escolha o canal:",
        choices: channels.map((channel) => ({ value: channel.id, name: `[${channel.id}] ${channel.nome_canal}` })),
      });
      const found = channels.find((c) => c.id === channelId);
      if (!found) {
        throw new Error("Canal selecionado nao encontrado");
      }
      selectedChannel = found;
    }

    const titulo =
      opts.title?.trim() ||
      (await input({ message: "Titulo do video:", validate: (v) => (!!v.trim() ? true : "Informe o titulo") }));
    const niche =
      opts.niche?.trim() ||
      (await input({ message: "Nome do nicho ([NOME DO NICHO]):", validate: (v) => (!!v.trim() ? true : "Informe o nicho") }));
    const audience =
      opts.audience?.trim() ||
      (await input({ message: "Publico alvo ([PUBLICO]):", validate: (v) => (!!v.trim() ? true : "Informe o publico") }));

    let totalBlocos: number;
    if (opts.blocks !== undefined && opts.blocks !== "") {
      const n = parseInt(opts.blocks, 10);
      if (Number.isNaN(n) || n < 1 || n > 64) {
        throw new Error("--blocks deve ser um inteiro entre 1 e 64");
      }
      totalBlocos = n;
    } else {
      const customBlocks = await confirm({
        message: `Deseja alterar a quantidade de blocos? (padrao ${DEFAULT_BLOCKS})`,
        default: false,
      });
      const totalBlocosInput = customBlocks
        ? await number({ message: "Nova quantidade de blocos:", min: 1, max: 64, default: DEFAULT_BLOCKS })
        : DEFAULT_BLOCKS;
      totalBlocos = totalBlocosInput ?? DEFAULT_BLOCKS;
    }

    let transcript: string | undefined;
    if (opts.transcriptFile && opts.transcriptText) {
      throw new Error("Use apenas uma opcao: --transcript-file ou --transcript-text");
    }
    if (opts.transcriptFile) {
      const abs = path.resolve(process.cwd(), opts.transcriptFile);
      transcript = await fs.readFile(abs, "utf-8");
      if (!transcript.trim()) {
        throw new Error(`Arquivo vazio ou so espacos: ${abs}`);
      }
    } else if (opts.transcriptText !== undefined && opts.transcriptText !== "") {
      transcript = opts.transcriptText;
    } else {
      const hasTranscript = await confirm({
        message:
          "Deseja informar transcricao / notas de um video de referencia (estrutura e mensagens-chave, sem copiar)?",
        default: false,
      });
      transcript = hasTranscript
        ? await input({
            message: "Cole o texto de referencia (ou cancele e rode de novo com --transcript-file):",
          })
        : undefined;
      if (transcript !== undefined && !transcript.trim()) {
        transcript = undefined;
      }
    }

    const dataProjeto = formatDateYYYYMMDD();
    const videoSlug = toSlug(titulo);
    const folderName = `${dataProjeto}-${videoSlug}`;
    const projectPath = path.join(String(selectedChannel.base_path), folderName);

    await ensureDir(projectPath);
    await ensureTemplateStructure(projectPath);

    if (transcript?.trim()) {
      const transcriptPath = await writeModelagemTranscript(projectPath, transcript.trim());
      console.log(chalk.dim(`Referencia salva em: ${transcriptPath}`));
    }

    const projectId = createProject({
      channelId: selectedChannel.id,
      titulo,
      slug: folderName,
      dataProjeto,
      projectPath,
      totalBlocos,
      niche,
      audience,
      transcript,
    });

    console.log(chalk.green(`Projeto criado com sucesso (id: ${projectId}) em ${projectPath}`));

    let mode: "iterativo" | "sequencial";
    const modeFlag = opts.mode?.trim().toLowerCase();
    if (modeFlag) {
      if (modeFlag === "iterativo" || modeFlag === "sequencial") {
        mode = modeFlag;
      } else {
        throw new Error('--mode deve ser "iterativo" ou "sequencial"');
      }
    } else {
      mode = await select<"iterativo" | "sequencial">({
        message: "Modo de execucao:",
        choices: [
          { value: "iterativo", name: "Iterativo (executar etapa por etapa)" },
          { value: "sequencial", name: "Sequencial (roteiro + narracao de uma vez)" },
        ],
      });
    }

    const project = getProjectByIdOrSlug(String(projectId));
    if (!project) throw new Error("Projeto recem-criado nao encontrado");

    if (mode === "sequencial") {
      await executeAll(project, undefined, opts.promptMatrix, opts.promptCanalVoice);
    } else {
      console.log(chalk.cyan("Projeto criado. Use run-step para executar as etapas."));
    }
  });

program
  .command("run-step")
  .description(
    "Executa uma etapa do pipeline: roteiro | narracao | imagens | thumbnails (ver help run-step)"
  )
  .addHelpText("after", CLI_HELP.runStep)
  .requiredOption("--project <idOuSlug>", "ID numerico (ex.: 10) ou slug da pasta (ex.: 20260518-meu-titulo)")
  .requiredOption("--step <etapa>", "Etapa: roteiro | narracao | imagens | thumbnails")
  .option("--voice-id <id>", "Narracao: voice ElevenLabs (padrao: ELEVENLABS_VOICE_ID ou prompt)")
  .option("--avatar-file <caminho>", "Opcional: avatar para consistencia visual (imagens e thumbnails)")
  .option("--reference-url <url>", "Step thumbnails: URL do video YouTube cuja thumbnail sera usada como referencia")
  .option("--count <n>", "Step thumbnails: quantidade de thumbnails a gerar (padrao 2)", "2")
  .option("--prompt <texto>", "Step thumbnails: prompt customizado para o Higgsfield (opcional; sem flag usa prompt padrao com titulo)")
  .option("--max-videos-block1 <n>", `Max videos bloco 1 (padrao ${DEFAULT_MAX_VIDEOS_BLOCK1})`)
  .option("--max-images-block1 <n>", `Max imagens bloco 1 (padrao ${DEFAULT_MAX_IMAGES_BLOCK1})`)
  .option("--max-videos-other <n>", `Max videos blocos 2..N (padrao ${DEFAULT_MAX_VIDEOS_OTHER_BLOCKS})`)
  .option("--max-images-other <n>", `Max imagens blocos 2..N (padrao ${DEFAULT_MAX_IMAGES_OTHER_BLOCKS})`)
  .option(
    "--prompt-matrix <ficheiro>",
    "Step roteiro: ficheiro em Prompts/ (ex.: matriz_tutorial.md) ou caminho absoluto sob Prompts/. Sobrescreve GENTUBE_PROMPT_MATRIX"
  )
  .option(
    "--prompt-canal-voice <ficheiro>",
    "Step roteiro bloco 1: voz do canal (Prompts/; padrao canal_voice.md). Sobrescreve GENTUBE_PROMPT_CANAL_VOICE"
  )
  .option(
    "--scene-plan-v2",
    "Imagens: plano por cenas (segmentacao + visualizacao Claude → blockNN.assets.json schema 2.0)"
  )
  .option(
    "--google-batch-mode",
    "Imagens/thumbnails: entrega via Batch API Google (1 batch por bloco; poll com image:sync)"
  )
  .option("--batch-local", "Imagens/thumbnails: batch paralelo local Gemini (testes; exclusivo com --google-batch-mode)")
  .option("--plan-only", "Imagens v2: apenas Claude → assets.json em todos os blocos (exige --scene-plan-v2)")
  .option(
    "--enqueue-only",
    "Imagens v2: stock + filas + videos HF; submit N batches Google no fim (exige plano + --scene-plan-v2)"
  )
  .action(async (options: {
    project: string;
    step: "roteiro" | "narracao" | "imagens" | "thumbnails";
    voiceId?: string;
    avatarFile?: string;
    referenceUrl?: string;
    count?: string;
    prompt?: string;
    maxVideosBlock1?: string;
    maxImagesBlock1?: string;
    maxVideosOther?: string;
    maxImagesOther?: string;
    promptMatrix?: string;
    promptCanalVoice?: string;
    scenePlanV2?: boolean;
    googleBatchMode?: boolean;
    batchLocal?: boolean;
    planOnly?: boolean;
    enqueueOnly?: boolean;
  }) => {
    const project = getProjectByIdOrSlug(options.project);
    if (!project) throw new Error("Projeto nao encontrado");

    if (options.step === "roteiro") {
      await executeRoteiro(project, options.promptMatrix, options.promptCanalVoice);
      return;
    }
    if (options.step === "imagens") {
      const limits = parseStep3Limits(options);
      const imagensOpts = buildImagensVideosOpts(options);
      await executeImagens(project, options.avatarFile, limits, imagensOpts);
      return;
    }
    if (options.step === "thumbnails") {
      const imageFlags = imageRunFlagsFromCli(options);
      await executeThumbnails(
        project,
        options.referenceUrl,
        options.avatarFile,
        options.count,
        options.prompt,
        imageFlags
      );
      return;
    }
    const voiceId = await resolveVoiceId(options.voiceId);
    await executeNarracao(project, voiceId);
  });

program
  .command("run-all")
  .description("Roteiro (todos os blocos) e narracao em sequencia — nao inclui imagens/thumbnails")
  .addHelpText("after", CLI_HELP.runAll)
  .requiredOption("--project <idOuSlug>", "ID ou slug do projeto em video_projects")
  .option("--voice-id <id>", "Voice ElevenLabs (ou .env ELEVENLABS_VOICE_ID)")
  .option(
    "--prompt-matrix <ficheiro>",
    "Roteiro: ficheiro em Prompts/ (ex.: matriz_tutorial.md). Sobrescreve GENTUBE_PROMPT_MATRIX"
  )
  .option(
    "--prompt-canal-voice <ficheiro>",
    "Roteiro bloco 1: voz do canal (Prompts/). Sobrescreve GENTUBE_PROMPT_CANAL_VOICE"
  )
  .action(async (options: { project: string; voiceId?: string; promptMatrix?: string; promptCanalVoice?: string }) => {
    const project = getProjectByIdOrSlug(options.project);
    if (!project) throw new Error("Projeto nao encontrado");
    const voiceId = await resolveVoiceId(options.voiceId);
    await executeAll(project, voiceId, options.promptMatrix, options.promptCanalVoice);
  });

program
  .command("sync-from-disk")
  .description("Sincroniza SQLite com ficheiros no disco (roteiro, narracao, plano/renders de imagens)")
  .addHelpText("after", CLI_HELP.syncFromDisk)
  .requiredOption("--project <idOuSlug>", "ID ou slug do projeto")
  .option("--dry-run", "Lista alteracoes sem escrever no SQLite")
  .option("--force", "Reimportar blocos que ja estao success no DB")
  .option("--only <escopo>", "roteiro | narracao | imagens | all (default: all)", "all")
  .action(
    async (opts: { project: string; dryRun?: boolean; force?: boolean; only?: string }) => {
      const allowed: SyncFromDiskScope[] = ["roteiro", "narracao", "imagens", "all"];
      const onlyRaw = (opts.only ?? "all").trim().toLowerCase();
      if (!allowed.includes(onlyRaw as SyncFromDiskScope)) {
        throw new Error(`--only deve ser um de: ${allowed.join(", ")}`);
      }
      const project = getProjectByIdOrSlug(opts.project);
      if (!project) throw new Error("Projeto nao encontrado");
      const report = await syncProjectFromDisk(project, {
        dryRun: Boolean(opts.dryRun),
        force: Boolean(opts.force),
        only: onlyRaw as SyncFromDiskScope,
      });
      console.log(chalk.dim("\nResumo (JSON):"));
      console.log(JSON.stringify(report, null, 2));
    }
  );

program
  .command("shot-list-manual")
  .description("Exporta lista de capturas manuais (MD + CSV) a partir de block*.assets.json v2")
  .addHelpText("after", CLI_HELP.shotListManual)
  .requiredOption("--project <idOuSlug>", "ID ou slug do projeto")
  .action(async (opts: { project: string }) => {
    const project = getProjectByIdOrSlug(opts.project);
    if (!project) throw new Error("Projeto nao encontrado");
    const out = await writeShotListManualFiles(String(project.project_path));
    console.log(chalk.green(`Shot list manual: ${out.totalCaptures} captura(s).`));
    console.log(chalk.dim(out.mdPath));
    console.log(chalk.dim(out.csvPath));
  });

program
  .command("status")
  .description("Status das etapas do projeto e caminho da pasta no disco")
  .addHelpText("after", CLI_HELP.status)
  .requiredOption("--project <idOuSlug>", "ID ou slug do projeto")
  .action(async (options: { project: string }) => {
    const project = getProjectByIdOrSlug(options.project);
    if (!project) throw new Error("Projeto nao encontrado");
    console.log(chalk.cyan(`Projeto: ${project.titulo} (${project.slug})`));
    console.log(`- Roteiro: ${project.status_roteiro}`);
    console.log(`- Narracao: ${project.status_narracao}`);
    console.log(`- Imagens e Videos: ${project.status_imagens_videos}`);
    console.log(`- Thumbnails: ${project.status_thumbnails}`);
    console.log(`- Pasta: ${project.project_path}`);
  });

program
  .command("elevenlabs:status")
  .description("Cota de caracteres ElevenLabs no periodo atual (antes/depois da narracao)")
  .addHelpText("after", CLI_HELP.elevenlabsStatus)
  .option("--json", "Imprime JSON bruto")
  .action(async (options: { json?: boolean }) => {
    try {
      const info = await getSubscriptionInfo();
      if (options.json) {
        console.log(JSON.stringify(info, null, 2));
        return;
      }
      const pct = info.characterLimit > 0
        ? ((info.characterCount / info.characterLimit) * 100).toFixed(1)
        : "0.0";
      const resetDate = info.nextResetUnix
        ? new Date(info.nextResetUnix * 1000).toLocaleDateString("pt-BR")
        : "n/a";
      console.log(chalk.bold("\nElevenLabs — uso do periodo"));
      console.log(`  Plano:      ${info.tier}`);
      console.log(`  Usados:     ${info.characterCount.toLocaleString("pt-BR")} / ${info.characterLimit.toLocaleString("pt-BR")} caracteres (${pct}%)`);
      console.log(`  Restantes:  ${info.characterRemaining.toLocaleString("pt-BR")} caracteres`);
      console.log(`  Reset em:   ${resetDate}\n`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Erro desconhecido";
      console.error(chalk.red(`Erro ao consultar ElevenLabs: ${msg}`));
      process.exitCode = 1;
    }
  });

program
  .command("higgsfield:status")
  .description(
    "Conta Higgsfield (CLI): creditos e plano via credentials.json (email mascarado; use --json para saida completa)"
  )
  .option("--json", "Imprime JSON bruto (email completo; evite logs compartilhados)")
  .action(async (options: { json?: boolean }) => {
    const s = await fetchAccountStatus();
    if (options.json) {
      console.log(
        JSON.stringify({
          email: s.email,
          credits: s.credits,
          subscription_plan_type: s.subscription_plan_type,
        })
      );
      return;
    }
    console.log(
      chalk.cyan(
        `${maskEmail(s.email)} — ${s.subscription_plan_type} plan, ${s.credits} credits`
      )
    );
  });

program
  .command("higgsfield:generate")
  .description(
    "Encapsula `hf generate create`: repassa argumentos apos o comando (use hf no PATH ou HIGGSFIELD_CLI_PATH)"
  )
  // Flags como --prompt sao do hf, nao do gentube; sem isso o Commander acusa "unknown option".
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .addHelpText(
    "after",
    `
${chalk.bold("Exemplo")}
  npx tsx src/index.ts higgsfield:generate nano_banana_flash \\
    --prompt "modern architecture, glass facade, golden hour light" \\
    --aspect_ratio 16:9 --resolution 1k --wait

${chalk.dim("Com npm run, use aspas no --prompt para o shell nao partir o texto em varias palavras.")}
Credenciais: ~/.config/higgsfield/credentials.json (ou HIGGSFIELD_CREDENTIALS_PATH).
`.trim()
  )
  .action(async () => {
    const forwarded = forwardArgvAfterSubcommand("higgsfield:generate");
    if (forwarded.length === 0) {
      console.error(
        chalk.yellow(
          "Informe o job_set_type e flags do hf apos higgsfield:generate (ex.: nano_banana_flash --prompt \"...\" --wait)."
        )
      );
      console.error(chalk.dim("Ajuda do hf: hf generate create --help"));
      process.exitCode = 1;
      return;
    }
    const code = await runHiggsfieldCli(["generate", "create", ...forwarded]);
    process.exitCode = code;
  });

function cliImageJobRow(id: number, prompt: string, outPathNoExt: string, batchId: string): ImageJobRow {
  const now = new Date().toISOString();
  return {
    id,
    project_id: 0,
    block_number: 0,
    shot_id: `cli_${id}`,
    asset_type: "image",
    provider: "gemini",
    delivery_mode: "google_batch",
    external_id: null,
    batch_id: batchId,
    out_path_no_ext: outPathNoExt,
    status: "pending",
    outcome: "pending",
    result_mime: null,
    error_message: null,
    reference_image_path: null,
    prompt_text: prompt,
    downloaded_at: null,
    created_at: now,
    updated_at: now,
  };
}

async function readPromptsFile(filePath: string): Promise<string[]> {
  const raw = await fs.readFile(filePath, "utf-8");
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

program
  .command("gemini:image")
  .description("Gera imagem(ns) via Google Gemini (sync, batch local ou Batch API Google)")
  .option("--prompt <texto>", "Um prompt (modo sync; requer --out)")
  .option("--out <caminho>", "Arquivo de saida sem extensao ou com extensao (modo sync)")
  .option("--prompts-file <arquivo>", "Um prompt por linha (batch; requer --out-dir)")
  .option("--out-dir <dir>", "Diretorio de saida para batch")
  .option("--reference <caminho>", "Imagem de referencia opcional (sync ou batch)")
  .option("--google-batch-mode", "Usa Batch API Google (requer --prompts-file)")
  .option("--batch-local", "Processa prompts em paralelo localmente (testes)")
  .option("--concurrency <n>", `Concorrencia do batch-local (padrao ${GEMINI_LOCAL_BATCH_CONCURRENCY})`)
  .action(
    async (options: {
      prompt?: string;
      out?: string;
      promptsFile?: string;
      outDir?: string;
      reference?: string;
      googleBatchMode?: boolean;
      batchLocal?: boolean;
      concurrency?: string;
    }) => {
      imageRunFlagsFromCli(options);

      const ref = options.reference?.trim() ? path.resolve(options.reference.trim()) : undefined;

      if (options.prompt?.trim() && options.out?.trim()) {
        if (options.googleBatchMode || options.batchLocal) {
          throw new Error("Com --prompt use modo sync (sem --google-batch-mode nem --batch-local)");
        }
        const outRaw = path.resolve(options.out.trim());
        const outNoExt = /\.(png|jpe?g|webp)$/i.test(outRaw) ? outRaw.replace(/\.(png|jpe?g|webp)$/i, "") : outRaw;
        const result = await generateGeminiImageSync({
          prompt: options.prompt.trim(),
          outPathNoExt: outNoExt,
          referenceImagePath: ref,
        });
        console.log(chalk.green(`Imagem salva: ${result.localPath}`));
        return;
      }

      const promptsPath = options.promptsFile?.trim();
      const outDir = options.outDir?.trim();
      if (!promptsPath || !outDir) {
        throw new Error("Batch requer --prompts-file e --out-dir (ou use --prompt com --out para sync)");
      }
      if (!options.googleBatchMode && !options.batchLocal) {
        throw new Error("Batch requer --google-batch-mode ou --batch-local");
      }

      const prompts = await readPromptsFile(path.resolve(promptsPath));
      if (prompts.length === 0) throw new Error("Nenhum prompt em --prompts-file");

      await fs.mkdir(path.resolve(outDir), { recursive: true });
      const batchId = crypto.randomUUID();

      if (options.batchLocal) {
        const jobs = prompts.map((p, i) => {
          const outPathNoExt = path.join(path.resolve(outDir), `img_${String(i + 1).padStart(3, "0")}`);
          return cliImageJobRow(i + 1, p, outPathNoExt, batchId);
        });
        const concurrency = Math.max(1, parseInt(String(options.concurrency ?? ""), 10) || GEMINI_LOCAL_BATCH_CONCURRENCY);
        await processLocalImageBatch(jobs, concurrency, { skipDb: true });
        console.log(chalk.green(`Batch local: ${jobs.length} imagem(ns) em ${path.resolve(outDir)}`));
        return;
      }

      const jobs = prompts.map((p, i) => {
        const outPathNoExt = path.join(path.resolve(outDir), `img_${String(i + 1).padStart(3, "0")}`);
        return cliImageJobRow(i + 1, p, outPathNoExt, batchId);
      });
      console.log(chalk.cyan(`Submetendo Google batch (${jobs.length} prompts)...`));
      const batchName = await submitGoogleImageBatch(jobs, { skipDb: true });
      console.log(chalk.dim(`Batch: ${batchName}`));

      while (true) {
        const { done, failed, state } = await pollGoogleBatchOnce(batchName);
        if (failed) {
          await applyGoogleBatchResults(batchName, jobs, { skipDb: true });
          throw new Error(`Google batch falhou: ${state}`);
        }
        if (done) {
          await applyGoogleBatchResults(batchName, jobs, { skipDb: true });
          console.log(chalk.green(`Batch Google concluido: ${jobs.length} imagem(ns) em ${path.resolve(outDir)}`));
          break;
        }
        console.log(chalk.dim(`Aguardando batch (${state})...`));
        await new Promise((r) => setTimeout(r, GEMINI_BATCH_POLL_INTERVAL_MS));
      }
    }
  );

program
  .command("image:sync")
  .description("Poll/download de image_jobs (HF + Gemini batch); videos HF usam higgsfield:sync")
  .addHelpText("after", CLI_HELP.imageSync)
  .option("--project <idOuSlug>", "Somente jobs deste projeto")
  .option("--provider <nome>", "all | higgsfield | gemini", "all")
  .option("--max-jobs <n>", "Maximo de jobs HF por rodada", "30")
  .option("--watch", "Repete ate nao restar job pendente em image_jobs")
  .option("--interval <dur>", "Pausa entre rodadas no --watch", "60s")
  .action(
    async (options: {
      project?: string;
      provider?: string;
      maxJobs?: string;
      watch?: boolean;
      interval?: string;
    }) => {
      let projectId: number | undefined;
      if (options.project?.trim()) {
        const p = getProjectByIdOrSlug(options.project.trim());
        if (!p) throw new Error("Projeto nao encontrado");
        projectId = Number(p.id);
      }
      const providerRaw = (options.provider ?? "all").trim().toLowerCase();
      if (!["all", "higgsfield", "gemini"].includes(providerRaw)) {
        throw new Error("--provider deve ser all, higgsfield ou gemini");
      }
      const provider = providerRaw as "all" | "higgsfield" | "gemini";
      const maxJobs = Math.max(1, parseInt(String(options.maxJobs ?? "30"), 10) || 30);
      const intervalMs = parseHfSyncIntervalMs(options.interval ?? "60s");

      const runOnce = () => syncImageJobsOnce({ projectId, maxJobs, provider });

      if (!options.watch) {
        const { processed, errors } = await runOnce();
        console.log(chalk.cyan(`image:sync: processados ${processed} lote(s)/job(s).`));
        if (errors.length > 0) {
          for (const e of errors) console.error(chalk.yellow(e));
          process.exitCode = 1;
        }
        return;
      }

      let round = 0;
      while (true) {
        const pending = countAllImageJobsPending(projectId);
        if (pending === 0) {
          console.log(chalk.green("image:sync --watch: nenhum image_job pendente; encerrando."));
          break;
        }
        round += 1;
        const { processed, errors } = await runOnce();
        console.log(
          chalk.cyan(
            `image:sync --watch [rodada ${round}] processados=${processed}, pendentes≈${countAllImageJobsPending(projectId)}`
          )
        );
        if (errors.length > 0) {
          for (const e of errors) console.error(chalk.yellow(e));
          process.exitCode = 1;
        }
        if (countAllImageJobsPending(projectId) === 0) break;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  );

program
  .command("image:batch-submit")
  .description("Submete batches Google pendentes (1 operacao por bloco) apos --enqueue-only")
  .addHelpText("after", CLI_HELP.imageBatchSubmit)
  .requiredOption("--project <idOuSlug>", "ID ou slug do projeto")
  .action(async (options: { project: string }) => {
    const p = getProjectByIdOrSlug(options.project.trim());
    if (!p) throw new Error("Projeto nao encontrado");
    const projectId = Number(p.id);
    const submitted = await submitPendingGoogleBatches(projectId);
    console.log(chalk.cyan(`image:batch-submit: ${submitted} batch(es) Google submetido(s) (projeto ${projectId}).`));
    if (submitted > 0) {
      console.log(
        chalk.yellow(`Rode: npm run gentube -- image:sync --project ${projectId} --watch --interval 60s`)
      );
    } else {
      console.log(chalk.dim("Nenhum image_job google_batch aguardando submit (sem external_id)."));
    }
  });

program
  .command("image:status")
  .description("Fila de image_jobs (HF/Gemini) e hf_cli_jobs de video por projeto")
  .addHelpText("after", CLI_HELP.imageStatus)
  .requiredOption("--project <idOuSlug>", "ID ou slug do projeto")
  .action(async (options: { project: string }) => {
    const p = getProjectByIdOrSlug(options.project.trim());
    if (!p) throw new Error("Projeto nao encontrado");
    const projectId = Number(p.id);
    const pending = countImageJobsPending(projectId);
    const pendingHf = countImageJobsPending(projectId, "higgsfield");
    const pendingGemini = countImageJobsPending(projectId, "gemini");
    const hfVideos = countHfCliJobsPending(projectId);
    console.log(chalk.cyan(`Projeto ${p.titulo} (id=${projectId})`));
    console.log(`  image_jobs pendentes: ${pending} (HF: ${pendingHf}, Gemini: ${pendingGemini})`);
    console.log(`  hf_cli_jobs pendentes (videos HF): ${hfVideos}`);
    if (pending > 0) {
      console.log(chalk.yellow(`  Rode: npm run gentube -- image:sync --project ${projectId} --watch`));
    }
    if (hfVideos > 0) {
      console.log(chalk.yellow(`  Videos HF: npm run gentube -- higgsfield:sync --project ${projectId} --watch`));
    }
    console.log(chalk.dim(`  Detalhe videos/blocos: npm run gentube -- video:status --project ${projectId}`));
  });

program
  .command("video:status")
  .description("Visao de blocos, jobs HF de video e cenas IA sem arquivo no disco")
  .addHelpText("after", CLI_HELP.videoStatus)
  .requiredOption("--project <idOuSlug>", "ID ou slug do projeto")
  .action(async (options: { project: string }) => {
    await printVideoProjectStatus(options.project);
  });

program
  .command("video:retry")
  .description("Regera videos IA em falta: HF → Veo → Magnific (padrao: credito/cota ou sem arquivo)")
  .addHelpText("after", CLI_HELP.videoRetry)
  .requiredOption("--project <idOuSlug>", "ID ou slug do projeto")
  .option("--block <n>", "Limita ao bloco N (1-based)")
  .option("--dry-run", "Lista cenas retentaveis sem chamar APIs")
  .option("--all-failed", "Inclui falhas HF que nao sao claramente credito/cota")
  .action(async (options: { project: string; block?: string; dryRun?: boolean; allFailed?: boolean }) => {
    const blockNumber = options.block !== undefined ? parseInt(options.block, 10) : undefined;
    if (options.block !== undefined && (!Number.isFinite(blockNumber!) || blockNumber! < 1)) {
      throw new Error("--block deve ser um numero >= 1");
    }
    const result = await retryMissingVideos({
      projectIdOrSlug: options.project,
      blockNumber,
      creditsOnly: !options.allFailed,
      dryRun: Boolean(options.dryRun),
    });
    console.log(
      chalk.cyan(
        `\nvideo:retry: tentados=${result.attempted}, ok=${result.succeeded}, falhas=${result.failed.length}`
      )
    );
    if (result.failed.length > 0) {
      for (const f of result.failed) {
        console.log(chalk.red(`  bloco ${f.shot.blockNumber} ${f.shot.shotId}: ${f.error}`));
      }
      process.exitCode = 1;
    }
  });

program
  .command("higgsfield:sync")
  .description("Poll/download hf_cli_jobs (videos IA e thumbs HF); imagens → image:sync")
  .addHelpText("after", CLI_HELP.higgsfieldSync)
  .option("--project <idOuSlug>", "Somente jobs deste projeto (omitir = todos os pendentes)")
  .option("--max-jobs <n>", "Maximo de jobs a processar por rodada", "30")
  .option("--watch", "Repete ate nao restar job com outcome=pending (Ctrl+C encerra)")
  .option("--interval <dur>", "Pausa entre rodadas no --watch (ex.: 15s, 2m, 45 = 45s)", "30s")
  .action(async (options: { project?: string; maxJobs?: string; watch?: boolean; interval?: string }) => {
    let projectId: number | undefined;
    if (options.project?.trim()) {
      const p = getProjectByIdOrSlug(options.project.trim());
      if (!p) throw new Error("Projeto nao encontrado");
      projectId = Number(p.id);
    }
    const maxJobs = Math.max(1, parseInt(String(options.maxJobs ?? "30"), 10) || 30);
    const intervalMs = parseHfSyncIntervalMs(options.interval);

    const runOnce = async (): Promise<{ processed: number; errors: string[] }> => {
      return syncHiggsfieldCliJobsOnce({ projectId, maxJobs });
    };

    if (!options.watch) {
      const { processed, errors } = await runOnce();
      console.log(chalk.cyan(`HF sync: processados ${processed} job(s).`));
      if (errors.length > 0) {
        for (const e of errors) console.error(chalk.yellow(e));
        process.exitCode = 1;
      }
      return;
    }

    let round = 0;
    while (true) {
      const pending = countHfCliJobsPending(projectId);
      if (pending === 0) {
        console.log(chalk.green("HF sync --watch: nenhum job pendente; encerrando."));
        break;
      }
      round += 1;
      const { processed, errors } = await runOnce();
      console.log(
        chalk.cyan(
          `HF sync --watch [rodada ${round}] processados=${processed}, pendentes restantes≈${countHfCliJobsPending(projectId)}`
        )
      );
      if (errors.length > 0) {
        for (const e of errors) console.error(chalk.yellow(e));
        process.exitCode = 1;
      }
      if (countHfCliJobsPending(projectId) === 0) {
        console.log(chalk.green("HF sync --watch: todos os jobs concluidos ou falharam (sem pendencias)."));
        break;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  });

program
  .command("copy-cmd")
  .description(
    "Imprime o comando rsync para copiar os arquivos do projeto para a maquina local (cole no terminal local)"
  )
  .requiredOption("--project <idOuSlug>", "ID ou slug do projeto")
  .option("--remote-host <host>", "Host remoto (ex.: dev-development). Ou defina GENTUBE_REMOTE_HOST no .env")
  .option("--local-dir <caminho>", "Diretorio local de destino (padrao: mesmo caminho relativo)")
  .option("--dry-run", "Adiciona --dry-run ao rsync (simula sem copiar)")
  .action(async (options: { project: string; remoteHost?: string; localDir?: string; dryRun?: boolean }) => {
    const project = getProjectByIdOrSlug(options.project);
    if (!project) throw new Error("Projeto nao encontrado");

    const remoteHost = options.remoteHost?.trim() || (process.env.GENTUBE_REMOTE_HOST ?? "").trim();
    if (!remoteHost) {
      console.error(chalk.red("Informe --remote-host ou defina GENTUBE_REMOTE_HOST no .env"));
      console.error(chalk.dim("Exemplo: npm run gentube -- copy-cmd --project 3 --remote-host dev-development"));
      process.exitCode = 1;
      return;
    }

    const remotePath = String(project.project_path);
    const remotePathTrailing = remotePath.endsWith("/") ? remotePath : `${remotePath}/`;

    let localPath: string;
    if (options.localDir?.trim()) {
      localPath = options.localDir.trim();
    } else {
      const relPath = path.relative(ROOT_DIR, remotePath);
      localPath = `./${relPath}/`;
    }

    const flags = ["rsync", "-avz", "--progress"];
    if (options.dryRun) flags.push("--dry-run");
    flags.push(`${remoteHost}:${remotePathTrailing}`, localPath);

    console.log(chalk.cyan(`Projeto: ${project.titulo} (${project.slug})`));
    console.log(chalk.dim(`Remoto:  ${remoteHost}:${remotePathTrailing}`));
    console.log(chalk.dim(`Local:   ${localPath}`));
    console.log();
    console.log(chalk.bold("Comando (cole no terminal local):"));
    console.log();
    console.log(flags.join(" "));
  });

program
  .command("delete-project")
  .description("Remove a pasta do projeto e os registros no banco (dupla confirmacao). Nao remove o canal")
  .requiredOption("--project <idOuSlug>", "ID ou slug do projeto a apagar")
  .option("-y, --yes", "Confirma sem perguntar (uso em scripts / CI)")
  .action(async (options: { project: string; yes?: boolean }) => {
    const project = getProjectByIdOrSlug(options.project);
    if (!project) throw new Error("Projeto nao encontrado");
    if (!options.yes) {
      const confirm1 = await confirm({ message: `Confirma exclusao do projeto "${project.titulo}"?`, default: false });
      if (!confirm1) return;
      const confirm2 = await confirm({ message: "Tem certeza absoluta? Esta acao e irreversivel.", default: false });
      if (!confirm2) return;
    }

    await fs.rm(String(project.project_path), { recursive: true, force: true });
    deleteProject(Number(project.id));
    console.log(chalk.green("Projeto removido com sucesso."));
  });

program
  .command("retry")
  .description("Reprocessa roteiro | narracao | imagens | thumbnails (etapa ou --block N)")
  .addHelpText("after", CLI_HELP.retry)
  .requiredOption("--project <idOuSlug>", "ID ou slug do projeto")
  .requiredOption("--stage <etapa>", "Etapa: roteiro | narracao | imagens | thumbnails")
  .option("--block <N>", "Somente o bloco N (base 1). Sem esta opcao, refaz todos os blocos da etapa")
  .option("--voice-id <id>", "Obrigatorio implicitamente para narracao: .env ou flag")
  .option("--avatar-file <caminho>", "Opcional para stage imagens/thumbnails: avatar de consistencia")
  .option("--reference-url <url>", "Stage thumbnails: URL do video YouTube como referencia")
  .option("--count <n>", "Stage thumbnails: quantidade de thumbnails (padrao 2)", "2")
  .option("--prompt <texto>", "Stage thumbnails: prompt customizado para o Higgsfield")
  .option("--max-videos-block1 <n>", `Max videos bloco 1 (padrao ${DEFAULT_MAX_VIDEOS_BLOCK1})`)
  .option("--max-images-block1 <n>", `Max imagens bloco 1 (padrao ${DEFAULT_MAX_IMAGES_BLOCK1})`)
  .option("--max-videos-other <n>", `Max videos blocos 2..N (padrao ${DEFAULT_MAX_VIDEOS_OTHER_BLOCKS})`)
  .option("--max-images-other <n>", `Max imagens blocos 2..N (padrao ${DEFAULT_MAX_IMAGES_OTHER_BLOCKS})`)
  .option(
    "--prompt-matrix <ficheiro>",
    "Stage roteiro: ficheiro em Prompts/ (ex.: matriz_tutorial.md). Sobrescreve GENTUBE_PROMPT_MATRIX"
  )
  .option(
    "--prompt-canal-voice <ficheiro>",
    "Stage roteiro bloco 1: voz do canal (Prompts/). Sobrescreve GENTUBE_PROMPT_CANAL_VOICE"
  )
  .option("--scene-plan-v2", "Stage imagens: plano por cenas (schema 2.0)")
  .option("--google-batch-mode", "Stage imagens/thumbnails: Batch API Google")
  .option("--batch-local", "Stage imagens/thumbnails: batch local Gemini (testes)")
  .option("--plan-only", "Stage imagens v2: so plano Claude (exige --scene-plan-v2)")
  .option("--enqueue-only", "Stage imagens v2: enqueue + submit batch no fim (exige --scene-plan-v2)")
  .action(
    async (options: {
      project: string;
      stage: "roteiro" | "narracao" | "imagens" | "thumbnails";
      block?: string;
      voiceId?: string;
      avatarFile?: string;
      referenceUrl?: string;
      count?: string;
      prompt?: string;
      maxVideosBlock1?: string;
      maxImagesBlock1?: string;
      maxVideosOther?: string;
      maxImagesOther?: string;
      promptMatrix?: string;
      promptCanalVoice?: string;
      scenePlanV2?: boolean;
      googleBatchMode?: boolean;
      batchLocal?: boolean;
      planOnly?: boolean;
      enqueueOnly?: boolean;
    }) => {
      const project = getProjectByIdOrSlug(options.project);
      if (!project) throw new Error("Projeto nao encontrado");

      let blockNumber: number | undefined;
      if (options.block !== undefined && options.block !== "") {
        blockNumber = parseInt(options.block, 10);
        if (Number.isNaN(blockNumber) || blockNumber < 1) {
          throw new Error("--block deve ser um numero inteiro >= 1");
        }
      }

      if (options.stage === "roteiro") {
        if (blockNumber !== undefined) {
          await executeRoteiroBlock(project, blockNumber, options.promptMatrix, options.promptCanalVoice);
        } else {
          await executeRoteiro(project, options.promptMatrix, options.promptCanalVoice);
        }
        return;
      }
      if (options.stage === "imagens") {
        const limits = parseStep3Limits(options);
        const imagensOpts = buildImagensVideosOpts(options);
        if (blockNumber !== undefined) {
          await executeImagensBlock(project, blockNumber, options.avatarFile, limits, imagensOpts);
        } else {
          await executeImagens(project, options.avatarFile, limits, imagensOpts);
        }
        return;
      }
      if (options.stage === "thumbnails") {
        const imageFlags = imageRunFlagsFromCli(options);
        await executeThumbnails(
          project,
          options.referenceUrl,
          options.avatarFile,
          options.count,
          options.prompt,
          imageFlags
        );
        return;
      }

      const voiceId = await resolveVoiceId(options.voiceId);
      if (blockNumber !== undefined) {
        await executeNarracaoBlock(project, voiceId, blockNumber);
      } else {
        await executeNarracao(project, voiceId);
      }
    }
  );

function resolveScenePlanV2(cliFlag?: boolean): boolean {
  if (cliFlag === true) return true;
  return ["1", "true", "yes"].includes(String(process.env.GENTUBE_SCENE_PLAN_V2 ?? "").toLowerCase());
}

async function executeRoteiro(project: ProjectRow, promptMatrix?: string, promptCanalVoice?: string): Promise<void> {
  const spinner = ora("Gerando roteiro...").start();
  try {
    await runRoteiro(project, {
      promptMatrix: promptMatrix?.trim() || undefined,
      promptCanalVoice: promptCanalVoice?.trim() || undefined,
    });
    spinner.succeed("Roteiro gerado com sucesso.");
  } catch (error) {
    spinner.fail("Falha na geracao do roteiro.");
    throw error;
  }
}

async function executeNarracao(project: ProjectRow, voiceId: string): Promise<void> {
  const spinner = ora("Gerando narracao...").start();
  try {
    await runNarracao(project, voiceId);
    spinner.succeed("Narracao gerada com sucesso.");
  } catch (error) {
    spinner.fail("Falha na geracao da narracao.");
    throw error;
  }
}

function buildImagensVideosOpts(options: {
  scenePlanV2?: boolean;
  googleBatchMode?: boolean;
  batchLocal?: boolean;
  planOnly?: boolean;
  enqueueOnly?: boolean;
}): ImagensVideosOptions {
  assertImagensPhaseFlagsExclusive(options);
  return {
    scenePlanV2: resolveScenePlanV2(options.scenePlanV2),
    imageFlags: imageRunFlagsFromCli(options),
    planOnly: Boolean(options.planOnly),
    enqueueOnly: Boolean(options.enqueueOnly),
  };
}

async function executeImagens(
  project: ProjectRow,
  avatarFile?: string,
  limits?: Step3Limits,
  opts?: ImagensVideosOptions,
): Promise<void> {
  try {
    const avatarAbs = avatarFile ? path.resolve(process.cwd(), avatarFile) : undefined;
    await runImagensVideos(project, avatarAbs, limits, opts);
    console.log(chalk.green.bold("Step 3 (imagens/videos) concluido com sucesso."));
  } catch (error) {
    console.log(chalk.red.bold("Falha no step 3 (imagens/videos)."));
    throw error;
  }
}

async function executeRoteiroBlock(
  project: ProjectRow,
  blockNumber: number,
  promptMatrix?: string,
  promptCanalVoice?: string
): Promise<void> {
  const spinner = ora(`Gerando roteiro — bloco ${blockNumber}...`).start();
  try {
    await runRoteiroBlock(project, blockNumber, {
      promptMatrix: promptMatrix?.trim() || undefined,
      promptCanalVoice: promptCanalVoice?.trim() || undefined,
    });
    spinner.succeed(`Bloco ${blockNumber} do roteiro gerado.`);
  } catch (error) {
    spinner.fail(`Falha no bloco ${blockNumber} do roteiro.`);
    throw error;
  }
}

async function executeNarracaoBlock(project: ProjectRow, voiceId: string, blockNumber: number): Promise<void> {
  const spinner = ora(`Gerando narracao — bloco ${blockNumber}...`).start();
  try {
    await runNarracaoBlock(project, voiceId, blockNumber);
    spinner.succeed(`Audio do bloco ${blockNumber} gerado.`);
  } catch (error) {
    spinner.fail(`Falha no audio do bloco ${blockNumber}.`);
    throw error;
  }
}

async function executeThumbnails(
  project: ProjectRow,
  referenceUrl?: string,
  avatarFile?: string,
  countRaw?: string,
  prompt?: string,
  imageFlags?: ReturnType<typeof imageRunFlagsFromCli>,
): Promise<void> {
  const count = Math.max(1, parseInt(countRaw ?? "2", 10) || 2);
  const avatarAbs = avatarFile ? path.resolve(process.cwd(), avatarFile) : undefined;
  try {
    await runThumbnails(project, { referenceUrl, avatarPath: avatarAbs, count, prompt, imageFlags });
  } catch (error) {
    console.log(chalk.red.bold("Falha na geracao de thumbnails."));
    throw error;
  }
}

async function executeImagensBlock(
  project: ProjectRow,
  blockNumber: number,
  avatarFile?: string,
  limits?: Step3Limits,
  opts?: ImagensVideosOptions,
): Promise<void> {
  try {
    const avatarAbs = avatarFile ? path.resolve(process.cwd(), avatarFile) : undefined;
    await runImagensVideosBlock(project, blockNumber, avatarAbs, limits, opts);
    console.log(chalk.green.bold(`Step 3 do bloco ${blockNumber} concluido.`));
  } catch (error) {
    console.log(chalk.red.bold(`Falha no step 3 do bloco ${blockNumber}.`));
    throw error;
  }
}

function parsePositiveInt(value: string | undefined, fallback: number, flagName: string): number {
  if (value === undefined || value === "") return fallback;
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`${flagName} deve ser inteiro >= 0`);
  }
  return n;
}

function parseStep3Limits(options: {
  maxVideosBlock1?: string;
  maxImagesBlock1?: string;
  maxVideosOther?: string;
  maxImagesOther?: string;
}): Step3Limits {
  // Fallbacks DEFAULT_* leem GENTUBE_MAX_* no .env (src/config.ts). Flags CLI substituem quando passadas.
  const parsed: Step3Limits = {
    maxVideosBlock1: parsePositiveInt(options.maxVideosBlock1, DEFAULT_MAX_VIDEOS_BLOCK1, "--max-videos-block1"),
    maxImagesBlock1: parsePositiveInt(options.maxImagesBlock1, DEFAULT_MAX_IMAGES_BLOCK1, "--max-images-block1"),
    maxVideosOtherBlocks: parsePositiveInt(options.maxVideosOther, DEFAULT_MAX_VIDEOS_OTHER_BLOCKS, "--max-videos-other"),
    maxImagesOtherBlocks: parsePositiveInt(options.maxImagesOther, DEFAULT_MAX_IMAGES_OTHER_BLOCKS, "--max-images-other"),
  };
  if (parsed.maxImagesOtherBlocks <= parsed.maxVideosOtherBlocks) {
    throw new Error("Politica invalida: --max-images-other deve ser maior que --max-videos-other");
  }
  return parsed;
}

async function executeAll(
  project: ProjectRow,
  voiceIdFromArg?: string,
  promptMatrix?: string,
  promptCanalVoice?: string
): Promise<void> {
  await executeRoteiro(project, promptMatrix, promptCanalVoice);
  const voiceId = await resolveVoiceId(voiceIdFromArg);
  const updatedProject = getProjectByIdOrSlug(String(project.id));
  if (!updatedProject) throw new Error("Projeto nao encontrado apos etapa de roteiro");
  await executeNarracao(updatedProject, voiceId);
  addProjectLog(Number(project.id), "pipeline", "info", "Execucao sequencial finalizada");
}

async function resolveVoiceId(cliVoiceId?: string): Promise<string> {
  const fromCli = cliVoiceId?.trim();
  if (fromCli) return fromCli;
  if (ELEVENLABS_VOICE_ID) return ELEVENLABS_VOICE_ID;
  return password({ message: "Informe voice_id da ElevenLabs:", mask: "*" });
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.log(chalk.cyan.bold("GenTube CLI ") + chalk.dim(`v${VERSION}`));
  console.log(
    chalk.white(
      "Roteiro (Claude) + narracao (ElevenLabs), um projeto por pasta em Videos/<canal>/<data>-<titulo>/."
    )
  );
  console.log(chalk.dim("\nComece com: ") + chalk.green.bold("npm run gentube -- init"));
  console.log(chalk.dim("Ajuda: ") + chalk.green("npm run gentube -- --help") + chalk.dim(" ou ") + chalk.green("npm run gentube -- help\n"));
  program.outputHelp();
  process.exit(0);
}

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Erro desconhecido";
  console.error(chalk.red(`Erro: ${message}`));
  process.exitCode = 1;
});


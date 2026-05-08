#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { confirm, input, number, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { DEFAULT_BLOCKS, ELEVENLABS_VOICE_ID, VIDEOS_DIR } from "./config.js";
import { getPackageVersion } from "./version.js";
import { getDb } from "./db.js";
import {
  addProjectLog,
  createChannel,
  createProject,
  deleteProject,
  getProjectByIdOrSlug,
  listChannels,
} from "./repository.js";
import { runInit } from "./init-setup.js";
import { runNarracao, runNarracaoBlock, runRoteiro, runRoteiroBlock } from "./services/pipeline.js";
import { ensureDir, ensureTemplateStructure, formatDateYYYYMMDD, toSlug, writeModelagemTranscript } from "./utils/fs.js";

type ProjectRow = Record<string, unknown>;

getDb();

const VERSION = getPackageVersion();

const program = new Command();
program
  .name("gentube")
  .description(
    "Organiza projetos de video por canal, gera roteiro (Claude) e narracao (ElevenLabs), " +
      "com status no SQLite. Veja o README.md para o fluxo completo."
  )
  .version(VERSION, "-V, --version", "Exibe a versao e encerra")
  .helpOption("-h, --help", "Exibe ajuda geral (ou use: help <comando>)");

program.configureHelp({ sortSubcommands: true });

program.helpCommand(
  "help [comando]",
  "Mostra esta ajuda ou a ajuda de um subcomando (ex.: help run-step)"
);

program.addHelpText(
  "after",
  `
${chalk.bold("Exemplos")}
  npm run gentube -- init
  npm run gentube -- channel:list
  npm run gentube -- create-video
  npm run gentube -- run-step --project 1 --step roteiro
  npm run gentube -- run-all --project 1
  npm run gentube -- status --project 20260508-meu-video
  npm run gentube -- retry --project 1 --stage narracao --block 2

${chalk.bold("Documentacao")}  README.md  ·  ESPECIFICACAO_TECNICA.md
`.trimStart()
);

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

type CreateVideoCliOptions = {
  channel?: string;
  title?: string;
  niche?: string;
  audience?: string;
  blocks?: string;
  transcriptFile?: string;
  transcriptText?: string;
  mode?: string;
};

program
  .command("create-video")
  .description(
    "Cria projeto de video: interativo, ou preencha com flags (--channel, --title, --transcript-file, etc.)"
  )
  .option("--channel <id>", "ID do canal (channel:list). Sem flag, abre menu")
  .option("--title <texto>", "Titulo do video")
  .option("--niche <texto>", "Nicho ([NOME DO NICHO] no matriz.md)")
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
      await executeAll(project);
    } else {
      console.log(chalk.cyan("Projeto criado. Use run-step para executar as etapas."));
    }
  });

program
  .command("run-step")
  .description("Roda apenas roteiro ou apenas narracao de um projeto ja criado")
  .requiredOption("--project <idOuSlug>", "ID numerico (ex.: 1) ou slug da pasta (ex.: 20260508-meu-titulo)")
  .requiredOption("--step <etapa>", "roteiro | narracao (narração exige roteiro completo com sucesso)")
  .option("--voice-id <id>", "Voice ElevenLabs; se omitido, usa ELEVENLABS_VOICE_ID do .env ou pede no terminal")
  .action(async (options: { project: string; step: "roteiro" | "narracao"; voiceId?: string }) => {
    const project = getProjectByIdOrSlug(options.project);
    if (!project) throw new Error("Projeto nao encontrado");

    if (options.step === "roteiro") {
      await executeRoteiro(project);
      return;
    }
    const voiceId = await resolveVoiceId(options.voiceId);
    await executeNarracao(project, voiceId);
  });

program
  .command("run-all")
  .description("Pipeline completo: roteiro todos os blocos, depois narracao (mesma ordem que create-video sequencial)")
  .requiredOption("--project <idOuSlug>", "ID ou slug do projeto em video_projects")
  .option("--voice-id <id>", "Voice ElevenLabs (ou .env ELEVENLABS_VOICE_ID)")
  .action(async (options: { project: string; voiceId?: string }) => {
    const project = getProjectByIdOrSlug(options.project);
    if (!project) throw new Error("Projeto nao encontrado");
    const voiceId = await resolveVoiceId(options.voiceId);
    await executeAll(project, voiceId);
  });

program
  .command("status")
  .description("Resumo das etapas (roteiro, narracao, etc.) e caminho da pasta do projeto")
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
  .description("Gera de novo roteiro ou narracao (etapa inteira ou so um bloco com --block)")
  .requiredOption("--project <idOuSlug>", "ID ou slug do projeto")
  .requiredOption("--stage <etapa>", "roteiro | narracao")
  .option("--block <N>", "Somente o bloco N (base 1). Sem esta opcao, refaz todos os blocos da etapa")
  .option("--voice-id <id>", "Obrigatorio implicitamente para narracao: .env ou flag")
  .action(
    async (options: { project: string; stage: "roteiro" | "narracao"; block?: string; voiceId?: string }) => {
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
          await executeRoteiroBlock(project, blockNumber);
        } else {
          await executeRoteiro(project);
        }
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

async function executeRoteiro(project: ProjectRow): Promise<void> {
  const spinner = ora("Gerando roteiro...").start();
  try {
    await runRoteiro(project);
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

async function executeRoteiroBlock(project: ProjectRow, blockNumber: number): Promise<void> {
  const spinner = ora(`Gerando roteiro — bloco ${blockNumber}...`).start();
  try {
    await runRoteiroBlock(project, blockNumber);
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

async function executeAll(project: ProjectRow, voiceIdFromArg?: string): Promise<void> {
  await executeRoteiro(project);
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


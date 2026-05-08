#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { confirm, input, number, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { DEFAULT_BLOCKS, VIDEOS_DIR } from "./config.js";
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
import { ensureDir, ensureTemplateStructure, formatDateYYYYMMDD, toSlug } from "./utils/fs.js";

type ProjectRow = Record<string, unknown>;

getDb();

const program = new Command();
program.name("gentube").description("CLI para geracao de projetos de video do GenTube").version("0.1.0");

program
  .command("init")
  .description("Configuracao guiada inicial (.env, pastas, canal opcional)")
  .action(async () => {
    await runInit();
  });

program
  .command("channel:create")
  .description("Cadastra um novo canal")
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
  .description("Lista canais cadastrados")
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
  .command("create-video")
  .description("Cria um projeto de video e permite executar as etapas")
  .action(async () => {
    const channels = listChannels();
    if (channels.length === 0) {
      console.log(chalk.red("Nao existe canal cadastrado. Rode primeiro: gentube channel:create"));
      return;
    }

    const channelId = await select<number>({
      message: "Escolha o canal:",
      choices: channels.map((channel) => ({ value: channel.id, name: `[${channel.id}] ${channel.nome_canal}` })),
    });
    const selectedChannel = channels.find((c) => c.id === channelId);
    if (!selectedChannel) {
      throw new Error("Canal selecionado nao encontrado");
    }

    const titulo = await input({ message: "Titulo do video:", validate: (v) => (!!v.trim() ? true : "Informe o titulo") });
    const niche = await input({ message: "Nome do nicho ([NOME DO NICHO]):", validate: (v) => (!!v.trim() ? true : "Informe o nicho") });
    const audience = await input({ message: "Publico alvo ([PUBLICO]):", validate: (v) => (!!v.trim() ? true : "Informe o publico") });
    const customBlocks = await confirm({ message: `Deseja alterar a quantidade de blocos? (padrao ${DEFAULT_BLOCKS})`, default: false });
    const totalBlocosInput = customBlocks
      ? await number({ message: "Nova quantidade de blocos:", min: 1, max: 64, default: DEFAULT_BLOCKS })
      : DEFAULT_BLOCKS;
    const totalBlocos = totalBlocosInput ?? DEFAULT_BLOCKS;
    const hasTranscript = await confirm({ message: "Deseja informar transcricao opcional?", default: false });
    const transcript = hasTranscript ? await input({ message: "Cole a transcricao (texto livre):" }) : undefined;

    const dataProjeto = formatDateYYYYMMDD();
    const videoSlug = toSlug(titulo);
    const folderName = `${dataProjeto}-${videoSlug}`;
    const projectPath = path.join(String(selectedChannel.base_path), folderName);

    await ensureDir(projectPath);
    await ensureTemplateStructure(projectPath);

    const projectId = createProject({
      channelId,
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
    const mode = await select<"iterativo" | "sequencial">({
      message: "Modo de execucao:",
      choices: [
        { value: "iterativo", name: "Iterativo (executar etapa por etapa)" },
        { value: "sequencial", name: "Sequencial (roteiro + narracao de uma vez)" },
      ],
    });

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
  .description("Executa uma etapa especifica")
  .requiredOption("--project <idOrSlug>", "ID ou slug do projeto")
  .requiredOption("--step <roteiro|narracao>", "Etapa a executar")
  .option("--voice-id <voiceId>", "Voice ID da ElevenLabs para narracao")
  .action(async (options: { project: string; step: "roteiro" | "narracao"; voiceId?: string }) => {
    const project = getProjectByIdOrSlug(options.project);
    if (!project) throw new Error("Projeto nao encontrado");

    if (options.step === "roteiro") {
      await executeRoteiro(project);
      return;
    }
    const voiceId = options.voiceId ?? (await password({ message: "Informe voice_id da ElevenLabs:", mask: "*" }));
    await executeNarracao(project, voiceId);
  });

program
  .command("run-all")
  .description("Executa roteiro e narracao em sequencia")
  .requiredOption("--project <idOrSlug>", "ID ou slug do projeto")
  .option("--voice-id <voiceId>", "Voice ID da ElevenLabs para narracao")
  .action(async (options: { project: string; voiceId?: string }) => {
    const project = getProjectByIdOrSlug(options.project);
    if (!project) throw new Error("Projeto nao encontrado");
    const voiceId = options.voiceId ?? (await password({ message: "Informe voice_id da ElevenLabs:", mask: "*" }));
    await executeAll(project, voiceId);
  });

program
  .command("status")
  .description("Mostra o status consolidado de um projeto")
  .requiredOption("--project <idOrSlug>", "ID ou slug do projeto")
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
  .description("Apaga projeto de video (arquivos + SQLite)")
  .requiredOption("--project <idOrSlug>", "ID ou slug do projeto")
  .action(async (options: { project: string }) => {
    const project = getProjectByIdOrSlug(options.project);
    if (!project) throw new Error("Projeto nao encontrado");
    const confirm1 = await confirm({ message: `Confirma exclusao do projeto "${project.titulo}"?`, default: false });
    if (!confirm1) return;
    const confirm2 = await confirm({ message: "Tem certeza absoluta? Esta acao e irreversivel.", default: false });
    if (!confirm2) return;

    await fs.rm(String(project.project_path), { recursive: true, force: true });
    deleteProject(Number(project.id));
    console.log(chalk.green("Projeto removido com sucesso."));
  });

program
  .command("retry")
  .description("Reprocessa etapa inteira ou um bloco especifico (--block N)")
  .requiredOption("--project <idOrSlug>", "ID ou slug do projeto")
  .requiredOption("--stage <roteiro|narracao>", "Etapa")
  .option("--block <number>", "Numero do bloco (1-based); omita para reprocessar toda a etapa")
  .option("--voice-id <voiceId>", "Voice ID da ElevenLabs para narracao")
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

      const voiceId = options.voiceId ?? (await password({ message: "Informe voice_id da ElevenLabs:", mask: "*" }));
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
  const voiceId = voiceIdFromArg ?? (await password({ message: "Informe voice_id da ElevenLabs:", mask: "*" }));
  const updatedProject = getProjectByIdOrSlug(String(project.id));
  if (!updatedProject) throw new Error("Projeto nao encontrado apos etapa de roteiro");
  await executeNarracao(updatedProject, voiceId);
  addProjectLog(Number(project.id), "pipeline", "info", "Execucao sequencial finalizada");
}

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Erro desconhecido";
  console.error(chalk.red(`Erro: ${message}`));
  process.exitCode = 1;
});


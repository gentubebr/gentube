import fs from "node:fs/promises";
import path from "node:path";
import { confirm, input, password } from "@inquirer/prompts";
import chalk from "chalk";
import { ROOT_DIR, TEMPLATE_CHANNEL_DIR, VIDEOS_DIR } from "./config.js";
import { createChannel, listChannels } from "./repository.js";
import { ensureDir, toSlug } from "./utils/fs.js";

async function mergeEnv(updates: Record<string, string>): Promise<void> {
  const envPath = path.join(ROOT_DIR, ".env");
  let lines: string[] = [];
  try {
    const raw = await fs.readFile(envPath, "utf-8");
    lines = raw.split("\n");
  } catch {
    lines = [];
  }

  const keysToReplace = new Set(Object.keys(updates));
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return true;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return true;
    const key = trimmed.slice(0, eq).trim();
    return !keysToReplace.has(key);
  });

  const adds = Object.entries(updates).map(([k, v]) => `${k}=${v}`);
  const body = [...kept.filter((l) => l.length > 0 || l === ""), ...adds].join("\n").replace(/\n+$/, "");
  await fs.writeFile(envPath, `${body}\n`, "utf-8");
}

export async function runInit(): Promise<void> {
  console.log(chalk.cyan.bold("GenTube — configuracao inicial"));
  console.log(chalk.dim(`Pasta do projeto: ${ROOT_DIR}\n`));

  await ensureDir(VIDEOS_DIR);
  console.log(chalk.green(`Pasta Videos pronta: ${VIDEOS_DIR}`));

  try {
    await fs.access(TEMPLATE_CHANNEL_DIR);
    console.log(chalk.green(`Template de canal encontrado: ${TEMPLATE_CHANNEL_DIR}`));
  } catch {
    console.log(chalk.yellow(`Aviso: template nao encontrado em ${TEMPLATE_CHANNEL_DIR}`));
  }

  const examplePath = path.join(ROOT_DIR, ".env.example");
  const envPath = path.join(ROOT_DIR, ".env");
  try {
    await fs.access(envPath);
  } catch {
    try {
      await fs.copyFile(examplePath, envPath);
      console.log(chalk.green("Arquivo .env criado a partir de .env.example"));
    } catch {
      await fs.writeFile(
        envPath,
        "CLAUDE_API_KEY=\nELEVENLABS_API_KEY=\n",
        "utf-8"
      );
      console.log(chalk.green("Arquivo .env criado (vazio)"));
    }
  }

  const fillKeys = await confirm({
    message: "Deseja informar ou atualizar CLAUDE_API_KEY e ELEVENLABS_API_KEY agora?",
    default: true,
  });

  if (fillKeys) {
    const claude = await password({ message: "Claude API key:", mask: "*" });
    const eleven = await password({ message: "ElevenLabs API key:", mask: "*" });
    const updates: Record<string, string> = {};
    if (claude.trim()) updates.CLAUDE_API_KEY = claude.trim();
    if (eleven.trim()) updates.ELEVENLABS_API_KEY = eleven.trim();
    if (Object.keys(updates).length > 0) {
      await mergeEnv(updates);
      console.log(chalk.green("Chaves gravadas em .env"));
      console.log(chalk.dim("Reabra o terminal ou rode o comando novamente para recarregar variaveis, se necessario."));
    }
  }

  const createChannelNow = await confirm({
    message: "Deseja cadastrar um canal agora?",
    default: listChannels().length === 0,
  });

  if (createChannelNow) {
    const nomeCanal = await input({
      message: "Nome do canal:",
      validate: (v) => (!!v.trim() ? true : "Informe o nome do canal"),
    });
    const slugCanal = toSlug(nomeCanal);
    const basePath = path.join(VIDEOS_DIR, slugCanal);
    await ensureDir(basePath);
    const id = createChannel(nomeCanal, slugCanal, basePath);
    console.log(chalk.green(`Canal criado (id: ${id}, slug: ${slugCanal})`));
  }

  console.log(chalk.cyan("\nProximos passos:"));
  console.log("  npm run gentube -- channel:list");
  console.log("  npm run gentube -- create-video");
  console.log(chalk.dim("  npm run gentube -- --help   ") + chalk.dim("# lista todos os comandos"));
  console.log(chalk.dim("  npm run gentube -- help run-step   ") + chalk.dim("# ajuda de um comando"));
}

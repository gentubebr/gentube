import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { execSync, spawn } from "node:child_process";
import {
  HIGGSFIELD_AGENTS_BASE_URL,
  HIGGSFIELD_CLI_PATH,
  ROOT_DIR,
  higgsfieldCliCredentialsPath,
} from "../config.js";

function isExecutableFile(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cliente minimalista para a API `fnf.higgsfield.ai` (mesma familia do binario `hf`):
 * Bearer com tokens do arquivo credentials.json do CLI.
 *
 * Diferente de `higgsfield.ts`, que usa `platform.higgsfield.ai` + API Key (Key id:secret).
 */

export type HiggsfieldCliCredentials = {
  access_token: string;
  refresh_token?: string;
};

export type HiggsfieldAccountStatus = {
  email: string;
  credits: number;
  subscription_plan_type: string;
};

/** Argumentos apos o subcomando gentube (ex.: apos `higgsfield:generate`). */
export function forwardArgvAfterSubcommand(subcommand: string): string[] {
  const argv = process.argv;
  const idx = argv.indexOf(subcommand);
  if (idx === -1) {
    throw new Error(`Subcomando nao encontrado na linha de comando: ${subcommand}`);
  }
  const rest = argv.slice(idx + 1);
  if (rest[0] === "--") return rest.slice(1);
  return rest;
}

/** Resolve executavel do CLI oficial (hf / higgsfield). */
export function resolveHiggsfieldCliBinary(): string {
  if (HIGGSFIELD_CLI_PATH) {
    if (!isExecutableFile(HIGGSFIELD_CLI_PATH)) {
      throw new Error(
        `HIGGSFIELD_CLI_PATH nao aponta para um executavel valido: ${HIGGSFIELD_CLI_PATH}`
      );
    }
    return HIGGSFIELD_CLI_PATH;
  }

  for (const name of ["hf", "higgsfield"]) {
    try {
      const out = execSync(`command -v ${name}`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (out) return out;
    } catch {
      /* tenta proximo nome */
    }
  }

  const staticCandidates = [
    path.join(ROOT_DIR, "node_modules", "@higgsfield", "cli", "vendor", "hf"),
    path.join(homedir(), ".local", "bin", "hf"),
    path.join(homedir(), ".local", "bin", "higgsfield"),
    "/usr/local/bin/hf",
    "/usr/local/bin/higgsfield",
    "/opt/homebrew/bin/hf",
    "/opt/homebrew/bin/higgsfield",
  ];
  for (const p of staticCandidates) {
    if (isExecutableFile(p)) return p;
  }

  try {
    const prefix = execSync("npm prefix -g", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (prefix) {
      for (const name of ["hf", "higgsfield"]) {
        const p = path.join(prefix, "bin", name);
        if (isExecutableFile(p)) return p;
      }
    }
  } catch {
    /* ignora */
  }

  throw new Error(
    "Binario hf/higgsfield nao encontrado. Instale o CLI (curl/npm/brew), " +
      "adicione-o ao PATH, ou defina HIGGSFIELD_CLI_PATH para o executavel (ex.: o arquivo `hf` extraido do .tar.gz)."
  );
}

/**
 * Executa o binario hf com argumentos completos (ex.: `['generate','create', jobSet, ...]`).
 * stdio herdado (progresso e URLs com --wait aparecem no terminal).
 */
export function runHiggsfieldCli(hfArgv: string[]): Promise<number> {
  const bin = resolveHiggsfieldCliBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, hfArgv, {
      stdio: "inherit",
      env: process.env,
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Higgsfield CLI encerrado por sinal: ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export function loadHiggsfieldCliCredentials(): HiggsfieldCliCredentials {
  const file = higgsfieldCliCredentialsPath();
  const raw = fs.readFileSync(file, "utf8");
  const data = JSON.parse(raw) as unknown;
  if (typeof data !== "object" || data === null) {
    throw new Error(`credentials Higgsfield invalidas (nao-objeto): ${file}`);
  }
  const access = (data as Record<string, unknown>).access_token;
  if (typeof access !== "string" || !access) {
    throw new Error(`credentials Higgsfield sem access_token: ${file}`);
  }
  const refresh = (data as Record<string, unknown>).refresh_token;
  return {
    access_token: access,
    refresh_token: typeof refresh === "string" ? refresh : undefined,
  };
}

async function agentsFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = loadHiggsfieldCliCredentials().access_token;
  const url = `${HIGGSFIELD_AGENTS_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

/** GET /agents/balance — mesmo dado que `hf account status --json`. */
export async function fetchAccountStatus(): Promise<HiggsfieldAccountStatus> {
  const res = await agentsFetch("/agents/balance", { method: "GET" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Higgsfield account status falhou (${res.status}): ${body}`);
  }
  const data = (await res.json()) as unknown;
  if (typeof data !== "object" || data === null) {
    throw new Error("Resposta /agents/balance invalida");
  }
  const o = data as Record<string, unknown>;
  const email = o.email;
  const credits = o.credits;
  const plan = o.subscription_plan_type;
  if (typeof email !== "string" || typeof credits !== "number" || typeof plan !== "string") {
    throw new Error("Formato inesperado em /agents/balance");
  }
  return { email, credits, subscription_plan_type: plan };
}

/** GET /agents/models — catalogo (detalhes dependem do backend). */
export async function fetchModelsList(): Promise<unknown> {
  const res = await agentsFetch("/agents/models", { method: "GET" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Higgsfield models falhou (${res.status}): ${body}`);
  }
  return res.json() as Promise<unknown>;
}

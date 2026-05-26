import chalk from "chalk";

/** Logs detalhados: `GENTUBE_VERBOSE=1` ou flag CLI `--verbose`. */
export function gentubeVerboseEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(process.env.GENTUBE_VERBOSE ?? "").trim().toLowerCase(),
  );
}

export function setGentubeVerboseFromCli(verbose?: boolean): void {
  if (verbose) {
    process.env.GENTUBE_VERBOSE = "1";
  }
}

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

export function verboseInfo(message: string): void {
  if (!gentubeVerboseEnabled()) return;
  console.log(chalk.cyan(`[${ts()}] ${message}`));
}

export function verboseDim(message: string): void {
  if (!gentubeVerboseEnabled()) return;
  console.log(chalk.dim(`[${ts()}] ${message}`));
}

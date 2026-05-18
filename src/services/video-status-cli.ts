import chalk from "chalk";
import { getProjectByIdOrSlug } from "../repository.js";
import {
  buildVideoProjectStatus,
  formatBlockLine,
  listRetryableMissingVideos,
} from "./video-project-status.js";

export async function printVideoProjectStatus(projectIdOrSlug: string): Promise<void> {
  const project = getProjectByIdOrSlug(projectIdOrSlug.trim());
  if (!project) throw new Error("Projeto nao encontrado");
  const projectId = Number(project.id);
  const projectPath = String(project.project_path);

  const report = await buildVideoProjectStatus(projectId, projectPath);
  const retryable = listRetryableMissingVideos(report, { creditsOnly: true });

  console.log(chalk.cyan(`\nProjeto: ${project.titulo} (id=${projectId})`));
  console.log(chalk.dim(`Pasta: ${projectPath}\n`));

  if (report.lastActivityBlock) {
    const b = report.lastActivityBlock;
    console.log(
      chalk.bold("Ultimo bloco com atividade:") +
        ` bloco ${String(b.block_number).padStart(2, "0")} — renders=${b.renders_status}` +
        (b.renders_total_count > 0 ? ` (${b.renders_done_count}/${b.renders_total_count})` : "")
    );
    if (b.finished_at) console.log(chalk.dim(`  finalizado em: ${b.finished_at}`));
    if (b.plan_error) console.log(chalk.yellow(`  aviso: ${b.plan_error}`));
  } else {
    console.log(chalk.dim("Ultimo bloco com atividade: (nenhum)"));
  }

  if (report.lastSuccessBlock) {
    const b = report.lastSuccessBlock;
    console.log(
      chalk.bold("Ultimo bloco concluido (success):") +
        ` bloco ${String(b.block_number).padStart(2, "0")}`
    );
  } else {
    console.log(chalk.dim("Ultimo bloco concluido: (nenhum)"));
  }

  console.log(chalk.bold("\nHF videos (hf_cli_jobs):"));
  console.log(`  pendentes: ${report.hfPending}`);
  console.log(`  falhos (provavel credito/cota): ${chalk.yellow(String(report.hfFailedCredits))}`);
  console.log(`  falhos (outros): ${report.hfFailedOther}`);

  const missingNoFile = report.missingVideos.filter((m) => m.reason === "no_file").length;
  const missingPending = report.missingVideos.filter((m) => m.reason === "hf_pending").length;
  console.log(chalk.bold("\nVideos IA sem arquivo no disco:"));
  console.log(`  total: ${report.missingVideos.length} (pendente HF: ${missingPending}, sem job/arquivo: ${missingNoFile})`);

  if (retryable.length > 0) {
    console.log(chalk.bold(`\nRetentaveis (credito / sem arquivo) — ${retryable.length}:`));
    for (const m of retryable.slice(0, 30)) {
      const extra = m.errorMessage ? chalk.dim(` — ${m.errorMessage.slice(0, 60)}`) : "";
      console.log(`  ${String(m.blockNumber).padStart(2, "0")}/${m.shotId}  ${chalk.yellow(m.reason)}${extra}`);
    }
    if (retryable.length > 30) {
      console.log(chalk.dim(`  ... e mais ${retryable.length - 30}`));
    }
    console.log(
      chalk.yellow(
        `\n  Rode: npm run gentube -- video:retry --project ${projectId}` +
          (report.lastActivityBlock ? ` --block ${report.lastActivityBlock.block_number}` : "")
      )
    );
    console.log(chalk.dim("  Adicione --dry-run para simular; --all-failed inclui falhas HF nao-credito"));
  } else if (report.hfPending > 0) {
    console.log(
      chalk.yellow(`\n  ${report.hfPending} job(s) ainda pendente(s). Rode: npm run gentube -- higgsfield:sync --project ${projectId} --watch`)
    );
  }

  console.log(chalk.bold("\nBlocos:"));
  for (const b of report.blocks) {
    console.log(formatBlockLine(projectId, b));
  }
  console.log("");
}

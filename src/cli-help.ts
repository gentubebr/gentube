import chalk from "chalk";

/** Texto extra apos `gentube help <comando>`. */
export function cliHelpAfter(body: string): string {
  return `\n${body.trim()}\n`;
}

const ex = (lines: string[]) => lines.map((l) => `  ${l}`).join("\n");

export const CLI_HELP = {
  main: cliHelpAfter(`
${chalk.bold("Fluxo tipico (projeto por pasta em Videos/<canal>/<data>-<titulo>/")}
  1. init · channel:create · create-video
  2. run-step --step roteiro
  3. run-step --step narracao          (ElevenLabs; ver narracao abaixo)
  4. run-step --step imagens           (--scene-plan-v2 recomendado)
  4b. cost-estimate (modo Wojak) · image:sync --watch
  5. video:status · video:retry (HF/Veo) · retry imagens (Wojak)
  6. run-step --step montagem          (FFmpeg: clipes + blocos em 06 - Montagem/)
  7. run-step --step thumbnails
  Ou: run-all (so roteiro + narracao) · retry --stage <etapa> · sync-from-disk

${chalk.bold("Etapas do projeto (--project id ou slug da pasta)")}
  roteiro     Claude → 01 - Roteiro/blockNN.md
  narracao    ElevenLabs → 02 - Narracao/ (ver help run-step)
  imagens     Plano + stock + filas → 03 - Imagens e Videos/
  montagem    FFmpeg → 06 - Montagem/ (requer plano v2 + scXX.mp3)
  thumbnails  HF/Gemini → 04 - Thumbnails/

${chalk.bold("Exemplos")}
${ex([
  "npm run gentube -- init",
  "npm run gentube -- projects:list",
  "npm run gentube -- status --project 10",
  "npm run gentube -- run-step --project 10 --step narracao",
  "npm run gentube -- run-step --project 10 --step imagens --scene-plan-v2 --google-batch-mode",
  "npm run gentube -- image:status --project 10",
  "npm run gentube -- image:sync --project 10 --watch --interval 30s",
  "npm run gentube -- video:status --project 10",
  "npm run gentube -- video:retry --project 10 --block 5",
  "npm run gentube -- retry --project 10 --stage narracao --block 3",
  "npm run gentube -- elevenlabs:status",
  "npm run gentube -- sync-from-disk --project 10 --only narracao",
  "npm run gentube -- cost-estimate --project 10",
])}

${chalk.bold("Modalidade Wojak")}  GENTUBE_VISUAL_MODALITY=wojak (ver wojak.md)
  Plano: --scene-plan-v2 --plan-only → revisar blockNN.assets.json → narracao
  Render: Gemini batch (imagens) + sync (bootstrap) + Veo (videos); sem stock/HF
  Retomada se Veo 429: npx tsx scripts/continue-missing-renders.ts --project <id> --block N
  Depois: image:sync --watch · retry --stage imagens quando cota Veo voltar

${chalk.bold("Variaveis .env frequentes")}  (detalhe em .env.example)
  CLAUDE_* · ELEVENLABS_* · GEMINI_API_KEY · GENTUBE_HF_ASYNC=1
  GENTUBE_IMAGE_DELIVERY=google_batch · GENTUBE_VIDEO_BACKEND=auto
  GENTUBE_VISUAL_MODALITY=wojak · GENTUBE_WOJAK_VEO_USE_REF=0
  GENTUBE_COST_USD_* (cost-estimate) · GEMINI_VEO_* · GENTUBE_VEO_DURATION_SECONDS

${chalk.bold("Documentacao")}  README.md · ESPECIFICACAO_TECNICA.md · wojak.md
`),

  runStep: cliHelpAfter(`
${chalk.bold("--step roteiro")}
  Gera blockNN.md com Claude. Bloco 1: opcional --prompt-canal-voice (Prompts/canal_voice.md).
  Blocos 2..N: contexto dos .md anteriores. --prompt-matrix sobrescreve GENTUBE_PROMPT_MATRIX.

${chalk.bold("--step narracao")}
  Pre-requisito: todos os blocos de roteiro em success.
  Se existir 03 - Imagens e Videos/blockNN.assets.json (schema 2.0):
    · Um MP3 por cena em 02 - Narracao/blockNN/scXX.mp3 (texto = narration_text do plano)
    · Com ffmpeg no PATH: concatena blockNN.mp3 (re-run reutiliza MP3 existentes >=1KB)
  Sem plano v2: um unico blockNN.mp3 a partir do .md do roteiro.
  Blocos ja success no SQLite sao ignorados (nao gasta ElevenLabs).
  --force-narracao  Regenera todos os scXX.mp3 (nova voz ou plano atualizado; ignora cache no disco).
  --block N  So um bloco (ex.: --step narracao --block 1).
  Voice: --voice-id ou ELEVENLABS_VOICE_ID. Cota: elevenlabs:status

${chalk.bold("--step imagens")}  (recomendado: --scene-plan-v2)
  Modo legado (sem v2): plano assets v1 por bloco, HF sync ou async.
  Modo v2 (schema 2.0): segmentacao + visualizacao Claude → blockNN.assets.json;
    stock Magnific; imagens IA → image_jobs (Gemini batch ou HF);
    videos IA: HF (kling) → fallback Veo → Magnific stock (GENTUBE_VIDEO_BACKEND=auto).
  Fases mutuamente exclusivas (exigem --scene-plan-v2):
    --plan-only      So Claude em todos os blocos (assets.json)
    --enqueue-only   Stock + filas + videos; submit N batches Google no fim
  Modo padrao v2: plano + enqueue + submit por bloco (como antes).
  Apos async/batch: image:sync --watch. Videos HF pendentes: higgsfield:sync.
  Faltantes: video:status · video:retry

${chalk.bold("Modo Wojak")}  GENTUBE_VISUAL_MODALITY=wojak + --scene-plan-v2
  Plano: so ai_generated; stock_ratio 0; validacao assertWojakBlockPlan.
  Imagens estaticas: Google Batch com PNG ref (forcado no codigo; opcao B).
  Video: bootstrap sync (scXX__bootstrap.png) → Veo sync (sem ref PNG por defeito).
  Env: GENTUBE_IMAGE_BACKEND=gemini · GENTUBE_VIDEO_BACKEND=veo · GENTUBE_HF_ASYNC=0
  Ordem: plan-only → narracao → retry/run-step imagens → image:sync --watch
  Custo antes da corrida: cost-estimate --project <id>
  Se retry parar em Veo 429: scripts/continue-missing-renders.ts + image:sync; depois retry.
  Detalhe: wojak.md

${chalk.bold("--step montagem")}  (requer scene-plan-v2 + narracao por cena)
  Combina 02 - Narracao/blockNN/scXX.mp3 + renders/blockNN/scXX.*
  Ken Burns zoom-in em imagens; xfade 0.1s (fade) entre cenas.
  Bloco completo: 06 - Montagem/blocks/blockNN.mp4
  Cenas em falta: segmentos blockNN_sc01-sc05.mp4 + blockNN.err.txt; segue proximo bloco.
  ffmpeg no PATH ou GENTUBE_FFMPEG_PATH · --force · --xfade-duration · --xfade-transition
  Fluxo em duas fases (menos tempo ate ver todos os clipes; xfade pesado por ultimo):
    run-step --step montagem --montagem-scenes-only
    run-step --step montagem --montagem-assemble-only
  Ou por bloco: acrescente --block N em cada comando.
  GENTUBE_MONTAGEM_PHASE=scenes|assemble equivale as flags acima (padrao full).
  Recomendado: montar bloco a bloco antes do step inteiro:
    run-step --step montagem --block 1
    run-step --step montagem --block 2
    … depois run-step --step montagem (todos; salta blocos ja success)

${chalk.bold("--step thumbnails")}
  --reference-url (YouTube) · --avatar-file · --count · --prompt
  --google-batch-mode ou --batch-local (mesmas regras que imagens)

${chalk.bold("Exemplos")}
${ex([
  "npm run gentube -- run-step --project 10 --step roteiro",
  "npm run gentube -- run-step --project 10 --step narracao --block 1",
  "npm run gentube -- run-step --project 10 --step narracao --block 1 --force-narracao --voice-id <id>",
  "npm run gentube -- run-step --project 10 --step imagens --scene-plan-v2 --plan-only",
  "npm run gentube -- run-step --project 10 --step imagens --scene-plan-v2 --enqueue-only --google-batch-mode",
  "npm run gentube -- run-step --project 10 --step montagem --block 1",
  "npm run gentube -- run-step --project 10 --step montagem --montagem-scenes-only",
  "npm run gentube -- run-step --project 10 --step montagem --montagem-assemble-only",
  "npm run gentube -- run-step --project 10 --step montagem",
  "GENTUBE_HF_ASYNC=1 npm run gentube -- run-step --project 1 --step imagens --scene-plan-v2",
  "GENTUBE_VISUAL_MODALITY=wojak npm run gentube -- run-step --project 10 --step imagens --scene-plan-v2 --plan-only",
  "npm run gentube -- cost-estimate --project 10",
])}
`),

  retry: cliHelpAfter(`
Reprocessa uma etapa inteira ou um bloco (--block N, base 1).
Mesmas flags de run-step por stage (roteiro, narracao, imagens, thumbnails).

${chalk.bold("Narracao")}  Reutiliza scXX.mp3 >=1KB no disco; so gera o que falta.
  --force-narracao  Regenera todas as cenas do bloco (ElevenLabs de novo).
  --voice-id  Voz ElevenLabs nesta corrida.
${chalk.bold("Imagens v2")}  --scene-plan-v2 · --plan-only · --enqueue-only · --google-batch-mode
  GENTUBE_FORCE_VIZ_REGEN=1 forca novo plano Claude e limpa filas do bloco.
  Salta cenas com ficheiro ja em renders/blockNN/ (png, bootstrap, mp4).

${chalk.bold("Imagens Wojak")}  GENTUBE_VISUAL_MODALITY=wojak
  retry trava na 1a cena de video sem cota Veo (429) — imagens depois no plano nao correm.
  Retomar PNG/bootstrap: npx tsx scripts/continue-missing-renders.ts --project <id> --block N
  Depois image:sync --watch; quando Veo OK: retry --stage imagens --block N --scene-plan-v2

${chalk.bold("Exemplos")}
${ex([
  "npm run gentube -- retry --project 10 --stage narracao --block 2",
  "npm run gentube -- retry --project 10 --stage narracao --block 1 --force-narracao --voice-id <id>",
  "npm run gentube -- retry --project 10 --stage imagens --block 5 --scene-plan-v2",
  "npm run gentube -- retry --project 10 --stage imagens --scene-plan-v2 --enqueue-only --google-batch-mode",
  "npm run gentube -- retry --project 10 --stage imagens --block 1 --scene-plan-v2",
  "npx tsx scripts/continue-missing-renders.ts --project 10 --block 1",
])}
`),

  runAll: cliHelpAfter(`
Executa em sequencia: roteiro (todos os blocos) → narracao (todos os blocos).
Nao inclui imagens nem thumbnails (use run-step ou create-video modo iterativo).

${chalk.bold("Exemplo")}  npm run gentube -- run-all --project 10 --voice-id <id>
`),

  syncFromDisk: cliHelpAfter(`
Alinha narration_blocks, script_blocks e media_blocks com ficheiros no disco.
Util apos copiar pasta do projeto ou regenerar ficheiros fora do CLI.

${chalk.bold("--only")}  roteiro | narracao | imagens | montagem | all (padrao: all)
${chalk.bold("--dry-run")}  Lista alteracoes sem gravar SQLite
${chalk.bold("--force")}  Reimporta blocos ja marcados success

${chalk.bold("Narracao")}  Detecta blockNN.mp3 ou blockNN/scXX.mp3 e marca success.
Depois, run-step --step narracao nao re-chama ElevenLabs nesses blocos.

${chalk.bold("Exemplo")}  npm run gentube -- sync-from-disk --project 10 --only narracao
`),

  status: cliHelpAfter(`
Mostra status_roteiro, status_narracao, status_imagens_videos, status_montagem, status_thumbnails
e o caminho da pasta do projeto.

Para filas e videos: image:status · video:status
`),

  imageSync: cliHelpAfter(`
Processa image_jobs pendentes:
  · higgsfield — poll/download CLI hf
  · gemini — poll Batch API Google e grava renders

Videos HF (hf_cli_jobs) NAO entram aqui → higgsfield:sync

${chalk.bold("--watch")}  Repete ate image_jobs pendentes = 0
${chalk.bold("--provider")}  all | higgsfield | gemini

${chalk.bold("Exemplo")}  npm run gentube -- image:sync --project 10 --watch --interval 30s
`),

  imageBatchSubmit: cliHelpAfter(`
Submete jobs em google_batch sem external_id (1 operacao Batch API por bloco).
Use apos --enqueue-only se o submit automatico falhou ou foi adiado.

${chalk.bold("Depois")}  image:sync --project <id> --watch
`),

  imageStatus: cliHelpAfter(`
Contagem de image_jobs pendentes (HF vs Gemini) e hf_cli_jobs de video.
Sugere comandos image:sync e higgsfield:sync quando aplicavel.
`),

  costEstimate: cliHelpAfter(`
Estimativa de custo USD para projetos em GENTUBE_VISUAL_MODALITY=wojak.
Le blockNN.assets.json (schema 2.0) e conta por bloco:
  · Claude (segmentacao + visualizacao) — GENTUBE_COST_USD_CLAUDE_PLAN_BLOCK
  · Gemini imagens (batch vs sync) — GENTUBE_COST_USD_GEMINI_IMAGE_BATCH / _SYNC
  · Bootstrap de video (sync) — tarifa sync
  · Veo (segundos x duracao por cena video) — GENTUBE_COST_USD_VEO_PER_SECOND

Nao chama APIs; so leitura do plano no disco.
Ajuste tarifas no .env antes de corridas longas.

${chalk.bold("Exemplo")}  npm run gentube -- cost-estimate --project 10
${chalk.bold("Doc")}  wojak.md
`),

  videoStatus: cliHelpAfter(`
Por projeto:
  · Ultimo bloco com atividade e status no SQLite (renders/plan)
  · hf_cli_jobs de video (pendente / falho por credito)
  · Cenas IA sem .mp4/.mov no disco (retentaveis)

${chalk.bold("Exemplo")}  npm run gentube -- video:status --project 10
`),

  videoRetry: cliHelpAfter(`
Regera videos IA em falta. Ordem com GENTUBE_VIDEO_BACKEND=auto:
  Higgsfield (kling3_0) → Google Veo (poll sync) → Magnific stock video

${chalk.bold("Padrao")}  So cenas sem arquivo ou falha HF por credito/cota (not_enough_credits, 429, etc.)
${chalk.bold("--all-failed")}  Inclui outros erros HF
${chalk.bold("--dry-run")}  Lista cenas sem gerar
${chalk.bold("--block N")}  Limita a um bloco

Requer GEMINI_API_KEY para Veo; hf no PATH para HF.
Referencia de imagem: bootstrap ou ultima imagem IA do plano.

${chalk.bold("Exemplos")}
${ex([
  "npm run gentube -- video:retry --project 10 --dry-run",
  "npm run gentube -- video:retry --project 10 --block 1",
  "npm run gentube -- video:retry --project 10 --all-failed",
])}
`),

  higgsfieldSync: cliHelpAfter(`
Poll/download hf_cli_jobs (videos IA e thumbs HF legado).
Imagens em image_jobs → use image:sync.

${chalk.bold("--watch")}  Ate nenhum job pending
${chalk.bold("--interval")}  15s, 30s, 2m, ou numero = segundos
`),

  elevenlabsStatus: cliHelpAfter(`
Uso de caracteres do periodo de faturacao (plano ElevenLabs).
Util antes/depois de run-step --step narracao (modo por cena consome ~chars do plano).
`),

  createVideo: cliHelpAfter(`
Cria pasta do projeto + registo SQLite. Modos apos criar:
  iterativo — pergunta cada etapa
  sequencial — roteiro + narracao automaticos (como run-all)

${chalk.bold("Flags uteis")}  --channel --title --niche --audience --blocks --transcript-file
`),

  shotListManual: cliHelpAfter(`
Gera shot_list_manual.md e .csv em 03 - Imagens e Videos/
a partir de block*.assets.json (schema 2.0) — cenas com capture_brief / captura manual.
`),
} as const;

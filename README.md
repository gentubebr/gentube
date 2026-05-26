# GenTube

CLI em **Node.js** para organizar projetos de vídeo no estilo YouTube: **roteiro** (Claude), **narração** (ElevenLabs), **imagens e vídeos** (direção Claude + produção mista **Higgsfield** / **Google Gemini** IA + Magnific stock), **thumbnails** (referência YouTube + avatar via HF ou Gemini), pastas por **canal** e histórico em **SQLite**.

---

## Por que usar

- Estrutura fixa de pastas por canal e por vídeo (`Videos/<canal>/<data>-<titulo>/`).
- Roteiro em blocos (`block01.md`, …) a partir do prompt em `Prompts/matriz.md` ou **`matriz_tutorial.md`** (`GENTUBE_ROTEIRO_MODE=tutorial`, `GENTUBE_PROMPT_MATRIX` ou `--prompt-matrix`). No **bloco 1**, o ficheiro opcional `Prompts/canal_voice.md` fixa voz/persona do canal; nos **blocos seguintes**, o texto dos `.md` anteriores entra como contexto de coesão (configurável; ver tabela de variáveis).
- Áudio por bloco (`block01.mp3`, …) ou **por cena** (`02 - Narracao/block01/sc01.mp3`, …) quando existe plano v2; concat com `ffmpeg` → `help run-step` (etapa narracao).
- Status de cada etapa e de cada bloco gravados localmente (sem depender só de arquivos soltos).
- Modalidade visual **Wojak** (opt-in): avatar line-art, plano só `ai_generated` (sem stock), validação v2, render Gemini+Veo — ver **[wojak.md](wojak.md)** e secção **18.10** de `ESPECIFICACAO_TECNICA.md`.
- Modalidade **Stoic Patrol** (opt-in): stock Magnific com fallback Pexels + cartões de citação (typing) — ver **[stoic-patrol.md](stoic-patrol.md)** e secção **18.12** da especificação.

## Pré-requisitos: contas, chaves e ferramentas

Antes de clonar o GenTube, reúna o seguinte (sem gravar segredos em ficheiros versionados):

### Anthropic (Claude)

1. Conta em [console.anthropic.com](https://console.anthropic.com/).
2. Crie uma **API key** e guarde-a; no GenTube use `CLAUDE_API_KEY` no `.env` (ver [`.env.example`](.env.example)).
3. Opcional: ajuste `CLAUDE_MODEL`, `CLAUDE_MAX_TOKENS`, `CLAUDE_THINKING` conforme a documentação Anthropic.

### ElevenLabs (narração)

1. Conta em [elevenlabs.io](https://elevenlabs.io/) → API keys.
2. No `.env`: `ELEVENLABS_API_KEY` e `ELEVENLABS_VOICE_ID` (voz desejada).
3. O comando `elevenlabs:status` exige permissão `user_read` na chave.
4. Antes do TTS, o texto passa por **`stripMarkdownForSpeech`** (remove `**negrito**`, listas, links, etc.) para o modelo não ler pontuação Markdown em voz alta.

### Stock — Magnific e Pexels (imagens e vídeos)

O step **imagens** baixa cenas `source: stock` via `GENTUBE_STOCK_PROVIDER` (`src/integrations/stock-download.ts` → Magnific e/ou Pexels).

#### Magnific (primário por defeito)

1. Conta / API em [Magnific](https://www.magnific.com/) (documentação da API B2B).
2. No `.env`: `MAGNIFIC_API_KEY`. Planos sem download premium podem falhar em parte dos assets.
3. Stock **16:9**: vídeo com `filters[aspect_ratio][]=16:9`; imagens validadas pós-download (`image-size`) e, se necessário, recorte com FFmpeg (`GENTUBE_FFMPEG_PATH` ou `experiments/ffmpeg-bin/ffmpeg`).
4. Em falha (429, 500, asset desativado, sem match 16:9), o pipeline pode tentar **Pexels** se `GENTUBE_STOCK_PROVIDER=magnific_then_pexels`.

#### Pexels (alternativa / fallback)

1. Conta e chave em [Pexels API](https://www.pexels.com/api/documentation/) (header `Authorization`).
2. No `.env`: `PEXELS_API_KEY`.
3. Endpoints: `GET /v1/search` (fotos, `orientation=landscape`) e `GET /v1/videos/search` (vídeos, `orientation=landscape`). Download por URL direta em `photo.src` / `video_files[]` (não conta como chamada API extra).
4. Limites default: **200 pedidos/hora**, **20 000/mês**; headers `X-Ratelimit-Remaining`, `X-Ratelimit-Reset`. Projetos grandes devem usar **cache** (`data/stock_cache/`) e fallback (não substituir Magnific por Pexels em todas as cenas de uma vez).
5. **Atribuição:** crédito ao fotógrafo / link Pexels na descrição ou créditos do vídeo (requisito da API).

**Modo `default`:** se Magnific falhar no stock, fallback para **IA** (Higgsfield ou Gemini, conforme `GENTUBE_IMAGE_BACKEND`). **Stoic Patrol** (`stoic_patrol`): sem fallback IA no stock — usar `magnific_then_pexels` e retomar com `--enqueue-only`.

### Higgsfield CLI (geração IA imagens/vídeo)

O GenTube chama o binário **`hf`** / **`higgsfield`** (job sets `nano_banana_flash`, `kling3_0`). Instalação típica:

```bash
# Opção A — pacote npm global (recomendado)
npm install -g @higgsfield/cli

# Opção B — clonar o repositório oficial e seguir o README do projeto
git clone https://github.com/higgsfield-ai/cli.git
cd cli
# instalar conforme instruções do repositório (npm link, etc.)
```

Depois faça **login** com o fluxo do próprio CLI (o ficheiro de credenciais costuma ficar em `~/.config/higgsfield/credentials.json`). **Proteja o ficheiro** (contém tokens):

```bash
chmod 600 ~/.config/higgsfield/credentials.json
```

No `.env` do GenTube pode definir:

- `HIGGSFIELD_CLI_PATH` — caminho absoluto do executável, se não estiver no `PATH`
- `HIGGSFIELD_CREDENTIALS_PATH` — se as credenciais estiverem noutro sítio
- `GENTUBE_HF_ASYNC=1` — enfileira jobs HF; conclua com `image:sync` ou `higgsfield:sync` (alias)

### Google GenAI / Gemini (imagens IA e thumbnails)

Segundo provedor de **imagens** (Nano Banana via `@google/genai`). **Vídeos IA**: Higgsfield (`kling3_0`) com fallback **Veo** (`veo-3.1-lite-generate-preview`, 1080p, sem áudio, poll sync) e depois **Magnific** (stock) se faltar crédito/cota.

1. Chave em [Google AI Studio](https://aistudio.google.com/apikey) ou Vertex; no `.env`: `GEMINI_API_KEY` (o alias `google_api_key` também é aceite).
2. Batch oficial (produção, menor custo): `GENTUBE_IMAGE_DELIVERY=google_batch` ou flag `--google-batch-mode`.
3. Após enfileirar: `npm run gentube -- image:sync --project <id>` (planeado; hoje use `higgsfield:sync` para jobs HF legados).

| Modo | Flag CLI | Uso |
|------|----------|-----|
| **Sync** | (nenhuma; 1 prompt) | Teste rápido, fallback imediato |
| **Batch Google** | `--google-batch-mode` | Produção; requer `--prompts-file` no `gemini:image` ou pipeline imagens/thumbnails |
| **Batch local** | `--batch-local` | Testes com concorrência (`--concurrency`); mutuamente exclusivo com `--google-batch-mode` |

**Política `GENTUBE_IMAGE_BACKEND=auto` (default):** tenta Higgsfield; se falhar (sem créditos, timeout, erro CLI, etc.) → **uma** tentativa Gemini. Com `--google-batch-mode`, usa só Gemini Batch — se o submit falhar, **não** há fallback sync (falha e regista em log).

Detalhes: **secção 22** de `ESPECIFICACAO_TECNICA.md`.

### Node.js e este repositório

- [Node.js](https://nodejs.org/) **18+** (recomendado LTS **20** ou **22**), **a mesma major** em todas as máquinas onde correr `npm install`.
- Corridas longas com **Wojak** + `better-sqlite3`: em alguns ambientes só **Node 23** compila o módulo nativo — use a mesma major no `PATH` que em `npm install` (ver [wojak.md](wojak.md)).
- Após `git clone` e `cd gentube`:

```bash
npm install
npm run build
```

Se aparecer erro **NODE_MODULE_VERSION** com `better-sqlite3`, recompile o módulo nativo para a versão do Node atual:

```bash
npm run rebuild:native
```

### Git e ficheiros que **não** vão para o remoto

O repositório público **não** inclui: `.env`, `data/`, pasta **`Avatars/`** (coloque avatares só localmente), conteúdo de **`Videos/`** e de **`Transcripts/`** (só `.gitkeep` em cada pasta no clone), **`scripts/`**, **`EXAMPLE.md`** (runbook local). A pasta **`Template/`** com a estrutura de canal **é** versionada — use-a como modelo ao criar pastas de projeto.

---

## Requisitos (resumo)

- Node.js **18+** (recomendado LTS).
- Chaves e ferramentas listadas acima, conforme as etapas que for usar (roteiro, narração, imagens, thumbnails).

## Instalação

```bash
git clone <url-do-repositorio> gentube
cd gentube
npm install
```

Se ao rodar o CLI aparecer erro do tipo **NODE_MODULE_VERSION** com `better-sqlite3`, o binário nativo foi compilado para **outra versão** do Node (ex.: módulo 115 = Node 20, módulo 131 = Node 23). Isso acontece ao trocar de Node depois do `npm install`. Recompile:

```bash
npm run rebuild:native
# equivalente a:
npm rebuild better-sqlite3
```

**Dica:** use a mesma linha de Node (ex. **LTS 22** ou **20**) em todas as máquinas, ou rode `rebuild:native` sempre que mudar o major do Node.

## Configuração rápida

1. Copie o exemplo de ambiente e preencha as chaves:

   ```bash
   cp .env.example .env
   ```

2. Ou use o assistente interativo (cria `.env`, pastas e opcionalmente o primeiro canal):

   ```bash
   npm run gentube -- init
   ```

Variáveis principais (detalhes no [`.env.example`](.env.example)):

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `CLAUDE_API_KEY` | Sim | API da Anthropic (roteiro + imagens) |
| `CLAUDE_MODEL` | Opcional | Modelo Claude (default: `claude-opus-4-7`) |
| `CLAUDE_MAX_TOKENS` | Opcional | Limite de tokens de saída (default: `16000`) |
| `CLAUDE_THINKING` | Opcional | `adaptive` (Opus 4.7), `disabled` (sem thinking, permite temperature) ou vazio |
| `ELEVENLABS_API_KEY` | Sim | API da ElevenLabs (TTS) |
| `ELEVENLABS_VOICE_ID` | Recomendada | Voz padrão se você não passar `--voice-id` |
| `MAGNIFIC_API_KEY` | Sim (step imagens, se usar Magnific) | API Magnific/Freepik |
| `PEXELS_API_KEY` | Sim se `GENTUBE_STOCK_PROVIDER` incluir Pexels | API Pexels ([documentação](https://www.pexels.com/api/documentation/)) |
| `GENTUBE_STOCK_PROVIDER` | Opcional | `magnific` (default), `pexels`, `magnific_then_pexels`, `pexels_then_magnific` |
| `GENTUBE_STOCK_RATIO_BLOCK1` | Opcional | % de shots do bloco 1 com `source: stock` (default: `50`) |
| `GENTUBE_STOCK_RATIO_OTHER` | Opcional | % de shots dos blocos 2..N com stock (default: `90`) |
| `GENTUBE_PROMPT_MATRIX` | Opcional | Ficheiro em `Prompts/` para o **roteiro** (ex.: `matriz_tutorial.md`). Tem prioridade sobre `GENTUBE_ROTEIRO_MODE`. A flag `--prompt-matrix` tem prioridade sobre ambos |
| `GENTUBE_ROTEIRO_MODE` | Opcional | Com `tutorial` (e sem `GENTUBE_PROMPT_MATRIX` nem `--prompt-matrix`), usa **`matriz_tutorial.md`**. Sem esta variável ou com outro valor, o default do ficheiro continua **`matriz.md`** |
| `GENTUBE_PROMPT_CANAL_VOICE` | Opcional | Ficheiro em `Prompts/` com **voz/persona do canal** (default `canal_voice.md`), injetado **só no bloco 1** do roteiro; `none` desativa. A flag `--prompt-canal-voice` tem prioridade |
| `GENTUBE_ROTEIRO_CANAL_VOICE` | Opcional | `0` / `false` / `off`: não injeta voz do canal no bloco 1 |
| `GENTUBE_ROTEIRO_PREV_CONTEXT` | Opcional | `0` / `false` / `off`: não envia texto dos blocos `01 - Roteiro/block*.md` anteriores ao gerar o bloco *N* (default: ativo) |
| `GENTUBE_ROTEIRO_PREV_CONTEXT_CHARS` | Opcional | Teto de caracteres do contexto cumulativo dos blocos anteriores (default `100000`; `0` = sem limite; se exceder, mantém o fim) |
| `GENTUBE_MAX_VIDEOS_BLOCK1` | Opcional | Máx. **vídeos** no plano do **bloco 1** (default `16`). As flags `--max-videos-block1` / `--max-images-block1` etc. no `run-step` / `retry` **têm prioridade** na corrida |
| `GENTUBE_MAX_IMAGES_BLOCK1` | Opcional | Máx. **imagens** no plano do **bloco 1** (default `20`) |
| `GENTUBE_MAX_VIDEOS_OTHER_BLOCKS` | Opcional | Máx. vídeos nos **blocos 2..N** (default `10`) |
| `GENTUBE_MAX_IMAGES_OTHER_BLOCKS` | Opcional | Máx. imagens nos **blocos 2..N** (default `40`) |
| `GENTUBE_SCENE_PLAN_V2` | Opcional | `1` / `true` / `yes`: step **imagens** em modo plano por cenas (dois passos Claude). A flag `--scene-plan-v2` tem prioridade quando passada |
| `GENTUBE_VISUAL_MODALITY` | Opcional | `default`, `wojak` ou `stoic_patrol` — ver [wojak.md](wojak.md) / [stoic-patrol.md](stoic-patrol.md) |
| `GENTUBE_VERBOSE` | Opcional | `1` ou flag `--verbose` / `-v`: progresso Claude batch, etapas plano v2, poll de batches |
| `GENTUBE_QUOTE_RENDER` | Opcional | Stoic Patrol: `hyperframes` (default auto), `ffmpeg` — cartoes `quote_card` |
| `GENTUBE_PROMPT_VISUALIZA` | Opcional | Ficheiro em `Prompts/` para visualização; em `wojak` o default é `visualiza01.md` + `visualiza_wojak.md` |
| `GENTUBE_WOJAK_STYLE_TOKEN` | Opcional | Override do prefixo de estilo no render (modo wojak) |
| `GENTUBE_WOJAK_VEO_USE_REF` | Opcional | `0` (default): Veo sem PNG ref; prompt sanitizado. `1`: envia bootstrap ao Veo (pode disparar RAI) |
| `GENTUBE_VIDEO_BACKEND` | Opcional | `auto`, `veo`, `higgsfield`, `magnific` — em modo **wojak** o render de vídeo usa **Veo** |
| `GENTUBE_COST_USD_*` | Opcional | Tarifas USD para `cost-estimate` (Claude plano, Gemini sync/batch, Veo/s) — ver `.env.example` |
| `GENTUBE_FORCE_VIZ_REGEN` | Opcional | `1` / `true` / `yes`: força **nova** segmentação/visualização Claude e apaga jobs HF do bloco no retry (ignora `blockNN.assets.json` e `.error` no disco; com `--plan-only` não reutiliza plano antigo) |
| `GENTUBE_CLAUDE_DELIVERY` | Opcional | `batch` (default, −50% custo) ou `sync` (debug) |
| `GENTUBE_MAX_SCENES_DYNAMIC` | Opcional | `1`: calcula `max_scenes` por palavras do bloco (sec. 24 ESPECIFICACAO) |
| `GENTUBE_MAX_SCENES_WORDS_DIVISOR` | Opcional | Divisor da fórmula (default `22`) |
| `GENTUBE_MAX_SCENES_CAP` | Opcional | Teto de cenas por bloco (default `100`) |
| `GENTUBE_MAX_WORDS_PER_SCENE` | Opcional | Rejeita cenas > N palavras na segmentação (default `120`) |
| `GENTUBE_CLAUDE_BATCH_POLL_INTERVAL` | Opcional | Poll `claude:sync --watch` (default `60s`) |
| `GENTUBE_REMOTE_HOST` | Opcional | Host SSH remoto para `copy-cmd` (ex.: `dev-development`); evita `--remote-host` toda vez |
| `GENTUBE_HF_ASYNC` | Opcional | `1`, `true` ou `yes`: no step **imagens**, enfileira jobs no Higgsfield sem esperar no mesmo comando; use `image:sync` / `higgsfield:sync` (ou `--watch`) para baixar resultados |
| `HIGGSFIELD_CLI_PATH`, `HIGGSFIELD_CREDENTIALS_PATH`, `HIGGSFIELD_CLI_WAIT_TIMEOUT`, `HIGGSFIELD_API_URL` | Opcionais | Caminho do binário `hf`, credenciais, timeout de `--wait` (modo síncrono), base da API de agents; ver [`.env.example`](.env.example) |
| `GEMINI_API_KEY` | Sim (se usar Gemini) | API Google GenAI; alias: `google_api_key` |
| `google_project_name`, `google_parent_folder_id` | Opcionais | Vertex / Batch API Google (quando aplicável) |
| `GEMINI_IMAGE_MODEL` | Opcional | Default `gemini-2.5-flash-image` (Nano Banana rápido) |
| `GENTUBE_IMAGE_BACKEND` | Opcional | `auto` (default), `higgsfield` ou `gemini` |
| `GENTUBE_IMAGE_DELIVERY` | Opcional | `google_batch` (default produção), `sync` ou `local_batch` |
| `GENTUBE_GEMINI_BATCH_SCOPE` | Opcional | `block` no pipeline; CLI manual pode agrupar por projeto |
| `GENTUBE_GEMINI_LOCAL_CONCURRENCY` | Opcional | Concorrência do batch local (default `4`) |
| `GENTUBE_CLAUDE_MODEL_ROTEIRO` | Opcional | Modelo Claude para roteiro (default: `CLAUDE_MODEL`, i.e., Opus) |
| `GENTUBE_CLAUDE_MODEL_VISUALIZATION` | Opcional | Modelo Claude para visualização (default: `CLAUDE_MODEL`) |
| `GENTUBE_CLAUDE_MODEL_QUALITY_GATE` | Opcional | Modelo para QualityGateAgent (default: `claude-sonnet-4-6`) |
| `GENTUBE_QUALITY_GATE_ENABLED` | Opcional | `0` / `false` / `off`: desativa avaliação de qualidade do roteiro antes do step imagens (default: ativo) |
| `GENTUBE_QUALITY_GATE_THRESHOLD` | Opcional | Score mínimo (0–100) para aprovação do roteiro; abaixo regenera (default: `65`) |
| `GENTUBE_QUALITY_GATE_MAX_REGEN` | Opcional | Máx. regenerações por bloco quando score < threshold (default: `1`) |
| `GENTUBE_ROTEIRO_STAGE_BATCH` | Opcional | `1`: submete todos os blocos de roteiro em 1 único Message Batch em vez de por bloco (default: desativo) |
| `GENTUBE_QUOTA_RETRY_DELAY_MS` | Opcional | Espera (ms) antes de retry após erro de quota/rate limit da API Claude (default: `30000`) |
| `GENTUBE_DAEMON_POLL_MS` | Opcional | Intervalo de polling do daemon entre verificações de jobs (ms, default: `10000`) |

> O arquivo `.env` não deve ser commitado (já está no `.gitignore`).

## Uso do CLI

Todos os exemplos abaixo usam `npm run gentube --`, que repassa os argumentos ao executável.

### Ajuda

A documentação **principal do CLI** está em `gentube help` (texto embutido em `src/cli-help.ts`): fluxo por etapa, flags de imagens v2, narração por cena, fallback de vídeo HF→Veo→Magnific e variáveis `.env` frequentes.

```bash
npm run gentube -- --help              # visão geral + fluxo típico + exemplos
npm run gentube -- help run-step       # roteiro, narração, imagens (plan-only / enqueue-only), thumbnails
npm run gentube -- help retry          # reprocessar etapa ou bloco
npm run gentube -- help video:retry    # HF → Veo → Magnific
npm run gentube -- help image:sync     # poll image_jobs (HF + Gemini batch)
npm run gentube -- cost-estimate --project <id>   # custo USD estimado (modo Wojak)
npm run gentube -- help sync-from-disk # alinhar SQLite com disco
npm run gentube -- <comando> --help    # equivalente a help <comando>
```

Comandos com secção **Exemplos** no final do help: `run-step`, `retry`, `video:retry`, e a ajuda geral (`--help`).

Se você rodar só `npm run gentube --` (sem subcomando), o programa mostra um resumo, sugere `init` e lista todos os comandos.

### Fluxo típico

```bash
# 1) Cadastrar um canal (uma vez por canal)
npm run gentube -- channel:create

# 2) Listar canais e anotar o id, se precisar
npm run gentube -- channel:list

# 2b) Ver todos os canais com os projetos de cada um (SQLite); --json para scripts
npm run gentube -- projects:list
npm run gentube -- projects:list --json

# 3) Criar projeto de vídeo (interativo ou com flags)
npm run gentube -- create-video

# Exemplo com referência de outro vídeo (estrutura / mensagens-chave — arquivo UTF-8)
npm run gentube -- create-video --channel 1 \
  --title "Meu título" \
  --niche "finanças pessoais" \
  --audience "adultos EUA 30+" \
  --blocks 8 \
  --transcript-file Transcripts/minha-referencia.txt \
  --create-only

# Stoic Patrol — projeto com transcricao de referencia (roteiro em ingles, fidelidade de tom/arco)
# Canal id: gentube channel:list  |  .env: GENTUBE_VISUAL_MODALITY=stoic_patrol GENTUBE_SCENE_PLAN_V2=1
npm run gentube -- create-video --channel 2 \
  --title "Changing Hurts… But It Changes Everything" \
  --niche "stoicism, psychology, faith, meaning — removal and transition" \
  --audience "American adults 30+" \
  --blocks 8 \
  --transcript-file "Transcripts/[Claudio Duarte] Changes hurt, but worth" \
  --prompt-matrix matriz_stoic_patrol.md \
  --prompt-canal-voice canal_voice_stoic_patrol.md \
  --create-only

npm run gentube -- run-step --project <slug-do-projeto> --step roteiro \
  --prompt-matrix matriz_stoic_patrol.md --prompt-canal-voice canal_voice_stoic_patrol.md --verbose
npm run gentube -- run-step --project <slug> --step imagens --scene-plan-v2 --plan-only --verbose
npm run gentube -- quote:render --project <slug> --force
npm run gentube -- run-pipeline --project <slug> --profile stoic-patrol-stock --voice-id <id> --verbose

# Apagar um projeto sem prompts (scripts)
npm run gentube -- delete-project --project 2 --yes

# 4) Só roteiro ou só narração (use id numérico ou slug da pasta do projeto)
npm run gentube -- run-step --project 1 --step roteiro
npm run gentube -- run-step --project 1 --step roteiro --prompt-matrix matriz_tutorial.md --prompt-canal-voice canal_voice.md
npm run gentube -- run-step --project 1 --step narracao

# 4b) Step imagens — limites vêm do .env (GENTUBE_MAX_*); sobrescreva por corrida, ex.:
# npm run gentube -- run-step --project 1 --step imagens --max-videos-block1 12 --max-images-other 30

# 5) Pipeline completo Wojak (modo cenas, 100% imagens batch, com rastreio SQLite + JSON)
# Ordem: roteiro → quality_gate → imagens → image_sync → narracao → montagem → thumbnails
npm run gentube -- run-pipeline --project 1 --voice-id <ELEVENLABS_VOICE_ID>
# Retomar após falha (ex. só imagens — NÃO use --from-stage narracao se PNGs ainda faltam):
npm run gentube -- run-pipeline --project 1 --from-stage imagens --voice-id <id>
# Ver onde parou / erros por bloco:
npm run gentube -- pipeline-report --project 1

# 5b) Legado: só roteiro + narração (sem imagens/montagem)
npm run gentube -- run-all --project 1

# 6) Consultar status
npm run gentube -- status --project 1

# 6b) Imagens IA — batch Google (produção) ou HF async legado
npm run gentube -- run-step --project 1 --step imagens --google-batch-mode --scene-plan-v2
npm run gentube -- image:sync --project 1 --watch --interval 60s
# HF legado (hf_cli_jobs → migrar para image_jobs):
npm run gentube -- higgsfield:sync --project 1

# 6b-i) Imagens v2 em 3 fases (planos de todos os blocos → enqueue → submit N batches)
npm run gentube -- run-step --project 10 --step imagens --scene-plan-v2 --plan-only
npm run gentube -- run-step --project 10 --step imagens --scene-plan-v2 --google-batch-mode --enqueue-only
npm run gentube -- image:sync --project 10 --watch --interval 60s
# Ou submit manual antes do sync:
npm run gentube -- image:batch-submit --project 10

# 6b-ii) So bloco 1 (retry)
npm run gentube -- retry --project 10 --stage imagens --block 1 --scene-plan-v2 --google-batch-mode

# 6c) Teste avulso Gemini (planeado)
npm run gentube -- gemini:image --prompt "cinematic 16:9 ..." --out ./out/teste.png
npm run gentube -- gemini:image --google-batch-mode --prompts-file prompts.txt --out-dir ./out
npm run gentube -- gemini:image --batch-local --prompts-file prompts.txt --out-dir ./out --concurrency 4

# 7) Montagem FFmpeg — primeiro por bloco, depois o step todo
npm run gentube -- run-step --project 1 --step montagem --block 1
npm run gentube -- run-step --project 1 --step montagem --block 2
# Quando todos os blocos estiverem prontos (ou para reprocessar o que falta):
npm run gentube -- run-step --project 1 --step montagem
# Bloco incompleto → block01_sc01-sc05.mp4 + block01.err.txt · completo → 06 - Montagem/blocks/block01.mp4
npm run gentube -- retry --project 1 --stage montagem --block 2 --force

# 8) Gerar thumbnails (mesma política de imagem: --google-batch-mode, auto, etc.)
# (A) Com referência de outro canal (baixa thumbnail + avatar → HF ou Gemini)
npm run gentube -- run-step --project 1 --step thumbnails --google-batch-mode \
  --reference-url "https://www.youtube.com/watch?v=VIDEO_ID" \
  --avatar-file Avatars/seu-avatar.jpg \
  --count 2

# (B) Sem referência (apenas avatar + prompt → HF)
npm run gentube -- run-step --project 1 --step thumbnails \
  --avatar-file Avatars/seu-avatar.jpg \
  --count 2

# Com prompt customizado
npm run gentube -- run-step --project 1 --step thumbnails \
  --reference-url "https://www.youtube.com/watch?v=VIDEO_ID" \
  --avatar-file Avatars/seu-avatar.jpg \
  --prompt "generate a thumbnail with a man pointing at money" \
  --count 2

# 8) Consultar uso de caracteres ElevenLabs
npm run gentube -- elevenlabs:status

# 9) Reprocessar uma etapa ou só um bloco
npm run gentube -- retry --project 1 --stage roteiro --block 2
npm run gentube -- retry --project 1 --stage narracao --block 2

# 10) Copiar arquivos do servidor remoto para a máquina local (rsync)
npm run gentube -- copy-cmd --project 1 --remote-host dev-development
# Com destino local customizado
npm run gentube -- copy-cmd --project 1 --remote-host dev-development --local-dir ~/Downloads/video1/
# Simulação (dry-run)
npm run gentube -- copy-cmd --project 1 --remote-host dev-development --dry-run
# Ou defina GENTUBE_REMOTE_HOST no .env para omitir --remote-host
npm run gentube -- copy-cmd --project 1
```

### Artefactos criados fora do GenTube (`sync-from-disk`)

Quando já tens `blockNN.md`, `blockNN.mp3` ou plano + renders em `03 - Imagens e Videos/` mas o SQLite ainda não reflete `success`, usa:

```bash
npm run gentube -- sync-from-disk --project 6 --dry-run   # pré-visualizar
npm run gentube -- sync-from-disk --project 6             # roteiro + narração + imagens (conforme ficheiros)
npm run gentube -- sync-from-disk --project 6 --only roteiro
npm run gentube -- sync-from-disk --project 6 --only narracao
npm run gentube -- sync-from-disk --project 6 --only imagens
npm run gentube -- sync-from-disk --project 6 --force     # reimportar mesmo com blocos já success
```

**Narração:** `run-step --step narracao` **já** ignora blocos com `narration_blocks.status === success` — depois do sync não se volta a gastar ElevenLabs nesses blocos. Com plano v2 (`blockNN.assets.json`), cada cena vira `02 - Narracao/blockNN/scXX.mp3` a partir de `narration_text`; MP3 ≥ 1 KiB no disco são **reutilizados** (sem nova chamada ElevenLabs). Para **nova voz** ou texto do plano atualizado, use **`--force-narracao`** (regenera todas as cenas do bloco):

```bash
npm run gentube -- retry --project <slug> --stage narracao --block 1 \
  --force-narracao --voice-id PzuBz8h2SxBvQ7lnUC44
```

Equivalente: `run-step --step narracao --block 1 --force-narracao --voice-id <id>`. Requer `blockNN.assets.json` (schema 2.0) antes da narração por cena — ver [wojak.md](wojak.md).

### `run-pipeline` (corrida completa com rastreio)

Comando único para o fluxo Wojak **modo cenas**, **100% imagens** (vídeos forçados a 0), batch Google, narração, montagem e thumbnails opcionais.

| Onde ver o que aconteceu | Conteúdo |
|------------------------|----------|
| `pipeline_runs` / `pipeline_run_steps` (SQLite) | Cada etapa e bloco: `success`, `error`, `skipped`, `attempt`, `error_message` |
| `project_logs` (`stage=pipeline`) | Eventos de início/fim e resumo |
| `05 - Modelagem/pipeline-run-<id>.json` | Relatório completo da corrida |
| `05 - Modelagem/pipeline-run-latest.json` | Cópia da última corrida |
| `npm run gentube -- pipeline-report --project <slug>` | Resumo legível no terminal |

Por defeito **`--continue-on-error`**: um bloco com erro não aborta os restantes; o status final fica `partial`. Use `--no-continue-on-error` para parar cedo. Retome com `--from-stage` (`roteiro`, `quality_gate`, `imagens`, `image_sync`, `imagens_retry`, `narracao`, `montagem`, `thumbnails`).

`.env` recomendado: `GENTUBE_VISUAL_MODALITY=wojak`, `GENTUBE_SCENE_PLAN_V2=1`, `GENTUBE_IMAGE_BACKEND=gemini`, `GENTUBE_HF_ASYNC=0`.

**Background (vários blocos — narração + renders Wojak):** script `scripts/background-wojak-blocks.sh` + `image:sync --watch` noutro terminal. Detalhes em [wojak.md](wojak.md) (secção *Execução em background*).

**Imagens:** `run-step --step imagens` **salta blocos** em que `media_blocks` já tem plano e renders concluídos (e, em modo assíncrono, sem jobs `image_jobs` / `hf_cli_jobs` pendentes para esse bloco). Para trabalho feito fora do CLI, o `sync-from-disk --only imagens` valida `blockNN.assets.json` + ficheiros em `renders/blockNN/` e grava o estado no SQLite.

**Plano por cenas (schema 2.0):** em `run-step` / `retry` com **`--scene-plan-v2`** (imagens) ou variável **`GENTUBE_SCENE_PLAN_V2=1`**, o Claude corre em dois passos (`Prompts/segmenta01.md`, `Prompts/visualiza01.md`), grava `blockNN.assets.json` com `schema_version: "2.0"` e `scenes[]`; `manual_capture` usa um PNG placeholder em `src/assets/manual_capture/placeholder.png` até substituíres; a narração grava um MP3 por cena em `02 - Narracao/blockNN/scXX.mp3` e **reutiliza** ficheiros já existentes (≥ 1 KiB) salvo com **`--force-narracao`**; opcionalmente junta `blockNN.mp3` com **ffmpeg** (`GENTUBE_FFMPEG_PATH` ou `experiments/ffmpeg-bin/ffmpeg`) — **sem ffmpeg não há segundo gasto de API**: não se gera monólito do bloco inteiro.

**Retoma sem gastar Claude de novo (imagens v2):**

- Se `blockNN.assets.json` já existe e é válido, o `retry --stage imagens` **reutiliza o plano** (não chama segmentação/visualização), salta cenas cujo ficheiro já está em `renders/blockNN/`, e só enfileira o que falta.
- Se existir `blockNN.assets.json.error` com falha na **visualização** e campo `segmentation_json`, o retry reutiliza segmentação + `raw_response` e só revalida localmente (útil quando o JSON era válido mas excedeu caps de imagens/vídeos — o código ajusta `image`→`video` quando possível).
- Em falha de parse, grava-se `03 - Imagens e Videos/blockNN.assets.json.error` com `parse_error`, `raw_response` e `unwrapped_for_json_parse` para inspeção; **não há retry automático** na API Claude. Em sucesso, o ficheiro passa a `blockNN.assets.json.error.resolved`.
- `GENTUBE_FORCE_VIZ_REGEN=1` força regerar plano e apaga jobs HF do bloco nessa execução.

**Lista de capturas manuais:** `npm run gentube -- shot-list-manual --project <id>` gera `shot_list_manual.md` / `.csv` a partir dos planos 2.0.

Detalhes: **secções 18.9, 18.10, 21, 24 e 26** de `ESPECIFICACAO_TECNICA.md`. Modalidade Wojak: **[wojak.md](wojak.md)**.

### Daemon e fila de jobs (branch `multiagent`)

Processa `run-pipeline` em **background** sem manter o terminal aberto. Fila em SQLite (`job_queue`); PID em `data/daemon.pid`, log em `data/daemon.log`.

```bash
# Enfileirar (perfil default: wojak-images-only — mesmo que run-pipeline Wojak)
npm run gentube -- job:add --project <slug> --voice-id <id>
npm run gentube -- job:add --project <slug> --voice-id <id> --from-stage imagens --priority 1

npm run gentube -- daemon:start          # detached
npm run gentube -- daemon:start --foreground   # debug no stdout
npm run gentube -- daemon:status
npm run gentube -- job:list --status pending
npm run gentube -- job:cancel --id 3
npm run gentube -- daemon:stop
```

Ao reiniciar o daemon, jobs `running` com PID morto passam a `failed` (`recoverStalledJobs`). Ver **sec. 26.10** da especificação.

### Claude Message Batches (roteiro + planos) — obrigatório em produção

O GenTube usa a **Message Batches API** da Anthropic para roteiro, segmentação e visualização (`GENTUBE_CLAUDE_DELIVERY=batch`, default). Custo ~**50%** do modo síncrono. **Imagens** continuam no **Google Batch** (`image:sync`) — são APIs diferentes.

| Variável | Default | Função |
|----------|---------|--------|
| `GENTUBE_CLAUDE_DELIVERY` | `batch` | `batch` ou `sync` (só debug local) |
| `GENTUBE_MAX_SCENES_DYNAMIC` | `1` | `max_scenes = min(100, ceil(palavras/22))` por bloco |
| `GENTUBE_MAX_WORDS_PER_SCENE` | `120` | Rejeita segmentação com “última cena gigante” |
| `GENTUBE_CLAUDE_MODEL_SEGMENTATION` | (opcional) | Ex.: `claude-sonnet-4-6` para planos |
| `GENTUBE_CLAUDE_THINKING_PLAN` | `disabled` | Seg/viz JSON — evita truncar saída |

**Fluxo por projeto:** roteiro (batch) → **quality_gate** (Sonnet, opcional regen) → imagens plano seg+viz (batch) → `image:sync` (Google) → narração (com cache TTS) → montagem.

**Roteiro em um único batch (8 blocos):** `GENTUBE_ROTEIRO_STAGE_BATCH=1` — ver sec. **26.4** da especificação (contexto entre blocos vazio na 1ª corrida).

```bash
npm run gentube -- claude:sync --project <slug> --watch   # batches Claude ainda pending (auxiliar)
```

**Erro típico bloco longo (ex. bloco 6):** JSON de visualização inválido = resposta truncada porque `max_scenes` fixo (50) forçou uma única cena com centenas de palavras. Com `GENTUBE_MAX_SCENES_DYNAMIC=1` e split de visualização (>70 cenas), o pipeline evita isso. Ver **secção 24** da especificação técnica.

**Modo Wojak v2 (resumo):** `GENTUBE_VISUAL_MODALITY=wojak` + `--scene-plan-v2`. Imagens estáticas → **Google Batch com PNG Wojak** (opção B, forçado no código); bootstrap de vídeo → sync; Veo → sync (`GENTUBE_WOJAK_VEO_USE_REF=0` por defeito). Estimativa: `npm run gentube -- cost-estimate --project <id>`. Produção: `plan-only` → `narracao` → `retry`/`imagens` → `image:sync --watch`. Se **quota Veo (429)** travar o `retry` no primeiro vídeo: `npx tsx scripts/continue-missing-renders.ts --project <id> --block N` + `image:sync`, depois `retry` quando a cota voltar. **Node 23** recomendado no PATH (`better-sqlite3`). Detalhes: [wojak.md](wojak.md).

### Build (TypeScript → `dist/`)

```bash
npm run build
npm start -- --help
```

## Onde ficam os arquivos

- Projetos gerados: `Videos/<slug-do-canal>/<YYYYMMDD-slug-do-titulo>/`
  - `01 - Roteiro/` — `blockXX.md` (só texto narrado; sem cabeçalho de bloco nem pergunta de “continuar”)
  - `02 - Narracao/` — `blockXX.mp3` (modo clássico) ou `blockXX/scYY.mp3` por cena (modo `--scene-plan-v2`)
  - `03 - Imagens e Videos/` — saídas do step **imagens**: mix de IA (Higgsfield e/ou Gemini) e stock (Magnific)
  - `04 - Thumbnails/` — thumbnails (HF ou Gemini): `thumb_ref_01.png` / `thumb_gen_01.png`
  - `05 - Modelagem/` — ex.: `transcript.txt` (transcricao de referência), `Thumbnail_<videoId>.jpg` (thumbnail de referência YouTube)
- Banco local: `data/gentube.db` (ignorado pelo Git)
- Template de referência: `Template/[Nome do Canal]/`
- `Transcripts/` — ficheiros UTF-8 de referência **locais** (não versionados; ver `.gitignore`). Exemplo: `--transcript-file Transcripts/minha-referencia.txt`

Arquivos gerados em `Videos/` e imagens em `Avatars/` **não** são versionados (ver `.gitignore`); no clone o diretório `Videos/` vem vazio. O mesmo vale para o conteúdo de `Transcripts/` (só `.gitkeep` no clone). O ficheiro `EXAMPLE.md` também é local-only — use-o como runbook privado.

### Produção mista: IA (Higgsfield + Gemini) + stock (Magnific / Pexels)

O step **imagens** combina até três fontes por cena:

- **Higgsfield (IA)**: imagens e **vídeos** (`nano_banana_flash`, `kling3_0`) — hook e momentos de maior impacto quando `GENTUBE_IMAGE_BACKEND` permite HF.
- **Google Gemini (IA)**: **só imagens** — sync, batch Google (`--google-batch-mode`) ou batch local (`--batch-local`); fallback ou produção principal conforme `.env` e flags.
- **Stock (Magnific e/ou Pexels)**: ilustrações e B-roll via `search_keywords` no plano; provedor em `GENTUBE_STOCK_PROVIDER`.

A proporção é configurável via `.env`:

| Variável | Default | Efeito |
|----------|---------|--------|
| `GENTUBE_STOCK_RATIO_BLOCK1` | `50` | 50% stock / 50% IA no bloco 1 |
| `GENTUBE_STOCK_RATIO_OTHER` | `90` | 90% stock / 10% IA nos blocos 2..N |

**Quantidade máxima de vídeos e imagens no plano** (step imagens — cada entrada no JSON conta para o teto antes dos renders): por defeito **bloco 1** = 16 vídeos e 20 imagens; **blocos 2..N** = 10 vídeos e 40 imagens. Ajuste com `GENTUBE_MAX_VIDEOS_BLOCK1`, `GENTUBE_MAX_IMAGES_BLOCK1`, `GENTUBE_MAX_VIDEOS_OTHER_BLOCKS`, `GENTUBE_MAX_IMAGES_OTHER_BLOCKS`. Na linha de comando, `--max-videos-block1`, `--max-images-block1`, `--max-videos-other` e `--max-images-other` em `run-step --step imagens` e `retry --stage imagens` **substituem** esses valores **nessa execução** (útil para testes sem alterar o `.env`).

O Claude decide **quais** shots são IA vs stock no plano de direção (`blockXX.assets.json`), priorizando IA para momentos de maior impacto visual e stock para o restante.

### Fila de imagens (`image_jobs`) e sync

**Planeado (migração opção B):** a tabela `image_jobs` unifica jobs HF e Gemini Batch (`provider`, `delivery_mode`, `external_id`, `batch_id`, `outcome`). A tabela legada `hf_cli_jobs` deixa de receber novas imagens; vídeos HF podem migrar depois.

Com `GENTUBE_HF_ASYNC` e backend HF, imagens `ai_generated` vão para a fila sem `--wait`. Conclua com **`image:sync`** (recomendado) ou **`higgsfield:sync`** (alias HF). Com `--google-batch-mode`, o submit é Batch API Google por **bloco** no pipeline; poll via `image:sync`. Stock (Magnific/Pexels) continua **síncrono** no `enqueue-only` / step imagens.

**Fases do step imagens (schema 2.0):** `--plan-only` (só Claude → `blockNN.assets.json`, todos os blocos); `--enqueue-only` (stock + filas + vídeos HF, **sem** submit por bloco); no fim do `enqueue-only` o CLI submete **N batches** Google (1 por bloco). Modo legado sem essas flags: plano + enqueue + submit **por bloco** como antes. `--plan-only` e `--enqueue-only` exigem `--scene-plan-v2` e são mutuamente exclusivas.

Requisitos:

- Binário **`hf`** instalado (ex.: pacote `@higgsfield/cli`) no `PATH`, ou variável **`HIGGSFIELD_CLI_PATH`** no `.env` com o caminho absoluto do executável.
- Credenciais no formato esperado pelo CLI Higgsfield (o GenTube também usa a API de agents para `higgsfield:status`; detalhes em `.env.example`).

Comandos úteis:

```bash
npm run gentube -- higgsfield:status
npm run gentube -- higgsfield:sync --project 1
npm run gentube -- higgsfield:sync --project 1 --watch --interval 20s
```

`--watch` repete rodadas de sync até não restarem jobs com `outcome=pending` (use Ctrl+C para parar antes). `--interval` aceita valores como `15s`, `2m` ou um número inteiro (segundos).

Para testes manuais, `higgsfield:generate` repassa argumentos ao `hf generate create` (inclua aspas no `--prompt` no shell).

## Documentação técnica

Regras de negócio, modelo de dados, contratos de comandos e decisões de implementação estão em:

**[ESPECIFICACAO_TECNICA.md](ESPECIFICACAO_TECNICA.md)** — proposta multi-agente (**sec. 25**); implementação P1–P8 (**sec. 26**, branch **`multiagent`**).

## Roadmap

- **Otimizações multiagent (P1–P8)** — QualityGate, cache TTS, dedup imagens, daemon/`job_queue`, batch roteiro por etapa — ver **sec. 26**.
- **Claude Message Batches** — implementado (`GENTUBE_CLAUDE_DELIVERY`, `claude:sync`, `max_scenes` dinâmico). Ver **sec. 24** da especificação.
- Roteiro 10 blocos / 1 porta (opcional) para alinhar matriz “10 portas” sem >100 cenas/bloco.
- Step **montagem** implementado: `run-step --step montagem` (ver **sec. 23** e `.env.example`).

## Licença

ISC (veja `package.json`). Ajuste aqui se mudar a licença do repositório.

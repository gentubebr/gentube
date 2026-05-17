# GenTube

CLI em **Node.js** para organizar projetos de vídeo no estilo YouTube: **roteiro** (Claude), **narração** (ElevenLabs), **imagens e vídeos** (direção Claude + produção mista **Higgsfield** / **Google Gemini** IA + Magnific stock), **thumbnails** (referência YouTube + avatar via HF ou Gemini), pastas por **canal** e histórico em **SQLite**.

---

## Por que usar

- Estrutura fixa de pastas por canal e por vídeo (`Videos/<canal>/<data>-<titulo>/`).
- Roteiro em blocos (`block01.md`, …) a partir do prompt em `Prompts/matriz.md` ou **`matriz_tutorial.md`** (`GENTUBE_ROTEIRO_MODE=tutorial`, `GENTUBE_PROMPT_MATRIX` ou `--prompt-matrix`). No **bloco 1**, o ficheiro opcional `Prompts/canal_voice.md` fixa voz/persona do canal; nos **blocos seguintes**, o texto dos `.md` anteriores entra como contexto de coesão (configurável; ver tabela de variáveis).
- Áudio por bloco (`block01.mp3`, …) alinhado ao roteiro.
- Status de cada etapa e de cada bloco gravados localmente (sem depender só de arquivos soltos).

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

### Magnific (stock — imagens e vídeos)

1. Conta / API em [Magnific](https://www.magnific.com/) (documentação da API B2B).
2. No `.env`: `MAGNIFIC_API_KEY`. Planos sem download premium podem falhar em parte dos assets (o pipeline faz fallback para IA — Higgsfield ou Gemini, conforme `GENTUBE_IMAGE_BACKEND`).
3. Stock **16:9**: a busca de vídeo usa `filters[aspect_ratio][]=16:9`; imagens usam metadados `source.size` e validação pós-download (`image-size`). Vídeos podem ser confirmados com **`ffprobe`** se estiver no `PATH` (pacote `ffmpeg`).

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

Segundo provedor de **imagens** (Nano Banana via `@google/genai`). **Vídeos** continuam só no Higgsfield (`kling3_0`).

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
| `MAGNIFIC_API_KEY` | Sim (step imagens) | API da Magnific/Freepik (stock footage e imagens) |
| `GENTUBE_STOCK_RATIO_BLOCK1` | Opcional | % de shots do bloco 1 vindos do stock Magnific (default: `50`) |
| `GENTUBE_STOCK_RATIO_OTHER` | Opcional | % de shots dos blocos 2..N vindos do stock (default: `90`) |
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
| `GENTUBE_FORCE_VIZ_REGEN` | Opcional | `1` / `true` / `yes`: força **nova** segmentação/visualização Claude e apaga jobs HF do bloco no retry (ignora `blockNN.assets.json` e `.error` no disco) |
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

> O arquivo `.env` não deve ser commitado (já está no `.gitignore`).

## Uso do CLI

Todos os exemplos abaixo usam `npm run gentube --`, que repassa os argumentos ao executável.

### Ajuda

```bash
npm run gentube -- --help          # ajuda geral (com exemplos no final)
npm run gentube -- help            # equivalente ao help do Commander
npm run gentube -- help run-step   # ajuda só do comando run-step
npm run gentube -- <comando> --help
```

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
  --mode iterativo

# Apagar um projeto sem prompts (scripts)
npm run gentube -- delete-project --project 2 --yes

# 4) Só roteiro ou só narração (use id numérico ou slug da pasta do projeto)
npm run gentube -- run-step --project 1 --step roteiro
npm run gentube -- run-step --project 1 --step roteiro --prompt-matrix matriz_tutorial.md --prompt-canal-voice canal_voice.md
npm run gentube -- run-step --project 1 --step narracao

# 4b) Step imagens — limites vêm do .env (GENTUBE_MAX_*); sobrescreva por corrida, ex.:
# npm run gentube -- run-step --project 1 --step imagens --max-videos-block1 12 --max-images-other 30

# 5) Roteiro + narração em sequência
npm run gentube -- run-all --project 1

# 6) Consultar status
npm run gentube -- status --project 1

# 6b) Imagens IA — batch Google (produção) ou HF async legado
npm run gentube -- run-step --project 1 --step imagens --google-batch-mode
npm run gentube -- image:sync --project 1 --watch --interval 60s
# HF legado (hf_cli_jobs → migrar para image_jobs):
npm run gentube -- higgsfield:sync --project 1

# 6c) Teste avulso Gemini (planeado)
npm run gentube -- gemini:image --prompt "cinematic 16:9 ..." --out ./out/teste.png
npm run gentube -- gemini:image --google-batch-mode --prompts-file prompts.txt --out-dir ./out
npm run gentube -- gemini:image --batch-local --prompts-file prompts.txt --out-dir ./out --concurrency 4

# 7) Gerar thumbnails (mesma política de imagem: --google-batch-mode, auto, etc.)
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

**Narração:** `run-step --step narracao` **já** ignora blocos com `narration_blocks.status === success` — depois do sync não se volta a gastar ElevenLabs nesses blocos.

**Imagens:** `run-step --step imagens` **salta blocos** em que `media_blocks` já tem plano e renders concluídos (e, em modo assíncrono, sem jobs `image_jobs` / `hf_cli_jobs` pendentes para esse bloco). Para trabalho feito fora do CLI, o `sync-from-disk --only imagens` valida `blockNN.assets.json` + ficheiros em `renders/blockNN/` e grava o estado no SQLite.

**Plano por cenas (schema 2.0):** em `run-step` / `retry` com **`--scene-plan-v2`** (imagens) ou variável **`GENTUBE_SCENE_PLAN_V2=1`**, o Claude corre em dois passos (`Prompts/segmenta01.md`, `Prompts/visualiza01.md`), grava `blockNN.assets.json` com `schema_version: "2.0"` e `scenes[]`; `manual_capture` usa um PNG placeholder em `src/assets/manual_capture/placeholder.png` até substituíres; a narração grava um MP3 por cena em `02 - Narracao/blockNN/scXX.mp3` e **reutiliza** ficheiros já existentes (≥ 1 KiB) sem voltar a chamar o ElevenLabs; opcionalmente junta `blockNN.mp3` com **ffmpeg** — **sem ffmpeg não há segundo gasto de API**: não se gera monólito do bloco inteiro.

**Retoma sem gastar Claude de novo (imagens v2):**

- Se `blockNN.assets.json` já existe e é válido, o `retry --stage imagens` **reutiliza o plano** (não chama segmentação/visualização), salta cenas cujo ficheiro já está em `renders/blockNN/`, e só enfileira o que falta.
- Se existir `blockNN.assets.json.error` com falha na **visualização** e campo `segmentation_json`, o retry reutiliza segmentação + `raw_response` e só revalida localmente (útil quando o JSON era válido mas excedeu caps de imagens/vídeos — o código ajusta `image`→`video` quando possível).
- Em falha de parse, grava-se `03 - Imagens e Videos/blockNN.assets.json.error` com `parse_error`, `raw_response` e `unwrapped_for_json_parse` para inspeção; **não há retry automático** na API Claude. Em sucesso, o ficheiro passa a `blockNN.assets.json.error.resolved`.
- `GENTUBE_FORCE_VIZ_REGEN=1` força regerar plano e apaga jobs HF do bloco nessa execução.

**Lista de capturas manuais:** `npm run gentube -- shot-list-manual --project <id>` gera `shot_list_manual.md` / `.csv` a partir dos planos 2.0.

Detalhes: **secções 18.9 e 21** de `ESPECIFICACAO_TECNICA.md`.

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

### Produção mista: IA (Higgsfield + Gemini) + Magnific (stock)

O step **imagens** combina até três fontes por cena:

- **Higgsfield (IA)**: imagens e **vídeos** (`nano_banana_flash`, `kling3_0`) — hook e momentos de maior impacto quando `GENTUBE_IMAGE_BACKEND` permite HF.
- **Google Gemini (IA)**: **só imagens** — sync, batch Google (`--google-batch-mode`) ou batch local (`--batch-local`); fallback ou produção principal conforme `.env` e flags.
- **Magnific (stock)**: ilustrações e transições genéricas.

A proporção é configurável via `.env`:

| Variável | Default | Efeito |
|----------|---------|--------|
| `GENTUBE_STOCK_RATIO_BLOCK1` | `50` | 50% stock / 50% IA no bloco 1 |
| `GENTUBE_STOCK_RATIO_OTHER` | `90` | 90% stock / 10% IA nos blocos 2..N |

**Quantidade máxima de vídeos e imagens no plano** (step imagens — cada entrada no JSON conta para o teto antes dos renders): por defeito **bloco 1** = 16 vídeos e 20 imagens; **blocos 2..N** = 10 vídeos e 40 imagens. Ajuste com `GENTUBE_MAX_VIDEOS_BLOCK1`, `GENTUBE_MAX_IMAGES_BLOCK1`, `GENTUBE_MAX_VIDEOS_OTHER_BLOCKS`, `GENTUBE_MAX_IMAGES_OTHER_BLOCKS`. Na linha de comando, `--max-videos-block1`, `--max-images-block1`, `--max-videos-other` e `--max-images-other` em `run-step --step imagens` e `retry --stage imagens` **substituem** esses valores **nessa execução** (útil para testes sem alterar o `.env`).

O Claude decide **quais** shots são IA vs stock no plano de direção (`blockXX.assets.json`), priorizando IA para momentos de maior impacto visual e stock para o restante.

### Fila de imagens (`image_jobs`) e sync

**Planeado (migração opção B):** a tabela `image_jobs` unifica jobs HF e Gemini Batch (`provider`, `delivery_mode`, `external_id`, `batch_id`, `outcome`). A tabela legada `hf_cli_jobs` deixa de receber novas imagens; vídeos HF podem migrar depois.

Com `GENTUBE_HF_ASYNC` e backend HF, imagens `ai_generated` vão para a fila sem `--wait`. Conclua com **`image:sync`** (recomendado) ou **`higgsfield:sync`** (alias HF). Com `--google-batch-mode`, o submit é Batch API Google por **bloco** no pipeline; poll via `image:sync`. Stock Magnific continua imediato.

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

**[ESPECIFICACAO_TECNICA.md](ESPECIFICACAO_TECNICA.md)**

## Roadmap

- Implementar `image_jobs`, `gemini:image`, `image:sync` e flags `--google-batch-mode` / `--batch-local` (spec sec. 22).
- Migrar imagens de `hf_cli_jobs` → `image_jobs`.
- Incluir steps no `run-all` ou comando `run-all --with-imagens`.

## Licença

ISC (veja `package.json`). Ajuste aqui se mudar a licença do repositório.

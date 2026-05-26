# GenTube — Especificacao tecnica

Documento de **requisitos, arquitetura e implementacao** do GenTube CLI (Node.js).

Para instalação, exemplos de uso e visão geral voltada a quem só quer rodar o projeto, use o **[README.md](README.md)**.

Este arquivo concentra o que é **funcional + tecnico** para manutenção e evolucao do codigo.

## 1) Objetivo

Automatizar, via terminal, a criacao de projetos de video YouTube com pipeline por etapas:

1. Roteiro
2. Narracao
3. Imagens ou Videos (implementado: direcao + producao Higgsfield; ver secao 18 e 16)
4. Thumbnails (implementado: com/sem referencia YouTube + Higgsfield direto; ver secao 19)
5. Montagem (FFmpeg: clipes por cena + bloco; ver secao 23)

Escopo da primeira entrega:

- Estrutura do projeto de video
- Etapa 1 (Roteiro com Claude)
- Etapa 2 (Narracao com ElevenLabs)
- Persistencia local em SQLite com status e logs de erro
- Execucao iterativa (por etapa) ou sequencial (pipeline completo)
- Exclusao completa de projeto (arquivos + dados no SQLite)

## 2) Estrutura de diretorios

### 2.1 Pasta base

- Todos os projetos ficam em `Videos/`.

### 2.2 Hierarquia com canal (conforme `Template/`)

- Estrutura alvo:
  - `Videos/<Nome do Canal>/<YYYYMMDD-Nome-do-video>/`
- Exemplo:
  - `Videos/Canal-Mindset/20260508-Como-criar-disciplina-sem-motivacao/`
- Recomendacao tecnica:
  - normalizar canal e video para slug sem acentos e sem caracteres especiais.

### 2.3 Estrutura interna do video (copiada do `Template/[Nome do Canal]/`)

Cada projeto deve conter:

- `01 - Roteiro/`
- `02 - Narracao/`
- `03 - Imagens e Videos/`
- `04 - Thumbnails/`
- `05 - Modelagem/` — arquivos de apoio (ex.: `transcript.txt` da transcricao usada como referencia de outro canal; gravado na criacao do projeto quando houver transcricao)
- `06 - Montagem/` — clipes por cena e blocos montados (step montagem; ver secao 23)

### 2.4 Estrutura de referencia do template

O template atual referencia o canal explicitamente:

- `Template/[Nome do Canal]/01 - Roteiro/`
- `Template/[Nome do Canal]/02 - Narracao/`
- `Template/[Nome do Canal]/03 - Imagens e Videos/`
- `Template/[Nome do Canal]/04 - Thumbnails/`
- `Template/[Nome do Canal]/05 - Modelagem/`

## 3) Experiencia do CLI (bonito e funcional)

O CLI deve ser amigavel, visual e objetivo:

- Tela inicial com nome do app e versao
- Menus claros para cadastrar canal, criar video, executar etapas, consultar status e excluir projeto
- Perguntas guiadas com validacao de entrada obrigatoria
- Indicadores visuais de progresso e status por bloco
- Resumo final com sucesso/erros e proximo passo sugerido

## 4) Entradas do usuario

### 4.0 Cadastro de canal (obrigatorio antes de criar video)

- O CLI deve permitir cadastrar canal.
- Cada video deve pertencer obrigatoriamente a um canal existente.
- O CLI nao deve oferecer remocao de canal.

### 4.1 Obrigatorias

- Titulo do video
- Nome do nicho (substitui `[NOME DO NICHO]` no prompt de roteiro em uso — por omissão `Prompts/matriz.md`)
- Publico alvo (substitui `[PUBLICO]` no prompt de roteiro em uso — por omissão `Prompts/matriz.md`)

### 4.2 Opcionais

- Transcricao de video externo (texto colado ou arquivo)

### 4.3 Quantidade de blocos

- Padrao: 8 blocos
- O CLI deve perguntar se o usuario deseja alterar
- Regra: cada bloco representa aproximadamente 5 a 6 minutos de video

## 5) Modos de execucao

### 5.1 Iterativo (por etapa)

- Usuario escolhe qual etapa executar
- Permite revisar resultado antes de seguir

### 5.2 Sequencial (pipeline)

- `run-all` (legado) executa: roteiro -> narracao apenas.
- **`run-pipeline`** (recomendado Wojak v2): roteiro -> imagens (plano v2 + batch) -> `image_sync` -> `imagens_retry` -> narracao -> montagem -> thumbnails, com rastreio em `pipeline_runs` / `pipeline_run_steps` e relatorio JSON em `05 - Modelagem/`.
- A etapa **imagens** isolada continua disponivel via `run-step --step imagens`.
- Interrompe em erro, mantendo rastreabilidade

## 6) Etapa 1 - Roteiro (Claude API)

### 6.1 Requisitos

- Prompt de roteiro: ficheiro **Markdown** sob `Prompts/`, escolhido por `resolvePromptMatrixPath()` em `src/config.ts`:
  - **Prioridade:** `--prompt-matrix` (CLI) > `GENTUBE_PROMPT_MATRIX` > `GENTUBE_ROTEIRO_MODE=tutorial` > default **`matriz.md`**.
  - **Padrão dissertativo:** `Prompts/matriz.md` quando nada acima fixa outro ficheiro.
  - **Modo tutorial:** defina `GENTUBE_ROTEIRO_MODE=tutorial` **e** deixe `GENTUBE_PROMPT_MATRIX` vazio (ou use explicitamente `GENTUBE_PROMPT_MATRIX=matriz_tutorial.md` / `--prompt-matrix matriz_tutorial.md`).
  - **Alternativa explícita:** `Prompts/matriz_tutorial.md` via `GENTUBE_PROMPT_MATRIX` ou `--prompt-matrix` nos comandos que geram roteiro.
  - O ficheiro deve resolver para um caminho **dentro** de `Prompts/` (segurança).
- Injetar: titulo, nicho, publico, transcricao opcional e quantidade de blocos
- Numero de blocos no prompt e substituido dinamicamente (`.replace(/dividido em \d+ blocos/i, ...)`)
- Modelo, max_tokens e thinking sao configurados via `.env`:
  - `CLAUDE_MODEL` (default: `claude-opus-4-7`)
  - `CLAUDE_MAX_TOKENS` (default: `16000`)
  - `CLAUDE_THINKING` — `adaptive` habilita extended thinking do Opus 4.7 (remove `temperature` da chamada, pois sao incompativeis); `disabled` ou vazio usa `temperature: 0.7` sem thinking

### 6.1.1 Retomada inteligente (skip de blocos concluidos)

Tanto `runRoteiro` quanto `runNarracao` verificam o status de cada bloco antes de processar. Se o bloco ja tem `status = "success"` no SQLite, ele e pulado com log informativo. Isso evita desperdicio de creditos (Claude/ElevenLabs) ao reexecutar apos uma interrupcao parcial.

### 6.1.2 `matriz_tutorial.md` (tutorial / aula)

- Ficheiro **`Prompts/matriz_tutorial.md`**: roteiro no estilo **tutorial** (roadmap, módulos, voz-over alinhável a demonstração no ecrã), em contraste com o tom “conversa profunda / narrativa” de `matriz.md`.
- **Seleção:** ordem em `resolvePromptMatrixPath`: `--prompt-matrix` > `GENTUBE_PROMPT_MATRIX` > `GENTUBE_ROTEIRO_MODE=tutorial` (usa `matriz_tutorial.md`) > default `matriz.md`.
- **Comandos:** `create-video` (quando `--mode sequencial`), `run-step --step roteiro`, `run-all`, `retry --stage roteiro` (etapa inteira ou `--block N`).
- **Registo:** ao iniciar roteiro, `project_logs` grava o caminho relativo do prompt usado.
- **Requisitos partilhados:** placeholders `[NOME DO NICHO]` e `[PUBLICO]`, saída em inglês, mesmas regras em `blockXX.md` (sem perguntas meta; `sanitizeScriptBlockContent`).

### 6.1.3 Voz do canal (bloco 1) e coesão entre blocos

- **`Prompts/canal_voice.md`** (ou outro ficheiro em `Prompts/`): texto fixo de **persona, tom e promessa do canal**, injetado no pedido ao Claude **apenas quando `block_number === 1`**, independentemente de usar `matriz.md` ou `matriz_tutorial.md`. Implementação: `resolveCanalVoicePath()` + `loadCanalVoiceForBlock1` em `src/services/pipeline.ts`, secção `channelVoiceContext` em `src/integrations/claude.ts`.
- **Seleção / desativação:** `GENTUBE_PROMPT_CANAL_VOICE` (nome ou caminho sob `Prompts/`), `--prompt-canal-voice` nos comandos de roteiro (`create-video` modo sequencial, `run-step --step roteiro`, `run-all`, `retry --stage roteiro`); valor `none` ou `-` não carrega ficheiro; `GENTUBE_ROTEIRO_CANAL_VOICE=0` desliga a funcionalidade.
- **Blocos 2..N — texto dos blocos anteriores:** antes de gerar o bloco *N*, o pipeline lê `01 - Roteiro/block01.md` … `block(N-1).md` e envia como contexto opcional (`previousBlocksText`). `GENTUBE_ROTEIRO_PREV_CONTEXT=0` desativa; `GENTUBE_ROTEIRO_PREV_CONTEXT_CHARS` limita o tamanho (default `100000`; `0` = ilimitado; truncagem mantém o fim).

### 6.2 Saida

- Salvar blocos em:
  - `01 - Roteiro/block01.md`
  - `01 - Roteiro/block02.md`
  - ...

### 6.3 Persistencia por bloco

- `pending | processing | success | error`
- conteudo do bloco
- timestamps de inicio/fim
- erro detalhado quando aplicavel

### 6.4 Regra de avancar etapa

- Etapa 2 so inicia se 100% dos blocos da etapa 1 estiverem `success`

### 6.5 Conteudo salvo em `blockXX.md`

- Apenas texto narrado (voz alta). Sem cabecalho tipo `# Block N`.
- Sem perguntas meta ao usuario (ex.: continuar, digitar ok) — o `matriz.md` e interativo; o CLI instrui o modelo e aplica `sanitizeScriptBlockContent` pos-resposta em `src/utils/sanitize-script-block.ts`.

### 6.6 Transcricao de referencia em disco

- Quando o projeto e criado com transcricao (interativo, `--transcript-file` ou `--transcript-text`), alem do campo no SQLite, o texto e gravado em `05 - Modelagem/transcript.txt`.

## 7) Etapa 2 - Narracao (ElevenLabs API)

### 7.1 Entrada

- Ler cada `blockXX.md` da etapa 1

### 7.2 Saida

- Salvar audios em:
  - `02 - Narracao/block01.mp3`
  - `02 - Narracao/block02.mp3`
  - ...

### 7.3 Persistencia por bloco

- `pending | processing | success | error`
- caminho do mp3
- timestamps de inicio/fim
- erro detalhado quando aplicavel

## 7A) Etapa 3 - Imagens e videos (visao geral)

- **Direcao**: Claude le `01 - Roteiro/blockXX.md` e grava o plano em `03 - Imagens e Videos/blockXX.assets.json` (ver secao 18). Modo **classico**: um JSON com `shots[]`; cada shot usa `source: "ai_generated"` ou `source: "stock"` conforme proporcao. Modo **`--scene-plan-v2` / `GENTUBE_SCENE_PLAN_V2`**: dois pedidos Claude (`segmenta01.md`, `visualiza01.md`), JSON com `schema_version: "2.0"` e `scenes[]`; cada cena pode usar `source` em `ai_generated`, `stock` ou `manual_capture` (placeholder PNG no repo ate gravacao).
- **Producao mista**:
  - Shots `ai_generated` → Higgsfield (`hf generate create`)
  - Shots `stock` → API Magnific e/ou Pexels (`GENTUBE_STOCK_PROVIDER`; busca por `search_keywords` + download)
- **Persistencia**: uma linha `media_blocks` por `(project_id, block_number)` com `plan_status`, `renders_status`, contadores de renders; jobs do CLI em `hf_cli_jobs` quando assincrono.
- **Politica criativa, modelos, limites e retry de shot**: secao 18. Proporcao IA/stock: secao 20.

## 8) Banco local SQL (SQLite)

### 8.1 Arquivo do banco

- Proposta: `data/gentube.db`

### 8.2 Tabelas

1. `video_projects`
   - id, channel_id, titulo, slug, data_projeto, project_path, total_blocos
   - status_roteiro, status_narracao, status_imagens_videos, status_thumbnails
   - created_at, updated_at

2. `channels`
   - id, nome_canal, slug_canal, base_path, created_at, updated_at

3. `script_blocks`
   - id, project_id, block_number, file_path_md, content_md
   - status, error_message, started_at, finished_at, created_at, updated_at

4. `narration_blocks`
   - id, project_id, block_number, source_script_block_id, file_path_mp3
   - status, error_message, started_at, finished_at, created_at, updated_at

5. `project_logs`
   - id, project_id, stage, level, message, details_json, created_at

6. `media_blocks` (step 3 — por bloco)
   - id, project_id, block_number, assets_json_path
   - plan_status, plan_error
   - renders_status, renders_done_count, renders_total_count
   - started_at, finished_at, created_at, updated_at
   - UNIQUE(project_id, block_number)

7. `hf_cli_jobs` (**legado** — videos HF e imagens antigas; migracao para `image_jobs`)
   - id, project_id, block_number, shot_id, asset_type (`image`|`video`)
   - out_path_no_ext, hf_job_id (UNIQUE), hf_status
   - outcome (`pending`|`done`|`failed`), result_url, error_message, downloaded_at
   - created_at, updated_at

8. `image_jobs` (**aprovado** — fila unificada de imagens; ver secao **22**)
   - id, project_id, block_number (`0` = thumbnails), shot_id, asset_type (`image`)
   - provider (`higgsfield`|`gemini`), delivery_mode (`sync`|`google_batch`|`local_batch`)
   - external_id, batch_id, out_path_no_ext, status, outcome
   - result_mime, error_message, reference_image_path, downloaded_at
   - created_at, updated_at

## 9) Operacoes de CLI (contrato funcional)

- `gentube init`
  - configuracao guiada: `.env`, pastas, opcao de informar API keys e cadastrar primeiro canal

- `gentube create-video`
  - cria projeto vinculado a um canal existente e coleta entradas obrigatorias
  - permite escolher `iterativo` ou `sequencial` (ou `--mode`)
  - flags opcionais (omita para prompts interativos):
    - `--channel <id>` — ID do canal (`channel:list`)
    - `--title`, `--niche`, `--audience`
    - `--blocks <n>` — total de blocos (1–64)
    - `--transcript-file <caminho>` — arquivo UTF-8 com transcricao ou notas de video de referencia (estrutura e mensagens-chave; o modelo e instruido a nao copiar texto)
    - `--transcript-text <texto>` — mesmo papel em uma linha (textos longos: usar arquivo)
    - nao usar `transcript-file` e `transcript-text` juntos
    - `--mode iterativo|sequencial`
    - `--prompt-matrix <ficheiro>` — prompt da etapa roteiro (`Prompts/…`; sobrescreve `GENTUBE_PROMPT_MATRIX`; relevante se `--mode sequencial`)
    - `--prompt-canal-voice <ficheiro>` — voz do canal para o **bloco 1** (`Prompts/…`; default `canal_voice.md`; `none` não injeta; sobrescreve `GENTUBE_PROMPT_CANAL_VOICE`)

- `gentube channel:create`
  - cadastra um novo canal para organizar os videos

- `gentube channel:list`
  - lista canais cadastrados

- `gentube projects:list [--json]`
  - lista **canais** e, sob cada um, os **projetos** (`video_projects`): id do projeto, titulo, slug, blocos, estados das etapas e caminho da pasta
  - `--json`: saida estruturada (array de canais com `projects[]`) para scripts

- `gentube run-step --project <id|slug> --step <roteiro|narracao|imagens|thumbnails> [--prompt-matrix <ficheiro>] [--prompt-canal-voice <ficheiro>] [--google-batch-mode] [--batch-local] [--scene-plan-v2]`
  - executa uma unica etapa
  - **roteiro**: `--prompt-matrix` escolhe o ficheiro em `Prompts/` (padrao `matriz.md`); `--prompt-canal-voice` define o Markdown de voz do canal no **bloco 1** (padrao `canal_voice.md` quando a funcionalidade esta ativa)
  - **imagens**: direcao (Claude -> `blockXX.assets.json`) + producao IA/stock. Flags de imagem: **`--google-batch-mode`** (Batch API Google, um job por **bloco** no pipeline) e **`--batch-local`** (testes, concorrencia local); **mutuamente exclusivas**. Sem batch: sync ou HF async legado conforme `GENTUBE_IMAGE_*`. Poll: `image:sync`. Limites: **18.2.1**, **18.7.1**, secao **22**.
  - **thumbnails**: mesma politica de provedor/entrega que imagens (`--google-batch-mode`, `auto`, etc.); `block_number=0` em `image_jobs`. Flags: `--reference-url`, `--avatar-file`, `--count`, `--prompt`.

- `gentube gemini:image` (**planeado** — testes avulsos)
  - Um prompt: **sync** por defeito (`--prompt`, `--out`)
  - Varias imagens: **`--google-batch-mode`** + `--prompts-file` + `--out-dir`, ou **`--batch-local`** + `--concurrency`
  - `--reference <path>` para consistencia multimodal (avatar)
  - Escopo batch manual: agrupar por **projeto** (nao por bloco)

- `gentube image:sync [--project <id|slug>] [--provider all|higgsfield|gemini] [--watch] [--interval]` (**planeado**)
  - Poll unificado de `image_jobs` (HF get + Gemini batch)
  - `gentube higgsfield:sync` permanece como alias HF ate migracao completa

- `gentube image:status --project <id|slug>` (**planeado**)
  - Resumo pending/done/failed por provider

- `gentube run-all --project <id|slug> [--prompt-matrix <ficheiro>] [--prompt-canal-voice <ficheiro>]`
  - executa pipeline completo das etapas **roteiro** e **narracao** (nao inclui imagens automaticamente)
  - `--prompt-matrix` e `--prompt-canal-voice` aplicam-se ao roteiro da mesma forma que em `run-step`

- `gentube higgsfield:status [--json]`
  - consulta conta/creditos via API de agents (Bearer a partir de `credentials.json` do CLI)

- `gentube higgsfield:generate ...`
  - repassa argumentos ao `hf generate create` (testes manuais; opcoes desconhecidas permitidas)

- `gentube higgsfield:sync [--project <id|slug>] [--max-jobs <n>] [--watch] [--interval <dur>]`
  - modo assincrono: para cada linha `hf_cli_jobs` com `outcome=pending`, executa `hf generate get`, baixa `result_url` para `out_path_no_ext`, atualiza SQLite e estados do bloco/projeto
  - `--watch`: repete ate nao haver pendentes (pausa `--interval`; Ctrl+C encerra)

- `gentube retry --project <id|slug> --stage <roteiro|narracao|imagens|thumbnails> [--block N] [--voice-id ...] [--prompt-matrix <ficheiro>] [--prompt-canal-voice <ficheiro>]`
  - sem `--block`: reprocessa a etapa inteira
  - com `--block N` (1-based): reprocessa apenas o bloco N (roteiro, narracao ou imagens)
  - `--voice-id` aplica-se a **narracao**; flags de limite do step 3 (`--max-videos-*`, `--max-images-*`, `--avatar-file`) aplicam-se a **imagens**
  - `--prompt-matrix` e `--prompt-canal-voice` aplicam-se quando `--stage roteiro`
  - **thumbnails**: aceita `--reference-url`, `--avatar-file`, `--count`

- `gentube elevenlabs:status [--json]`
  - exibe uso de caracteres do periodo atual: usados, limite, restantes e data de reset
  - `--json`: saida em JSON bruto

- `gentube status --project <id|slug>`
  - mostra status consolidado e detalhado por bloco

- `gentube copy-cmd --project <id|slug> [--remote-host <host>] [--local-dir <caminho>] [--dry-run]`
  - gera e imprime o comando `rsync` para copiar a pasta do projeto do servidor remoto para a maquina local
  - `--remote-host`: host SSH (ex.: `dev-development`). Se omitido, usa `GENTUBE_REMOTE_HOST` do `.env`
  - `--local-dir`: diretorio local de destino; padrao: mesmo caminho relativo ao workspace
  - `--dry-run`: adiciona `--dry-run` ao rsync (simula sem copiar)

- `gentube delete-project --project <id|slug> [-y|--yes]`
  - remove projeto completo; sem `--yes`, pede confirmacao dupla; com `--yes`, remove direto (cuidado em producao)

Observacao:

- Nao existe comando para remover canal nesta fase.

## 10) Exclusao completa do projeto

Ao excluir:

1. Confirmacao explicita (dupla confirmacao)
2. Remover pasta fisica do projeto em `Videos/...`
3. Remover registros relacionados no SQLite:
   - `video_projects`
   - `script_blocks`
   - `narration_blocks`
   - `media_blocks`
   - `hf_cli_jobs`
   - `project_logs`
4. Exibir resultado final da operacao

Regras:

- Operacao transacional no banco quando aplicavel
- Em falha parcial, exibir erro claro e registrar log
- A exclusao remove somente o projeto de video; o canal permanece cadastrado

## 11) Integracoes e ambiente

Variaveis em `.env`:

- `CLAUDE_API_KEY`
- `CLAUDE_MODEL` (opcional): modelo Claude — default `claude-opus-4-7`
- `CLAUDE_MAX_TOKENS` (opcional): limite de tokens de saida — default `16000`
- `CLAUDE_THINKING` (opcional): `adaptive` (Opus 4.7, extended thinking, sem temperature), `disabled` ou vazio (sem thinking, com temperature)
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID` (opcional): voice padrao quando `--voice-id` nao e passado no CLI
- `MAGNIFIC_API_KEY`: chave da API Magnific (ex-Freepik) para busca e download de stock footage/imagens
- `PEXELS_API_KEY`: chave da API [Pexels](https://www.pexels.com/api/documentation/) (stock alternativo)
- `GENTUBE_STOCK_PROVIDER` (opcional): `magnific` (default), `pexels`, `magnific_then_pexels`, `pexels_then_magnific`, `local_then_pexels_then_magnific`, `local_then_pexels_then_split` — ver secao **20.6** / **20.6.1**
- `GENTUBE_STOCK_SPLIT_MAGNIFIC_PERCENT` (opcional): percentual `X` do fallback split para Magnific no modo `local_then_pexels_then_split` (default `60`)
- `GENTUBE_STOCK_SPLIT_GOOGLE_BATCH_PERCENT` (opcional): percentual `Y` do fallback split para Google Batch no modo `local_then_pexels_then_split` (default `40`; `X + Y = 100`)
- `GENTUBE_STOCK_LIBRARY_FTS_MIN_SCORE` (opcional): limiar de match FTS no reuso local (default conservador `0.60`)
- `GENTUBE_STOCK_LIBRARY_MIN_TERMS` (opcional): minimo de termos na regressao de keywords para match local/remoto (default `3`)
- `GENTUBE_STOCK_RATIO_BLOCK1` (opcional): % de shots do bloco 1 com `source: stock` (default: `50`)
- `GENTUBE_STOCK_RATIO_OTHER` (opcional): % de shots dos blocos 2..N com stock (default: `90`)
- `GENTUBE_PROMPT_MATRIX` (opcional): ficheiro do roteiro em `Prompts/`; tem prioridade sobre `GENTUBE_ROTEIRO_MODE`
- `GENTUBE_ROTEIRO_MODE` (opcional): `tutorial` usa `matriz_tutorial.md` quando `GENTUBE_PROMPT_MATRIX` esta vazio e nao ha `--prompt-matrix`; caso contrario o default do ficheiro e `matriz.md`
- `GENTUBE_PROMPT_CANAL_VOICE` (opcional): ficheiro Markdown em `Prompts/` com voz do canal para o **bloco 1** do roteiro (default `canal_voice.md` quando a injecao esta ativa); `none` nao carrega
- `GENTUBE_ROTEIRO_CANAL_VOICE` (opcional): `0` / `false` / `off` desliga injecao de voz do canal
- `GENTUBE_ROTEIRO_PREV_CONTEXT` (opcional): `0` / `false` / `off` desliga contexto dos blocos anteriores no roteiro (blocos 2..N)
- `GENTUBE_ROTEIRO_PREV_CONTEXT_CHARS` (opcional): teto de caracteres do contexto cumulativo dos blocos anteriores (default `100000`; `0` = ilimitado)
- `GENTUBE_MAX_VIDEOS_BLOCK1`, `GENTUBE_MAX_IMAGES_BLOCK1` (opcionais): caps do plano no **bloco 1** (defaults: **16** videos, **20** imagens)
- `GENTUBE_MAX_VIDEOS_OTHER_BLOCKS`, `GENTUBE_MAX_IMAGES_OTHER_BLOCKS` (opcionais): caps nos **blocos 2..N** (defaults: **10** videos, **40** imagens)
- `GENTUBE_SCENE_PLAN_V2` (opcional): `1` / `true` / `yes` ativa plano por cenas no step imagens (equivalente a `--scene-plan-v2` quando a flag nao e passada)
- `GENTUBE_FORCE_VIZ_REGEN` (opcional): `1` / `true` / `yes` forca nova segmentacao/visualizacao Claude no retry e apaga jobs do bloco na fila HF/imagem; sem isto, reutiliza `blockXX.assets.json` e/ou `.error` quando aplicavel
- `GENTUBE_HF_ASYNC` (opcional): habilita enfileiramento HF sem `--wait` no step imagens (legado; ver migracao **22**)
- `GEMINI_API_KEY` (obrigatoria se usar Gemini): chave Google GenAI; alias aceite: `google_api_key`
- `google_project_name`, `google_parent_folder_id` (opcionais): Vertex / Batch API Google
- `GEMINI_IMAGE_MODEL` (opcional): default `gemini-2.5-flash-image`
- `GEMINI_IMAGE_MODEL_PRO` (opcional): ex. `gemini-3-pro-image-preview` para alta resolucao
- `GENTUBE_IMAGE_BACKEND` (opcional): `auto` | `higgsfield` | `gemini` (default `auto`)
- `GENTUBE_IMAGE_DELIVERY` (opcional): `sync` | `google_batch` | `local_batch` (default producao: `google_batch`)
- `GENTUBE_GEMINI_BATCH_SCOPE` (opcional): `block` no pipeline (default); CLI `gemini:image` pode agrupar por projeto
- `GENTUBE_GEMINI_BATCH_POLL_INTERVAL` (opcional): ex. `60s` para `image:sync`
- `GENTUBE_GEMINI_LOCAL_CONCURRENCY` (opcional): default `4` para `--batch-local`
- `GENTUBE_GEMINI_IMAGE_ASPECT_RATIO` (opcional): default `16:9`
- `GENTUBE_GEMINI_IMAGE_SIZE` (opcional): default `1K`
- `HIGGSFIELD_CLI_PATH` (opcional): caminho absoluto do executavel `hf` se nao estiver no PATH
- `HIGGSFIELD_CREDENTIALS_PATH` (opcional): sobrescreve `~/.config/higgsfield/credentials.json`
- `HIGGSFIELD_CLI_WAIT_TIMEOUT` (opcional): timeout do `--wait` no modo sincrono (ex.: `15m`)
- `HIGGSFIELD_API_URL` (opcional): base da API de agents (padrao `https://fnf.higgsfield.ai`)
- `HIGGSFIELD_API_KEY_ID` / `HIGGSFIELD_API_KEY_SECRET` (opcional): modulo legado HTTP `src/integrations/higgsfield.ts`; **nao** usados pelo pipeline do step 3

Diretrizes:

- Nunca logar chaves no terminal
- Sanitizar erros antes de exibir ao usuario

Politica de versionamento (Git):

- `Videos/` — apenas `Videos/.gitkeep` no repositorio; projetos gerados e midias ficam locais (ignorados).
- `Avatars/` — ignorado por completo; avatares nao devem ser commitados nem aparecer no remoto.
- `scripts/` — ignorado (automacao local).
- `Transcripts/` — conteúdo local (ignorado no Git; só `Transcripts/.gitkeep` no clone)
- `Template/` — versionado (estrutura de pastas do canal modelo).

## 12) Arquitetura tecnica proposta (Node.js)

### 12.1 Stack

- Runtime: Node.js LTS
- Linguagem: TypeScript (recomendado) ou JavaScript
- CLI framework: `commander` ou `oclif`
- UI terminal: `@inquirer/prompts` + `ora` + `chalk` (ou equivalente)
- Banco: `sqlite3` ou `better-sqlite3` + camada de repositorio
- HTTP: `fetch` nativo (Node 18+) ou `axios`

### 12.2 Modulos sugeridos

- `src/cli/` comandos e parse de argumentos
- `src/core/` regras de negocio por etapa
- `src/integrations/claude/` cliente Claude
- `src/integrations/elevenlabs/` cliente ElevenLabs
- `src/integrations/higgsfield-cli.ts` — execucao do CLI `hf` (create/get, sync e async)
- `src/integrations/higgsfield-agents.ts` — HTTP agents (status), resolucao do binario `hf`
- `src/integrations/magnific.ts` — busca e download de stock via API Magnific
- `src/integrations/pexels.ts` — busca e download de stock via API Pexels
- `src/integrations/stock-download.ts` — facade `searchAndDownload` (Magnific + Pexels + fallback + variantes de keywords)
- `src/utils/stock-media.ts` — keywords, 16:9, FFmpeg crop, download HTTP partilhado
- `src/services/hf-cli-sync.ts` — sincronizacao legada de `hf_cli_jobs`
- `src/integrations/gemini-image.ts` — sync inline Gemini (**planeado**)
- `src/integrations/gemini-batch.ts` — submit/poll Batch API Google (**planeado**)
- `src/services/image-generation.ts` — backend, fallback HF→Gemini (**planeado**)
- `src/services/image-sync.ts` — poll `image_jobs` (**planeado**)
- `src/services/image-local-batch.ts` — worker batch local (**planeado**)
- `src/db/` conexao, migrations e repositorios
- `src/services/` orchestrator de pipeline
- `Prompts/matriz.md` — prompt base da etapa **roteiro** (carregado pelo código)
- `Prompts/matriz_tutorial.md` — variante **tutorial / aula**; ver secao **6.1.2** (sem selector no codigo)
- `Prompts/matriz02.md` — prompt da etapa **imagens** (plano de assets)
- `src/utils/youtube.ts` — extracao de video ID e download de thumbnail do YouTube
- `src/utils/` slug, datas, logs, validacoes

## 13) Status e observabilidade

- Status padrao: `pending`, `processing`, `success`, `error`
- Toda etapa e bloco devem escrever log em `project_logs`
- Console deve mostrar:
  - inicio de etapa
  - progresso por bloco
  - erro com contexto minimo util
  - resumo final

## 14) Criterios de aceite (MVP)

1. Permitir cadastro de canal e listagem de canais
2. Criar projeto de video vinculado a canal, com estrutura identica ao template de canal
3. Solicitar obrigatoriamente titulo, nicho e publico
4. Permitir escolher quantidade de blocos
5. Gerar blocos de roteiro e salvar `blockXX.md`
6. Gerar narracao e salvar `blockXX.mp3`
7. Persistir status e erros no SQLite
8. Suportar execucao iterativa e sequencial
9. Permitir excluir projeto completo (arquivos + banco), sem remover canal

## 15) Itens para fase seguinte

- Refinar etapa 3 (imagens): UX, mais providers, afinar defaults e observabilidade
- Opcional: incluir step **imagens** no `run-all` ou comando dedicado `run-all --with-imagens`

## 16) Status atual da implementacao

Implementado no codigo em `src/`:

- Base do CLI com comandos:
  - `init` (setup guiado)
  - `channel:create`
  - `channel:list`
  - `projects:list` (`--json` opcional; dados via `listProjectsSummary` em `repository.ts`)
  - `create-video`
  - `run-step` (inclui `--step imagens`)
  - `run-all`
  - `status`
  - `delete-project`
  - `sync-from-disk` (alinhamento SQLite com `01 - Roteiro`, `02 - Narracao`, `03 - Imagens`; `--dry-run`, `--only`, `--force`)
  - `retry` (etapa inteira ou `--block N`; apos cada bloco, `status_roteiro` / `status_narracao` e recalculado no SQLite; **imagens** e **thumbnails** tambem suportados)
  - `elevenlabs:status` (uso de caracteres do periodo)
  - `higgsfield:status`, `higgsfield:generate`, `higgsfield:sync` (integracao Higgsfield)
- Step **thumbnails**: fluxo (A) com referencia YouTube + fluxo (B) sem referencia:
  - Download da thumbnail de referencia → `05 - Modelagem/Thumbnail_<videoId>.jpg`
  - Imagens (referencia + avatar) passadas diretamente ao Higgsfield via multiplos `--image`
  - Geracoes salvas em `04 - Thumbnails/`
  - Suporte a modo assincrono (`GENTUBE_HF_ASYNC=1` + `higgsfield:sync`)
- Banco SQLite local com tabelas:
  - `channels`
  - `video_projects`
  - `script_blocks`
  - `narration_blocks`
  - `media_blocks`
  - `hf_cli_jobs`
  - `project_logs`
- Pipeline funcional:
  - Geracao de roteiro com Claude (bloco a bloco, salvando `blockXX.md`; prompt via `resolvePromptMatrixPath` — `GENTUBE_PROMPT_MATRIX`, `GENTUBE_ROTEIRO_MODE`, `--prompt-matrix`; voz do canal no bloco 1 via `canal_voice.md` / `GENTUBE_PROMPT_CANAL_VOICE` / `--prompt-canal-voice`; contexto dos blocos anteriores nos blocos 2..N — `GENTUBE_ROTEIRO_PREV_CONTEXT*`)
  - Geracao de narracao com ElevenLabs (salvando `blockXX.mp3`)
  - Step **imagens**: plano em `blockXX.assets.json`, renders via CLI Higgsfield; modo **sincrono** (`hf ... --wait --json`) ou **assincrono** (`GENTUBE_HF_ASYNC`, jobs em `hf_cli_jobs` + `higgsfield:sync` / `--watch`); **blocos ja concluidos no SQLite sao saltados** ao voltar a correr o step (ver secao 21)
- Estrutura de projeto por canal em:
  - `Videos/<canal>/<YYYYMMDD-video>/...`
- Exclusao de projeto:
  - remove arquivos do projeto
  - remove registros relacionados no SQLite (inclui `media_blocks` e `hf_cli_jobs`)

## 17) Ajuda do CLI (UX)

Comportamento implementado em `src/index.ts`:

- **Sem argumentos** (`npm run gentube --`): imprime banner, dica `init`, `--help` e lista de comandos (`outputHelp`).
- **`--help` / `-h`**: ajuda geral em portugues (descricoes longas por subcomando).
- **`help [comando]`**: ajuda do Commander para um subcomando (ex.: `help run-step`).
- Apos **erro de opcao obrigatoria** ou comando invalido: mensagem extra sugerindo `--help` ou `help <comando>` (`showHelpAfterError`).
- Bloco **Exemplos** e referencia a `README.md` / `ESPECIFICACAO_TECNICA.md` no rodape da ajuda (`addHelpText('after', ...)`).
- **`configureHelp({ sortSubcommands: true })`**: comandos listados em ordem alfabetica na ajuda.
- **Versao**: lida de `package.json` via `src/version.ts` (`-V, --version`).

## 18) Politica aprovada — Step 3 (Imagens e Videos)

Este step sera implementado em duas tarefas internas por bloco:

1. **Direcao (Claude)**: ler `01 - Roteiro/blockXX.md` e gerar `03 - Imagens e Videos/blockXX.assets.json`.
2. **Producao (Higgsfield)**: ler `blockXX.assets.json` e gerar arquivos de imagem/video locais em `03 - Imagens e Videos/`.

### 18.1 Objetivo

- Produzir plano visual coerente com o texto do bloco.
- Executar renders com controle de custo (mais videos no bloco 1; mais imagens nos blocos seguintes).
- Permitir retry por etapa sem reprocessar roteiro/narracao.

### 18.2 Regras criativas por bloco

- **Bloco 1**:
  - e o bloco de maior impacto/retencao.
  - usar maior frequencia de videos (intercalados com imagens estaticas).
  - cenas humanas e de cotidiano do publico para gerar identificacao.
- **Blocos 2..N**:
  - priorizar imagens estaticas.
  - usar poucos videos, apenas quando houver ganho claro de atencao.
  - manter quantidade de imagens maior que de videos.

### 18.2.1 Limites maximos por bloco (aprovado)

- **Bloco 1**:
  - max videos: **16** (default; `.env` `GENTUBE_MAX_VIDEOS_BLOCK1`)
  - max imagens: **20** (default; `.env` `GENTUBE_MAX_IMAGES_BLOCK1`)
- **Blocos 2..N**:
  - max videos: **10** (default; `.env` `GENTUBE_MAX_VIDEOS_OTHER_BLOCKS`)
  - max imagens: **40** (default; `.env` `GENTUBE_MAX_IMAGES_OTHER_BLOCKS`)
  - regra adicional: max imagens deve ser maior que max videos.

Os valores efetivos ao correr o CLI sao lidos de `src/config.ts` (`DEFAULT_MAX_*`), que por sua vez leem o `.env` na arranque do processo. **Prioridade na corrida:** flags `--max-videos-block1`, `--max-images-block1`, `--max-videos-other`, `--max-images-other` em `run-step --step imagens` e `retry --stage imagens` **substituem** esses numeros **nessa execução** (sem alterar o `.env`).

### 18.3 Regras de duracao e IP

- Duracao de video padrao: ate **7s**.
- Para referencias com risco de propriedade intelectual (personalidades, marcas, ativos protegidos): limitar a **5s**.
- Preferir descricoes genericas e evitar logos/marcas explicitas.

### 18.4 Defaults tecnicos aprovados

- **Imagem (default)**:
  - `model`: `nano_banana_flash`
  - `aspect_ratio`: `16:9`
  - `resolution`: `1k`
- **Video (default)**:
  - `model`: `kling3_0`
  - `duration`: `5`
  - `aspect_ratio`: `16:9`
  - `resolution`: `720p` (politica interna)
  - `mode`: `std`
  - `sound`: `off`

Observacao tecnica:

- No schema publicado de `kling3_0`, `resolution` pode nao estar disponivel como argumento formal.
- Regra do executor: enviar apenas campos suportados pelo modelo e ignorar campos nao suportados para evitar falha de request.

### 18.5 Retry aprovado para producao de shots

Para cada shot de imagem/video:

1. tentativa inicial;
2. **1o retry**: mesmo payload (reenvio);
3. **2o retry**: igual ao 1o retry (sem trocar modelo, modo ou prompt);
4. se falhar novamente: marcar shot como `error` e seguir politica de status do bloco/projeto.

### 18.6 Consistencia visual com avatar opcional

- Parametro opcional: `--avatar-file <caminho>` (ex.: `Avatars/lou01.jpeg`).
- Com avatar:
  - ativar modo de consistencia de personagem entre shots.
  - usar o avatar como referencia quando suportado pelo modelo.
- Sem avatar:
  - usar consistencia por estilo textual (modo generico).

### 18.7 Entregaveis por bloco no step 3

- `03 - Imagens e Videos/blockXX.assets.json` (direcao aprovada para producao)
- arquivos renderizados locais de imagem/video (nomenclatura a ser definida na implementacao)

### 18.7.1 Flags de limite no CLI e `.env` (step imagens)

- `.env` (opcional): `GENTUBE_MAX_VIDEOS_BLOCK1`, `GENTUBE_MAX_IMAGES_BLOCK1`, `GENTUBE_MAX_VIDEOS_OTHER_BLOCKS`, `GENTUBE_MAX_IMAGES_OTHER_BLOCKS` — ver **18.2.1**.
- CLI (opcional, por execucao):
  - `--max-videos-block1 <n>`
  - `--max-images-block1 <n>`
  - `--max-videos-other <n>`
  - `--max-images-other <n>`

Uso:

- disponiveis em `run-step --step imagens` e `retry --stage imagens`.
- quando as quatro flags estao omitidas, usam-se os valores exportados de `src/config.ts` (que refletem o `.env` carregado no arranque).

### 18.8 Resumo da integracao Higgsfield (implementacao)

- **Step 3 (producao)** usa o **CLI oficial** (`hf`) com `hf generate create` e saida `--json`, com os mesmos creditos da conta web.
- **Autenticacao**: fluxo do proprio CLI (ex.: `higgsfield auth login`); arquivo tipico `~/.config/higgsfield/credentials.json`, sobrescrito por `HIGGSFIELD_CREDENTIALS_PATH` se definido.
- **Binario**: deve estar no `PATH` ou em `HIGGSFIELD_CLI_PATH` (o codigo tenta candidatos comuns, ex. `node_modules/@higgsfield/cli/vendor/hf`).
- **Modo sincrono** (padrao quando `GENTUBE_HF_ASYNC` esta vazio/falso): `create` com `--wait` e `--json`; timeout configuravel `HIGGSFIELD_CLI_WAIT_TIMEOUT` (padrao interno `15m`).
- **Modo assincrono** (`GENTUBE_HF_ASYNC` em `1`, `true` ou `yes`): `create` **sem** `--wait`; o stdout JSON com array de UUIDs e persistido em `hf_cli_jobs` (`outcome=pending`). O projeto/bloco pode ficar com `renders_status=awaiting_hf` ate a sincronizacao.
- **Sincronizacao**: comando `gentube higgsfield:sync` (`src/services/hf-cli-sync.ts`) chama `hf generate get <id> --json`, baixa `result_url` para o caminho base `out_path_no_ext` (extensao inferida), atualiza `hf_cli_jobs` e recalcula progresso do bloco/projeto (`finalizeBlockIfDone`, `recomputeImagensVideosStage`).
- **`higgsfield:sync --watch`**: repete rodadas ate `COUNT(*) WHERE outcome='pending'` ser zero (filtro opcional `--project`); intervalo `--interval` (ex. `30s`, `2m`).
- **`higgsfield:status`**: `GET` na API de agents (`HIGGSFIELD_API_URL`, padrao `https://fnf.higgsfield.ai`) com Bearer derivado das credenciais do CLI — alinhado ao que `hf account status` usa.
- **Modulo legado** `src/integrations/higgsfield.ts`: HTTP com `HIGGSFIELD_API_KEY_ID` / `SECRET`; **nao** entra no pipeline do step 3 atual.
- Modelos e parametros base definidos na secao 18.4; o executor envia apenas flags suportadas pelo modelo (ex.: `kling3_0` sem `resolution` quando o schema publicado nao expoe o campo).

### 18.9 Plano por cenas (schema 2.0) — fluxo, caps, debug e retoma

**Implementacao:** `src/utils/scenes-plan.ts`, `src/services/pipeline.ts` (`imagensBlockPlanAndRenderV2`), prompts `Prompts/segmenta01.md` e `Prompts/visualiza01.md`, tipos em `src/types/scenes-plan.ts`.

**Fluxo por bloco:**

1. **Segmentacao** (`schema_version: "2.0-segmentation"`): Claude devolve cenas com `narration_text` verbatim alinhado ao `blockXX.md`.
2. **Visualizacao** (`schema_version: "2.0-visualization"`): segundo pedido Claude com o JSON da segmentacao; merge local produz `blockXX.assets.json` (`schema_version: "2.0"`, `scenes[]` com `visual`).
3. **Producao**: por cena, stock Magnific / placeholder `manual_capture` / fila Higgsfield conforme `visual.source` e `visual.type`.

**Limites (18.2.1):** na visualizacao, `maxScenes = maxVideos + maxImages` do bloco. Se o modelo devolver mais imagens/videos do que o cap, `enforceScenePlanCaps()` em `scenes-plan.ts` converte cenas nao-hook de `image` para `video` (ou o inverso) **sem nova chamada Claude**. Se ainda exceder apos ajuste, falha com mensagem explicita.

**Ficheiro de debug `blockXX.assets.json.error`:**

Gravado ao falhar parse/validacao em segmentacao ou visualizacao (`writePlanParseError` em `src/utils/scenes-plan.ts`). Campos principais:

| Campo | Descricao |
|-------|-----------|
| `at` | ISO timestamp |
| `stage` | `segmentation` ou `visualization` |
| `parse_error` | Mensagem curta (ex.: JSON invalido, caps) |
| `raw_response` | Resposta bruta do Claude |
| `unwrapped_for_json_parse` | JSON extraido (remove cercas ```json) |
| `segmentation_json` | Presente se a falha foi na visualizacao — permite retoma |

**Politica de creditos Claude:**

- **Sem retry automatico** em loop na API; uma falha grava `.error` e interrompe o bloco.
- **Retoma no `retry --stage imagens --scene-plan-v2`:**
  - Plano valido em `blockXX.assets.json` → reutiliza plano; salta renders existentes em `renders/blockNN/`; nao apaga `hf_cli_jobs` salvo `GENTUBE_FORCE_VIZ_REGEN=1`.
  - `.error` de visualizacao com `segmentation_json` + `raw_response` → reparse local sem Claude.
- Em sucesso do plano, `blockXX.assets.json.error` e renomeado para **`blockXX.assets.json.error.resolved`** (historico de debug).

**Narracao (schema 2.0):** `runNarracao` gera `02 - Narracao/blockNN/scYY.mp3` por cena; reutiliza MP3 ≥ 1 KiB; concat opcional para `blockNN.mp3` via ffmpeg (`src/utils/mp3-concat.ts`).

**Comando auxiliar:** `gentube shot-list-manual --project <id>` — exporta capturas `manual_capture` para `shot_list_manual.md` / `.csv` (`src/services/shot-list-manual.ts`).

### 18.10 Modalidade visual Wojak (opt-in)

**Documento mestre:** [wojak.md](wojak.md) (plano, opção B, retomada parcial, custos, piloto).

**Objetivo:** canais com avatar **Wojak** (line art): personagem **comico** ilustra cada beat da narracao; plano so `ai_generated`; render **Gemini** (imagem/bootstrap) + **Veo** (video), sem stock Magnific nem Higgsfield.

**Ativacao:** `GENTUBE_VISUAL_MODALITY=wojak` (default `default`). Corrida recomendada: `GENTUBE_IMAGE_BACKEND=gemini`, `GENTUBE_VIDEO_BACKEND=veo`, `GENTUBE_HF_ASYNC=0`, `GENTUBE_SCENE_PLAN_V2=1`. Opcional: `GENTUBE_PROMPT_VISUALIZA`, `GENTUBE_WOJAK_STYLE_TOKEN`, `GENTUBE_WOJAK_VEO_USE_REF` (default `0` — Veo text-to-video com prompt sanitizado, sem PNG ref). `--avatar-file` faz override da PNG da variant.

**Plano v2:** `stock_ratio` efetivo **0** (`resolveStockRatioForBlock`). Validacao pos-parse: `assertWojakBlockPlan` / `validateWojakBlockPlan` em `src/utils/wojak-prompt.ts` (proibe `stock`/`manual_capture`; exige `character_required` + `character_variant` em todas as cenas).

**Prompts:** `segmenta01.md` inalterado. Visualizacao: `visualiza01.md` + addon `Prompts/visualiza_wojak.md`.

**Opção B (producao imagens):** em modo wojak, `resolveSceneImageDelivery()` forca **`google_batch`** para cenas `type: image`; cada job inclui PNG de referencia (`buildGeminiMultimodalParts` em `gemini-batch.ts`). Bootstrap `scXX__bootstrap` permanece **sync** (`forceSync`). Veo permanece **sync** (sem batch de video).

**Estimativa de custo:** comando `gentube cost-estimate --project <id>` (`src/services/wojak-cost-estimate.ts`); tarifas configuraveis `GENTUBE_COST_USD_*` no `.env`.

**Retomada quando Veo falha (ex. quota 429):** o `retry --stage imagens` interrompe na primeira cena de video sem quota. Script auxiliar `scripts/continue-missing-renders.ts` gera imagens e bootstraps pendentes; depois `image:sync --watch`; quando a cota Veo voltar, `retry` salta ficheiros ja no disco. Ver secao em `wojak.md`.

**Correcoes de pipeline (2026-05-20):** `shouldSkipImagensBlock` nao salta bloco com `renders_status=awaiting_hf` se nao houver `image_jobs`/`hf_cli_jobs` pendentes; `GENTUBE_FORCE_VIZ_REGEN=1` com `--plan-only` nao reutiliza plano antigo por engano.

**Pre-requisito:** plano v2 (`--scene-plan-v2` / `GENTUBE_SCENE_PLAN_V2`).

**CLI:** `run-step` / `retry --stage imagens` com `--scene-plan-v2 --plan-only` (so cenas); `GENTUBE_FORCE_VIZ_REGEN=1` regera plano. Producao: `narracao` → `imagens` (ou `--enqueue-only`) → `image:sync` → `retry` para videos em falta. `cost-estimate` antes de corridas longas.

**Ficheiros (v2 + opcao B):** `Prompts/visualiza_wojak.md`, `src/config.ts`, `src/utils/wojak-prompt.ts`, `src/utils/scenes-plan.ts`, `src/integrations/claude.ts`, `src/integrations/gemini-batch.ts`, `src/services/pipeline.ts`, `src/services/image-generation.ts`, `src/services/video-generation.ts`, `src/services/wojak-cost-estimate.ts`, `scripts/continue-missing-renders.ts`.

### 18.11 Comando `run-pipeline` (orquestrador com rastreio)

**Objetivo:** uma corrida encadeia as etapas do video Wojak v2 sem perder rastreabilidade quando `--continue-on-error` (default) segue apos falhas parciais.

**Perfil inicial:** `wojak-images-only` — `max_videos` forcado a 0; imagens via Google Batch; ordem:

1. `roteiro` (por bloco ou `GENTUBE_ROTEIRO_STAGE_BATCH=1` — um batch para todos os blocos pendentes)
2. `quality_gate` (Sonnet; score + regeneracao opcional; nunca bloqueia o pipeline)
3. `imagens` (plano v2 + enqueue batch por bloco)
4. `image_sync` (poll ate sem `image_jobs` pendentes ou `--image-sync-max-rounds`)
5. `imagens_retry` (blocos com `image_jobs.outcome=failed`: apaga failed, re-render bloco, sync curto)
6. `narracao` (ElevenLabs por cena + cache TTS; requer `blockNN.assets.json`)
7. `montagem` (FFmpeg; requer `scXX.mp3` + PNG)
8. `thumbnails` (opcional; `--skip-thumbnails`)

**Rastreio (SQLite):**

| Tabela | Uso |
|--------|-----|
| `pipeline_runs` | Uma linha por corrida: `profile`, `status` (`running`/`success`/`partial`/`failed`), `summary_json`, `report_path` |
| `pipeline_run_steps` | Uma linha por passo: `stage`, `block_number` (nullable), `status`, `attempt`, `error_message`, `details_json` |
| `project_logs` | `stage=pipeline` — eventos agregados |

**Relatorio em disco:** `05 - Modelagem/pipeline-run-<runId>.json` e `pipeline-run-latest.json` (mesmo conteudo que `summary_json` + lista de steps).

**CLI auxiliar:** `gentube pipeline-report --project <id|slug> [--run-id N]`.

**Retomada:** `--from-stage <etapa>` — etapas anteriores sao ignoradas; blocos ja `success` em `script_blocks` / `media_blocks` / `narration_blocks` sao marcados `skipped` nos steps.

**Flags:** `--no-continue-on-error`, `--voice-id`, `--avatar-file`, `--max-images-block1`, `--max-images-other`, `--image-sync-interval`, `--google-batch-mode`, `--scene-plan-v2`.

**Implementacao:** `src/services/pipeline-orchestrator.ts`, `src/repository-pipeline.ts`, migracao em `src/db.ts` (`migratePipelineRunsSchema`).

**`create-video --mode pipeline`:** apos criar projeto, invoca `run-pipeline` com o mesmo perfil.

### 18.12 Modalidade visual Stoic Patrol (opt-in)

**Documento mestre:** [stoic-patrol.md](stoic-patrol.md).

**Objetivo:** canais de filosofia / estoicismo / fe (ex. **Stoic Patrol**, publico EUA 30+): plano v2 com **stock** na maior parte dos beats e **cartoes de citacao** (fundo preto, texto branco Montserrat, animacao typing) quando o roteiro traz citacao **explicita**. Cadeia recomendada: biblioteca local -> Pexels -> fallback configuravel (Magnific e/ou Google Batch em split para imagens).

**Criar projeto (CLI — preferir a scripts ad-hoc):**

```bash
npm run gentube -- create-video --channel <id_stoic_patrol> \
  --title "Changing Hurts… But It Changes Everything" \
  --niche "stoicism, psychology, faith, meaning" \
  --audience "American adults 30+" \
  --blocks 8 \
  --transcript-file "Transcripts/[Claudio Duarte] Changes hurt, but worth" \
  --prompt-matrix matriz_stoic_patrol.md \
  --prompt-canal-voice canal_voice_stoic_patrol.md \
  --create-only
```

Grava `05 - Modelagem/transcript.txt` e regista o texto no SQLite (`video_projects.transcript`). O roteiro (`matriz_stoic_patrol.md`) exige **fidelidade de tom e arco** ao transcript, com **ingles original** (proibido copiar frases do PT).

**Ativacao:** `GENTUBE_VISUAL_MODALITY=stoic_patrol` (alias aceite: `stoic-patrol`, `religious`). Corrida recomendada: `GENTUBE_SCENE_PLAN_V2=1`, `GENTUBE_STOCK_RATIO_BLOCK1=100`, `GENTUBE_STOCK_RATIO_OTHER=100`, `GENTUBE_STOCK_PROVIDER=local_then_pexels_then_split`, `GENTUBE_STOCK_SPLIT_MAGNIFIC_PERCENT=50`, `GENTUBE_STOCK_SPLIT_GOOGLE_BATCH_PERCENT=50`, `PEXELS_API_KEY` no `.env`.

**Plano v2:** `stock_ratio` efetivo **100** entre cenas nao-quote (`resolveStockRatioForBlock`). Nova fonte `source: "quote_card"` com `quote_text`, `quote_attribution?`, `animation_type: "typing"`, `render_engine: "hyperframes"`. Validacao: `assertStoicPatrolBlockPlan` em `src/utils/stoic-patrol-prompt.ts`.

**Prompts:**

| Etapa | Ficheiros |
|-------|-----------|
| Roteiro | `Prompts/matriz_stoic_patrol.md` (default se modality ativa e sem `GENTUBE_PROMPT_MATRIX`) |
| Voz bloco 1 | `Prompts/canal_voice_stoic_patrol.md` (default analogo) |
| Segmentacao | `segmenta01.md` + `Prompts/segmenta_stoic_patrol.md` (`quote_hint`) |
| Visualizacao | `visualiza01.md` + `Prompts/visualiza_stoic_patrol.md` |

**Render:**

| `source` | Comportamento |
|----------|----------------|
| `stock` | local (`data/stock_library/`) -> Pexels -> fallback (`Magnific` ou split `X/Y` com Google Batch para imagens sem avatar); **sem** fallback IA em `stoic_patrol` |
| `quote_card` | `renderQuoteCardMp4` → `scXX.mp4` (Hyperframes template em `src/assets/stoic-patrol/hyperframes-quote/` ou FFmpeg ASS); cache `data/quote_cache/` |
| `ai_generated` / `manual_capture` | Proibidos no plano |

**CLI:** `quote:render --project <slug> [--block N] [--force]` · `run-pipeline --profile stoic-patrol-stock` · `--verbose` em `run-step` / `run-pipeline`

**Ordem recomendada (manual, por etapas):**

1. `run-step --step roteiro`
2. `run-step --step imagens --scene-plan-v2 --enqueue-only`
3. `image:sync --watch`
4. `run-step --step narracao`
5. `run-step --step montagem`

**Env:** `GENTUBE_QUOTE_RENDER=auto|hyperframes|ffmpeg` · `GENTUBE_STOCK_PROVIDER=local_then_pexels_then_split` · `GENTUBE_STOCK_SPLIT_MAGNIFIC_PERCENT` · `GENTUBE_STOCK_SPLIT_GOOGLE_BATCH_PERCENT` · `PEXELS_API_KEY` · `GENTUBE_VERBOSE=1`

**Quote cards (layout):** duracao ate 30s proporcional ao texto; `data-duration` injetado antes do Hyperframes render; fonte com auto-fit no DOM (`quote-card-layout.ts`, cache `QUOTE_CARD_LAYOUT_VERSION`). Citacoes **> ~150 caracteres** no ecra: duas cenas `quote_card` consecutivas (prompts segmenta/visualiza).

**Montagem:** `scXX.mp3` sincronizado com `scXX.mp4`; se narracao > video em `quote_card`, **ultimo frame estatico** (`holdLastFrame` / `tpad=stop_mode=clone`). Apos quote, cena seguinte stock.

**video-use:** nao integrado no pipeline (edicao conversacional de footage bruto; ver `stoic-patrol.md`).

**Pre-requisito:** plano v2 (`--scene-plan-v2` / `GENTUBE_SCENE_PLAN_V2=1`).

**Ficheiros:** `stoic-patrol.md`, `Prompts/*_stoic_patrol.md`, `src/config.ts`, `src/utils/stoic-patrol-prompt.ts`, `src/types/scenes-plan.ts`, `src/utils/scenes-plan.ts`, `src/integrations/claude.ts`, `src/services/pipeline.ts`.

## 19) Politica aprovada — Step 4 (Thumbnails)

### 19.1 Objetivo

Gerar thumbnails para o video do projeto, com dois fluxos:

- **Fluxo (A)** — com imagem de referencia (thumbnail de outro canal no YouTube)
- **Fluxo (B)** — sem referencia (apenas prompt + avatar)

### 19.2 Fluxo (A) — com referencia

1. **Extrair video ID** da URL do YouTube (parametro `v=`)
2. **Montar URL** da thumbnail: `https://img.youtube.com/vi/<videoId>/maxresdefault.jpg`
3. **Baixar** a thumbnail de referencia para `05 - Modelagem/Thumbnail_<videoId>.jpg`
4. **Enviar diretamente ao Higgsfield** via multiplos `--image`:
   - `--image <referencia.jpg>` — thumbnail do outro canal como base visual
   - `--image <avatar.jpeg>` — avatar do canal para consistencia de personagem
   - `--prompt "..."` — descricao do que gerar
5. **Salvar** em `04 - Thumbnails/thumb_ref_01.png`, `thumb_ref_02.png`, etc.

O Higgsfield recebe as imagens diretamente e faz a fusao/interpretacao. **Nao passa pelo Claude.**

### 19.3 Fluxo (B) — sem referencia

1. **Enviar ao Higgsfield** com prompt + avatar (sem imagem de referencia)
2. **Salvar** em `04 - Thumbnails/thumb_gen_01.png`, `thumb_gen_02.png`, etc.

### 19.4 Defaults tecnicos

- **Modelo**: `nano_banana_flash`
- **Aspect ratio**: `16:9`
- **Resolucao**: `1k`
- **Imagens**: passadas via multiplos `--image` ao CLI HF (referencia + avatar)
- **Quantidade padrao**: 2 thumbnails
- **Prompt padrao**: `"generate a new thumbnail image for my youtube video with title "<titulo>" based on the image I am sharing with you here"` — pode ser sobrescrito via `--prompt`

### 19.5 Multiplos `--image` no CLI Higgsfield

O CLI `hf generate create` aceita multiplos `--image` na mesma chamada. Cada imagem pode ser um caminho local ou UUID de upload. O GenTube usa isso para enviar:

- A thumbnail de referencia (fluxo A)
- O avatar do canal

Isso elimina a necessidade de Claude analisar a imagem — o Higgsfield interpreta diretamente as referencias visuais.

### 19.6 CLI

```bash
# (A) Com referencia de outro canal
npm run gentube -- run-step --project 3 --step thumbnails \
  --reference-url "https://www.youtube.com/watch?v=VIDEO_ID" \
  --avatar-file Avatars/seu-avatar.jpg \
  --count 2

# (A) Com prompt customizado
npm run gentube -- run-step --project 3 --step thumbnails \
  --reference-url "https://www.youtube.com/watch?v=VIDEO_ID" \
  --avatar-file Avatars/seu-avatar.jpg \
  --count 2 \
  --prompt "generate a thumbnail with a man pointing at money symbols"

# (B) Sem referencia
npm run gentube -- run-step --project 3 --step thumbnails \
  --avatar-file Avatars/seu-avatar.jpg \
  --count 2

# Retry
npm run gentube -- retry --project 3 --stage thumbnails \
  --reference-url "https://www.youtube.com/watch?v=VIDEO_ID" \
  --avatar-file Avatars/seu-avatar.jpg \
  --count 2
```

Flags:

- `--reference-url <url>`: URL do video YouTube (fluxo A; omitir para fluxo B)
- `--avatar-file <caminho>`: avatar para consistencia visual (passado como `--image` ao HF)
- `--count <n>`: quantidade de thumbnails a gerar (padrao 2)
- `--prompt <texto>`: prompt customizado para o Higgsfield (opcional; sem flag usa prompt padrao com titulo do video)

### 19.7 Integracao com modo assincrono

- Com `GENTUBE_HF_ASYNC=1`, os jobs de thumbnail sao enfileirados em `hf_cli_jobs` com `block_number=0` (nao pertence a um bloco de roteiro)
- O download e feito via `higgsfield:sync` (mesmo fluxo do step imagens)
- O `higgsfield:sync` detecta `block_number=0` e atualiza `status_thumbnails` (em vez de `status_imagens_videos`)
- `status_thumbnails` no `video_projects` segue os estados padrao: `pending → processing → success | error`

### 19.8 Utilitarios YouTube

- `src/utils/youtube.ts`:
  - `extractVideoId(url)`: extrai video ID de URLs `youtube.com/watch?v=`, `youtu.be/` e `youtube.com/embed/`
  - `downloadYoutubeThumbnail(videoId, destDir)`: baixa `maxresdefault.jpg` para o diretorio informado

### 19.9 Entregaveis

- `05 - Modelagem/Thumbnail_<videoId>.jpg` — referencia baixada (fluxo A)
- `04 - Thumbnails/thumb_ref_XX.png` ou `thumb_gen_XX.png` — thumbnails geradas

## 20) Politica aprovada — Producao mista Higgsfield (IA) + stock (Magnific / Pexels)

### 20.1 Objetivo

Reduzir o consumo de creditos Higgsfield usando stock footage/imagens (Magnific e, em falha ou rate limit, **Pexels**) para a maioria dos shots, reservando a geracao por IA apenas para momentos de maior impacto visual.

### 20.2 Provedores

- **Higgsfield (IA)**: gera imagens e videos unicos via `hf generate create`
- **Magnific (stock primario)**: busca e baixa via API REST (`api.magnific.com`)
- **Pexels (stock alternativo)**: busca e baixa via API REST (`api.pexels.com`); ver **20.6.1**
- **Orquestracao**: `GENTUBE_STOCK_PROVIDER` escolhe ordem e fallback; modulo alvo `src/integrations/stock-download.ts`

### 20.3 Proporcao configuravel

| | Higgsfield (IA) | Stock (plano) | Variavel |
|---|---|---|---|
| **Bloco 1** | 50% | 50% | `GENTUBE_STOCK_RATIO_BLOCK1=50` |
| **Blocos 2..N** | 10% | 90% | `GENTUBE_STOCK_RATIO_OTHER=90` |

Os valores sao configuraveis via `.env` (0-100). O Claude recebe a proporcao no contexto e distribui os shots respeitando-a.

### 20.4 Politica criativa — quando usar IA vs stock

O Claude decide quais shots sao `ai_generated` e quais sao `stock` no plano de direcao (`blockXX.assets.json`), seguindo estas regras:

1. **IA e reservada para momentos de maior impacto**:
   - **Hook/abertura** do bloco — para prender atencao com algo unico e customizado
   - **Momento mais dramatico/enigmatico** — o ponto alto da narrativa do bloco
   - Se a proporcao permitir mais shots IA, distribuir nos demais pontos de impacto visual

2. **Stock e usado para o restante**:
   - Cenas de apoio e ilustracoes genericas
   - Transicoes entre conceitos
   - Metaforas visuais comuns (graficos, dinheiro, cidades, pessoas andando, etc.)

3. **Excecoes**: shots com `character_required: true` (avatar) devem ser `ai_generated` sempre (o Magnific nao tem o personagem do canal)

### 20.5 Schema atualizado do shot

Cada shot no `blockXX.assets.json` agora inclui:

```json
{
  "id": "s01",
  "type": "image",
  "source": "ai_generated",
  "role": "hook",
  "description": "...",
  "search_keywords": null,
  ...
}
```

- `source`: `"ai_generated"` (Higgsfield) ou `"stock"` (Magnific/Pexels)
- `search_keywords`: termos de busca em ingles (obrigatorio quando `source="stock"`, `null` quando `source="ai_generated"`); mesma string para ambos os provedores

### 20.6 API Magnific

- **Autenticacao**: header `x-magnific-api-key` com valor de `MAGNIFIC_API_KEY`
- **Busca video**: `GET .../v1/videos` com `filters[aspect_ratio][]=16:9` e `filters[orientation][]=horizontal`; entradas com `aspect_ratio` na resposta diferente de `16:9` sao ignoradas antes do download quando o campo vem preenchido
- **Download video**: `GET https://api.magnific.com/v1/videos/{id}/download`; apos download, `ffprobe` (se existir no PATH) confirma largura/altura ~16:9; se `ffprobe` nao estiver disponivel, confia-se no filtro da API e no `aspect_ratio` quando presente
- **Busca imagens**: `GET .../v1/resources` com `filters[content_type][photo]=1`, `filters[orientation][landscape]=1`, `filters[orientation][panoramic]=0`; quando `image.source.size` vem como `WxH`, candidatos fora de ~16:9 sao saltados sem download
- **Download imagem**: `GET https://api.magnific.com/v1/resources/{id}/download?image_size=large`; apos download usa-se `image-size` para validar ~16:9 (tolerancia relativa ~2%) e descartar ficheiro se falhar, tentando o proximo resultado
- **Resiliencia**: assets 404/disabled ignorados; **reducao de keywords** (remove tokens do fim da query ate minimo 3 palavras) antes de desistir ou passar ao proximo provedor
- Modulo: `src/integrations/magnific.ts`

### 20.6.1 API Pexels (alternativa)

Documentacao: [pexels.com/api/documentation](https://www.pexels.com/api/documentation/).

- **Autenticacao**: header `Authorization: <PEXELS_API_KEY>`
- **Busca fotos**: `GET https://api.pexels.com/v1/search?query=...&orientation=landscape&per_page=...`
- **Busca videos**: `GET https://api.pexels.com/v1/videos/search?query=...&orientation=landscape&per_page=...` (path legado `/videos/` em deprecacao)
- **Download**: URL direta em `photo.src` (ex. `landscape`, `large2x`) ou entrada em `video.video_files[]` (escolher ficheiro mais proximo de 16:9); fetch HTTP do binario — **nao** ha endpoint `/download` separado
- **16:9**: fotos 3:2 comuns — recorte para 1920x1080 com FFmpeg (mesma politica que Magnific); videos validados com `ffprobe` quando disponivel
- **Rate limit (default)**: 200 pedidos/hora, 20 000/mes; headers `X-Ratelimit-Remaining`, `X-Ratelimit-Reset` em respostas 2xx; `429` exige backoff ate reset
- **Keywords**: mesma **reducao progressiva** que Magnific (query completa → remover ultimo token ate minimo 3 palavras)
- **Atribuição**: link/credito ao fotografo na publicacao (requisito Pexels); nao altera ficheiros em `renders/`
- **Cache**: reutiliza `data/stock_cache/` (chave `sha256(type|keywords)` agnostica ao provedor)
- Modulos: `src/integrations/pexels.ts`, `src/integrations/stock-download.ts`

#### `GENTUBE_STOCK_PROVIDER`

| Valor | Comportamento |
|-------|----------------|
| `magnific` | So Magnific (default retrocompativel) |
| `pexels` | So Pexels |
| `magnific_then_pexels` | Magnific primeiro; em falha (erro HTTP, rate limit, sem match 16:9, `fetch failed`) → Pexels com mesmas keywords. **Recomendado Stoic Patrol** |
| `pexels_then_magnific` | Ordem inversa (opcional) |
| `local_then_pexels_then_magnific` | Biblioteca local (`data/stock_library/`) primeiro; depois Pexels; por fim Magnific |
| `local_then_pexels_then_split` | Local -> Pexels -> fallback split para `type=image` (`X%` Magnific + `Y%` Google Batch, com `character_required=false`) |

**Modo `default`:** falha de stock Magnific pode cair para **IA** (Higgsfield/Gemini). **Stoic Patrol:** sem IA no stock — falha so apos esgotar Magnific **e** Pexels (e variantes de keywords).

No modo split:

- `GENTUBE_STOCK_SPLIT_MAGNIFIC_PERCENT = X`
- `GENTUBE_STOCK_SPLIT_GOOGLE_BATCH_PERCENT = Y`
- Restricao: `X + Y = 100`
- Se `type=video`, o fallback permanece remoto (`Magnific`) — Google Batch aplica-se apenas a imagem
- Se a cena exigir personagem/avatar (`character_required=true`), nao enviar para fallback Google Batch no split

### 20.7 Fluxo de execucao no pipeline

Para cada shot no plano:

1. Se `source = "stock"`:
   - Consultar cache `data/stock_cache/` por `type` + `search_keywords`
   - Consultar biblioteca local `data/stock_library/` por `type` + keywords:
     - match exato (`keywords_norm`)
     - FTS aproximado com limiar conservador (`GENTUBE_STOCK_LIBRARY_FTS_MIN_SCORE`, sugerido `0.60`)
     - regressao progressiva de termos (remove tokens do fim ate minimo `GENTUBE_STOCK_LIBRARY_MIN_TERMS`, default `3`)
   - Buscar no provedor configurado (`GENTUBE_STOCK_PROVIDER`) usando `search_keywords` (e variantes mais curtas se necessario)
   - Baixar o resultado mais relevante (~16:9)
   - Salvar em `03 - Imagens e Videos/renders/blockXX/`, atualizar cache e registar na biblioteca local
   - Se o split escolher Google Batch (`type=image`): enfileirar `image_jobs` assíncrono e concluir com `image:sync`
   - Download remoto e imediato para Magnific/Pexels; ramo Google Batch conclui de forma assincrona

2. Se `source = "ai_generated"`:
   - Fluxo atual via Higgsfield (sincrono ou assincrono)
   - Quando imagem sem avatar e com significado amplo: permitir registo na biblioteca local para reuso futuro

### 20.8 Entregaveis por bloco

Mesmo diretorio de saida: `03 - Imagens e Videos/renders/blockXX/`

- `s01.png`, `s02.mp4`, etc. — independente da fonte (IA ou stock)
- `blockXX.assets.json` — plano com campo `source` indicando a origem de cada shot

### 20.9 Biblioteca local de stock e indexacao

Objetivo: evitar chamadas desnecessarias para Pexels/Magnific reutilizando media ja disponivel em projetos anteriores.

#### Estrutura

- `data/stock_library/files/` — ficheiros canonicos copiados (nao mover de `Videos/.../renders`)
- SQLite (`data/gentube.db`) — metadados por asset (`type`, `search_keywords`, `description`, hash do conteudo, dimensoes, origem, provider)
- Indice FTS para busca aproximada por keywords/descricao

#### Comando CLI

- `gentube stock:index [--project <id|slug>] [--root <dir>] [--dry-run] [--force]`
- Escaneia `Videos/**/03 - Imagens e Videos/block*.assets.json`
- Indexa apenas cenas com `visual.source = "stock"` e render correspondente em `renders/blockNN/scXX.*`
- Ignora `ai_generated`, `quote_card`, `manual_capture`
- Dedup por hash de conteudo (sha256)

#### Origem das keywords para busca

1. **Primaria:** `visual.search_keywords` de cada cena em `block*.assets.json`
2. **Complementar:** `visual.description`, `role`, e metadados do plano para enriquecer ranking
3. **Import de `data/stock_cache/` (quando possivel):** reaproveitar ficheiros quando houver metadados auxiliares (planos/logs) para mapear keywords; o hash isolado **nao** permite recuperar o texto original das keywords

Assim, no runtime, a busca local usa a **query da cena atual** (do plano atual) e encontra assets antigos por exato + FTS + regressao de termos.

## 21) Artefactos no disco vs SQLite (`sync-from-disk` e saltos no step imagens)

**Estado:** **implementado** em `src/services/sync-from-disk.ts`, comando `gentube sync-from-disk`, `getMediaBlock` em `repository.ts`, e skip de bloco em `runImagensVideos` / `runImagensVideosBlock` em `pipeline.ts`.

### 21.1 Problema

O pipeline decide o que executar com base nas tabelas `script_blocks`, `narration_blocks` e `media_blocks`. Ficheiros existentes em `01 - Roteiro/`, `02 - Narracao/` ou `03 - Imagens e Videos/` **sem** linhas correspondentes no SQLite (ou com `status` diferente de `success`) fazem com que:

- `run-step --step narracao` falhe (`listScriptBlocks` tem de ter `total_blocos` linhas e todas em `success` para o roteiro), ou
- a narração seja **gerada de novo** (custo ElevenLabs) se o MP3 existe mas a linha em `narration_blocks` nao está `success`, ou
- `run-step --step imagens` **volte a correr** o bloco 1 (Claude + HF/Magnific) mesmo com outputs já presentes.

### 21.2 Principio

1. **Fonte de decisão para saltar etapas:** mantém-se o **SQLite** (`status` por bloco), coerente com a retomada já descrita na secção 6.1.1 (roteiro/narração gerados pelo CLI).
2. **Sincronização explícita:** um comando dedicado **materializa** o que já está no disco em `upsert*` + `recomputeStageFromBlocks` / `recomputeImagensVideosStage`, sem chamar Anthropic, ElevenLabs nem Higgsfield na importação.
3. **Sem regressão acidental:** por defeito o import **nao** sobrescreve blocos ja `success` no DB; use `--force` para reimportar.

### 21.3 Comando `sync-from-disk`

| Parametro | Papel |
|-----------|--------|
| `--project <id\|slug>` | Obrigatorio |
| `--dry-run` | Listar o que seria atualizado sem escrever no SQLite |
| `--only <roteiro\|narracao\|imagens\|all>` | Limitar o escopo (default CLI: `all`) |
| `--force` | Reimportar mesmo quando o bloco ja esta `success` no DB |

**Roteiro:** para cada `N` em `1..total_blocos`, se existir `01 - Roteiro/blockNN.md` com tamanho >= 32 bytes e texto nao vazio, `upsertScriptBlock` com `status=success`, `file_path_md` absoluto, `content_md`, `finished_at`.

**Narração:** se existir `02 - Narracao/blockNN.mp3` com tamanho >= 1 KiB, `upsertNarrationBlock` com `status=success`, `file_path_mp3`, `finished_at`.

**Imagens:** se existirem `03 - Imagens e Videos/blockNN.assets.json` e, para cada entrada do plano, um ficheiro em `renders/blockNN/` com nome `<id>.<ext>`, entao `upsertMediaBlock` com `plan_status=success`, `renders_status=success`, contagens iguais ao numero de entradas. Dois formatos sao aceites pelo validador em disco: (1) **schema classico** — JSON com `shots[]`, `id` e `type` por shot (`image`: png/jpg/jpeg/webp; `video`: mp4/webm); `block_number` opcional mas validado se presente; (2) **schema 2.0** — `schema_version: "2.0"` com `scenes[]`; cada cena usa `visual.type` e `visual.source`; para `manual_capture`, aceita-se imagem (`png`/`jpg`/…) mesmo quando `visual.type` for `video` (placeholder ate gravacao real).

No fim (sem `--dry-run`): `recomputeStageFromBlocks` para roteiro e/ou narracao e/ou `recomputeImagensVideosStage` conforme `--only`. Registo em `project_logs` (`stage=sync`).

### 21.4 Narração apos import

O código atual de `runNarracao` já faz `continue` quando `getNarrationBlock(...).status === "success"`. Depois de `sync-from-disk` marcar o bloco 1 (e quaisquer outros MP3 já existentes) como `success`, `run-step --step narracao` **nao** volta a chamar ElevenLabs para esses blocos — apenas gera os que continuarem `pending` / `error`.

### 21.5 Step imagens — saltar bloco 1 concluído

**Implementado:** no loop de `runImagensVideos` e no inicio de `runImagensVideosBlock`, se existir linha em `media_blocks` com `plan_status === "success"` e (`renders_status === "success"` **ou** (`renders_status === "awaiting_hf"` e zero jobs em `hf_cli_jobs` com `outcome=pending` para esse bloco)), o bloco e **saltado** com log (sem Claude/HF/Magnific).

Assim, apos `sync-from-disk` (imagens) ou apos uma corrida bem-sucedida, `run-step --step imagens` continua nos blocos pendentes (ex.: bloco 2) sem refazer o bloco 1.

**Alternativa `--from-block N`:** nao implementada; o skip por estado em DB + `sync-from-disk` e o caminho suportado.

### 21.6 Riscos e mitigacao

- Ficheiros corrompidos ou vazios marcados como `success` → minimo de bytes + opcionalmente `--dry-run` com listagem.
- Contagem de blocos no projeto diferente do numero de ficheiros → o comando reporta blocos em falta; nao inventa conteúdo.

### 21.7 Documentacao de utilizador

Resumo no `README.md` (secção dedicada) e referência cruzada a esta secção 21.

## 22) Provedores de imagem — Higgsfield + Google Gemini (aprovado)

**Estado:** especificacao e documentacao **aprovadas**; implementacao em fases (ver **22.8**). **Videos** permanecem apenas no Higgsfield (`kling3_0`).

### 22.1 Objetivos

- Segundo provedor de **imagens** via Google GenAI (`@google/genai`, Nano Banana).
- Fallback em `GENTUBE_IMAGE_BACKEND=auto`: HF primeiro; em **qualquer** falha relevante (sem creditos, timeout, 5xx, erro CLI) → **uma** tentativa Gemini (modo conforme `GENTUBE_IMAGE_DELIVERY`).
- Producao economica: **Batch API Google** por defeito (`GENTUBE_IMAGE_DELIVERY=google_batch`, flag `--google-batch-mode`).
- Fila unificada **`image_jobs`** (migracao **opcao B**: substituir uso de `hf_cli_jobs` para imagens).
- **Thumbnails** na mesma politica ( `block_number = 0` ).

### 22.2 Provedor (`GENTUBE_IMAGE_BACKEND`)

| Valor | Comportamento |
|-------|----------------|
| `auto` | HF para imagens `ai_generated`; falha HF → Gemini (1x) |
| `higgsfield` | So HF; sem fallback |
| `gemini` | So Gemini; nao chama HF para imagens |

### 22.3 Modos de entrega (`GENTUBE_IMAGE_DELIVERY` + flags CLI)

| Modo | Flag CLI | Pipeline | Latencia | Custo |
|------|----------|----------|----------|-------|
| `sync` | (nenhuma; 1 prompt no `gemini:image`) | Inline `generateContent` | Segundos | API normal |
| `google_batch` | `--google-batch-mode` | Submit Batch API; **um batch por bloco** | Minutos–horas | ~50% vs inline (politica Google) |
| `local_batch` | `--batch-local` | Pool local com `GENTUBE_GEMINI_LOCAL_CONCURRENCY` | Segundos–min | API normal × N |

**Regras de flags:**

- `--google-batch-mode` e `--batch-local` sao **mutuamente exclusivas** (erro se ambas).
- `gemini:image` com **um** `--prompt`: sempre **sync**.
- Batch Google ou local: exige `--prompts-file` **ou** `--google-batch-mode` / `--batch-local` explicito no pipeline.
- Com `--google-batch-mode` no pipeline: se o **submit** batch falhar → **falhar direto** (sem fallback sync); log + `image_jobs.outcome=failed`.

**Escopo do batch:**

- **Pipeline** (`run-step` / `retry` imagens e thumbnails): agrupar por **bloco** (`GENTUBE_GEMINI_BATCH_SCOPE=block` — implementado; default).
- **CLI** `gemini:image`: pode agrupar por **projeto** ou lote manual definido no comando.

**Fases do pipeline imagens v2 (flags mutuamente exclusivas):**

| Flag | Efeito |
|------|--------|
| `--plan-only` | So segmentacao + visualizacao Claude → `blockNN.assets.json`; `renders_status=pending`; sem stock, `image_jobs`, HF nem submit. Exige `--scene-plan-v2`. |
| `--enqueue-only` | Le planos existentes; stock, placeholder, filas `image_jobs` (google_batch por bloco), videos HF; **nao** chama `submitGoogleImageBatch` por bloco. No **fim** do `run-step`/`retry` (todos os blocos): `submitPendingGoogleBatches(project_id)` → **N** operacoes Batch API (1 por bloco). Exige `--scene-plan-v2`. |
| (nenhuma) | Comportamento legado: apos cada bloco, `flushPendingGoogleBatches` daquele bloco. |

Comandos auxiliares:

- `gentube image:batch-submit --project <id>` — submete batches Google pendentes (sem poll).
- `gentube image:sync --project <id>` — submit pendentes (se houver) + poll HF + poll Gemini + download.

Fluxo recomendado producao multi-bloco:

1. `run-step --step imagens --scene-plan-v2 --plan-only`
2. Rever `blockNN.assets.json`
3. `run-step --step imagens --scene-plan-v2 --google-batch-mode --enqueue-only`
4. `image:sync --watch`

### 22.4 Tabela `image_jobs` (schema alvo)

```sql
CREATE TABLE image_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  shot_id TEXT NOT NULL,
  asset_type TEXT NOT NULL DEFAULT 'image' CHECK(asset_type = 'image'),
  provider TEXT NOT NULL CHECK(provider IN ('higgsfield', 'gemini')),
  delivery_mode TEXT NOT NULL CHECK(delivery_mode IN ('sync', 'google_batch', 'local_batch')),
  external_id TEXT,
  batch_id TEXT,
  out_path_no_ext TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending', 'done', 'failed')),
  result_mime TEXT,
  error_message TEXT,
  reference_image_path TEXT,
  downloaded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES video_projects(id)
);
CREATE INDEX idx_image_jobs_outcome ON image_jobs(outcome);
CREATE INDEX idx_image_jobs_batch ON image_jobs(batch_id);
CREATE INDEX idx_image_jobs_project_block ON image_jobs(project_id, block_number);
```

**Migracao opcao B:** deixar de inserir imagens em `hf_cli_jobs`; migrar linhas existentes; `higgsfield:sync` → `image:sync --provider higgsfield` (alias temporario).

### 22.5 Integracao Google GenAI

- SDK: `@google/genai` (`GoogleGenAI`, `ai.models.generateContent`).
- Chave: `GEMINI_API_KEY` (alias `google_api_key` no codigo).
- Modelo default: `gemini-2.5-flash-image`; opcional Pro via `GEMINI_IMAGE_MODEL_PRO` / flag `--model pro`.
- Saida: `candidates[0].content.parts[].inlineData` → gravar `{out_path_no_ext}.png` (ou extensao do mime).
- Config imagem: `config.imageConfig.aspectRatio: '16:9'`, `imageSize: '1K'` (variaveis `GENTUBE_GEMINI_IMAGE_*`).
- Referencia / avatar: `contents` multimodal (texto + `inlineData` da imagem) quando `character_required` ou thumbnails com `--avatar-file`.

**Batch API Google:** modulo `gemini-batch.ts` — submit, poll, download para `out_path_no_ext`; `external_id` = operacao Google; `batch_id` interno por bloco/projeto.

**Batch local:** modulo `image-local-batch.ts` — processa `image_jobs` pendentes com concorrencia limitada; mesmo API inline que sync.

### 22.6 Fallback (`auto`) — decisoes aprovadas

1. Tentativa HF (sync ou enqueue em `image_jobs` / legado `hf_cli_jobs`).
2. Em falha (inclui `not_enough_credits`, timeout, 5xx, JSON CLI invalido, etc.): **uma** tentativa Gemini no modo definido por `GENTUBE_IMAGE_DELIVERY` (tipicamente sync no fallback imediato, ou re-enfileirar batch se delivery=batch — a implementacao deve documentar o ramo exato).
3. Excecao: modo **`--google-batch-mode` forçado** sem fallback no submit (secao **22.3**).
4. Vídeos: nunca Gemini nesta fase.

### 22.7 Thumbnails (step 4)

- Mesmos flags `--google-batch-mode`, `--batch-local` e `.env` `GENTUBE_IMAGE_*`.
- Registos em `image_jobs` com `block_number = 0`, `shot_id` tipo `thumb_ref_01`.
- Referencia YouTube + avatar: entrada multimodal no Gemini (equivalente a multiplos `--image` no HF).

### 22.8 Fases de implementacao

| Fase | Entregavel |
|------|------------|
| 0 | Migration SQLite `image_jobs`; plano migracao `hf_cli_jobs` |
| 1a | `gemini-image.ts` + `gemini:image` sync |
| 1b | `gemini:image --batch-local` |
| 1c | `gemini-batch.ts` + `gemini:image --google-batch-mode` |
| 2 | `image-generation.ts` + fallback `auto` no pipeline |
| 3 | Enfileirar pipeline + `image:sync` |
| 3b | `--plan-only` + `--enqueue-only` + submit diferido + `image:batch-submit` |
| 4 | Flags pipeline + thumbnails |
| 5 | Referencia multimodal (avatar) |
| 6 | Deprecar `hf_cli_jobs` para imagens; docs finais |

### 22.9 Comandos CLI (resumo)

```bash
# Sync — 1 imagem
gentube gemini:image --prompt "..." --out ./out/x.png

# Batch Google
gentube gemini:image --google-batch-mode --prompts-file prompts.txt --out-dir ./out

# Batch local (testes)
gentube gemini:image --batch-local --prompts-file prompts.txt --out-dir ./out --concurrency 4

# Pipeline producao
gentube run-step --project 1 --step imagens --scene-plan-v2 --plan-only
gentube run-step --project 1 --step imagens --google-batch-mode --scene-plan-v2 --enqueue-only
gentube image:batch-submit --project 1
gentube image:sync --project 1 --watch --interval 60s
```

## 23) Montagem por cena — FFmpeg (implementado)

**Estado:** implementado no CLI (`run-step --step montagem`, `retry --stage montagem`, `sync-from-disk --only montagem`). Prototipo visual: `experiments/ffmpeg-scene-tests/output/20260518-183855/bloco3-kenburns-zoom-in-xfade-0.1s.mp4`.

### 23.1 Objetivo

Novo step (proposta: `06 - Montagem/` ou `montagem` no `run-step`) que, por cena e por bloco, combina narracao + visual ja produzidos em clipes MP4 e monta o bloco final, sem re-chamar Claude, ElevenLabs nem Higgsfield.

**Pre-requisito:** `--scene-plan-v2` / `GENTUBE_SCENE_PLAN_V2` (par 1:1 `scXX.mp3` ↔ `renders/blockNN/scXX.*`).

### 23.2 Entradas e saidas

| Entrada | Caminho |
|---------|---------|
| Plano | `03 - Imagens e Videos/blockNN.assets.json` (`scenes[]` define ordem) |
| Audio por cena | `02 - Narracao/blockNN/scXX.mp3` |
| Visual por cena | `03 - Imagens e Videos/renders/blockNN/scXX.{mp4,mov,jpg,png,...}` |

| Saida (proposta) | Caminho |
|------------------|---------|
| Clipe por cena | `06 - Montagem/scenes/blockNN/scXX.mp4` |
| Bloco montado | `06 - Montagem/blocks/blockNN.mp4` |

### 23.3 Resolucao do visual por cena

1. Se `visual.type === "image"` ou `manual_capture` → ficheiro imagem (`png`, `jpg`, `webp`).
2. Se `visual.type === "video"` → preferir `scXX.mp4` / `scXX.mov`; se ausente → fallback `scXX__bootstrap.png` (ou `.jpg`) com tratamento de **imagem** (Ken Burns).
3. Ignorar ficheiros auxiliares `scXX__bootstrap` quando existir video final da cena.

### 23.4 Estrategias de duracao (audio manda)

Medir `T_audio` e `T_video` com **ffprobe**. O trilho final de cada clipe e **sempre** o MP3 da cena (sem audio do stock).

| Caso | Regra | FFmpeg (resumo) |
|------|-------|------------------|
| **4.1** Imagem / bootstrap | Duracao = `T_audio` | **Ken Burns zoom-in** (padrao aprovado); ver **23.5** |
| **4.2** `T_audio > T_video` | Loop sem audio do video | `-stream_loop -1`, `-map` video + audio MP3, `-shortest` |
| **4.3** `T_audio < T_video` | Cortar ou acelerar | Se `T_video/T_audio > 1.25` → **trim** `-t T_audio`; senao acelerar com `setpts` ate max **2.0×**, acima disso trim |

Normalizar clipes: `fps=30`, `1920x1080`, `yuv420p`, AAC 192k antes de concatenar / xfade.

### 23.5 Ken Burns (imagem estatica) — **padrao aprovado: zoom-in**

- **Efeito:** zoom lento do centro, ~**100% → 112%** ao longo de `T_audio`.
- **Implementacao de referencia:** filtro `zoompan` com `d = round(T_audio * fps)`, `fps=30`, `s=1920x1080`.
- **Descartado para producao:** imagem totalmente estatica (baseline de teste apenas); **zoom-out** nao e padrao (opcional futuro por flag).
- **Bootstrap PNG** sem `.mov`/`.mp4`: mesmo tratamento Ken Burns zoom-in.

Variaveis alvo (`.env`): `GENTUBE_KEN_BURNS_ZOOM_END=1.12`, `GENTUBE_KEN_BURNS_FPS=30`, `GENTUBE_KEN_BURNS_MODE=zoom_in` (default).

### 23.6 Montagem do bloco — **padrao aprovado**

- Concatenar clipes na ordem de `scenes[]` com **xfade** entre pares.
- **Duracao da transicao:** **0.1 s** (fixo).
- **Tipo de transicao (default):** `fade` (video `xfade` + audio `acrossfade` com mesma duracao).
- Antes de cada `xfade`: normalizar timebase (`fps=30`, `settb=AVTB`) — obrigatorio; ver testes.
- **Descartado:** efeito **reverso** (video + audio invertidos); nao entra no pipeline.

Transicoes alternativas (fase opcional): `dissolve`, `fadefast` — catalogo completo no filtro FFmpeg `xfade`; amostras em `experiments/ffmpeg-scene-tests/output/xfade-*/`.

### 23.7 Montagem por bloco — segmentos parciais e erros

Iterar `scenes[]` na ordem do plano. Cena **completa** = `scXX.mp3` (≥ `GENTUBE_MONTAGEM_MIN_MP3_BYTES`) + visual resolvido (render ou bootstrap).

| Situacao | Saida |
|----------|--------|
| Todas as cenas completas | `blocks/blockNN.mp4` + `blockNN.assembly.json` |
| Buraco no meio (ex. falta sc06) | `blockNN_sc01-sc05.mp4`, `blockNN_sc07-sc29.mp4`, … |
| Uma cena isolada | `blockNN_sc06.mp4` |
| Qualquer falha / incompleto | `blocks/blockNN.err.txt` (lista cenas, segmentos gerados, erros ffmpeg) |

**Politica:** por defeito **nao interrompe** o projeto (`GENTUBE_MONTAGEM_STOP_ON_BLOCK_ERROR=0`); avanca ao bloco seguinte.

**SQLite:** `video_projects.status_montagem` = `pending | processing | success | partial | error`; tabela `assembly_blocks` por `(project_id, block_number)`.

### 23.8 Variaveis de ambiente e flags CLI

Todas as chaves em `.env.example` (prefixo `GENTUBE_MONTAGEM_*`, `GENTUBE_KEN_BURNS_*`, `GENTUBE_FFMPEG_PATH`).

Flags CLI (sobrescrevem `.env` na corrida): `--force`, `--block N` (retry), `--xfade-duration`, `--xfade-transition`, `--no-partial-segments`.

### 23.9 Comandos

```bash
npm run gentube -- run-step --project <id> --step montagem
npm run gentube -- retry --project <id> --stage montagem [--block N] [--force]
npm run gentube -- sync-from-disk --project <id> --only montagem
```

### 23.10 Dependencias e retoma

- **ffmpeg** / **ffprobe** no `PATH`, ou `GENTUBE_FFMPEG_PATH` / `GENTUBE_FFPROBE_PATH` (fallback: `experiments/ffmpeg-bin/` no clone).
- Idempotencia: `GENTUBE_MONTAGEM_SKIP_EXISTING=1` — saltar se saida mais recente que entradas (`--force` re-encode).
- `create-video` / template criam pasta `06 - Montagem/`.

### 23.11 Prototipo local

```bash
./experiments/ffmpeg-scene-tests/run-tests.sh
```

---

## 24) Claude Message Batches API (roteiro + planos v2)

Documentacao de decisao (2026-05-21): producao usa **obrigatoriamente** a [Message Batches API](https://docs.anthropic.com/en/docs/build-with-claude/message-batches) da Anthropic (~**50%** do preco sync). **Google Batch** (`image:sync`) continua separado — apenas imagens PNG.

### 24.1 Problema diagnostico — bloco 6 (`20260521-The-10-Brutal-Truths-how-AI-Ends`)

| Sintoma | Causa |
|---------|--------|
| `Visualizacao: resposta nao e JSON valido` (~pos 44k) | Resposta Claude **truncada** (`CLAUDE_MAX_TOKENS`); JSON cortado em `sc50` |
| `Segmentacao: sc75 tem N palavras (limite 120)` | Segmentacao com **50 cenas** para ~1950 palavras; modelo **despeja** o resto na ultima cena |
| Roteiro `block06.md` | Contem **porta 6 + porta 7 + teaser 8–9** no mesmo bloco (matriz 8 blocos / 10 portas) |

**Correcao aplicada:**

1. `max_scenes` **dinamico**: `min(GENTUBE_MAX_SCENES_CAP, ceil(palavras / GENTUBE_MAX_SCENES_WORDS_DIVISOR))` — bloco 6 ~**89–90** cenas.
2. `Prompts/segmenta01.md`: proibir mega-cena final; distribuir ate o orcamento.
3. `GENTUBE_MAX_WORDS_PER_SCENE` (default 120): falha barata na segmentacao.
4. Visualizacao **split** quando cenas > `GENTUBE_VIZ_SPLIT_SCENE_THRESHOLD` (default 70): dois pedidos `viz-a` / `viz-b` no batch, merge local.
5. Nao reutilizar `blockNN.assets.json.error` com `raw_response` truncado (`GENTUBE_FORCE_VIZ_REGEN=1` ou apagar `.error`).

### 24.2 Arquitetura de fases (por projeto)

| Fase | `custom_id` | Pedidos | Depende de |
|------|-------------|---------|------------|
| **R1** roteiro | `p{id}-roteiro-b{n}` | N blocos | transcript + prompts |
| **S1** segmentacao | `p{id}-segmentation-b{n}` | N blocos | `blockNN.md` + `max_scenes` |
| **V1** visualizacao | `p{id}-visualization-b{n}` ou `…-viz-a/b` | N (ou 2N se split) | segmentacao valida |
| **Imagens** | (existente) | Google Batch | `blockNN.assets.json` |

Implementacao: `runClaudeUserPrompt` em `src/integrations/claude.ts` — se `GENTUBE_CLAUDE_DELIVERY=batch`, submete 1 item, **poll inline**, grava em `claude_batch_jobs` + JSONL em `05 - Modelagem/claude-batches/`. Comando auxiliar: `gentube claude:sync` (poll de jobs ainda `pending`).

### 24.3 Variaveis de ambiente

| Variavel | Default | Uso |
|----------|---------|-----|
| `GENTUBE_CLAUDE_DELIVERY` | `batch` | `batch` \| `sync` (debug) |
| `GENTUBE_CLAUDE_BATCH_POLL_INTERVAL` | `60s` | Poll batch / `claude:sync --watch` |
| `GENTUBE_CLAUDE_MODEL_ROTEIRO` | (fallback `CLAUDE_MODEL`) | Roteiro |
| `GENTUBE_CLAUDE_MODEL_SEGMENTATION` | (fallback) | Segmentacao |
| `GENTUBE_CLAUDE_MODEL_VISUALIZATION` | (fallback) | Visualizacao |
| `GENTUBE_CLAUDE_THINKING_PLAN` | `disabled` | Seg + viz (evita esgotar tokens) |
| `GENTUBE_MAX_SCENES_DYNAMIC` | `1` | Formula por palavras do bloco |
| `GENTUBE_MAX_SCENES_WORDS_DIVISOR` | `22` | ~1 cena / 22 palavras |
| `GENTUBE_MAX_SCENES_CAP` | `100` | Teto Anthropic por bloco |
| `GENTUBE_MAX_WORDS_PER_SCENE` | `120` | Rejeita “lixo na ultima cena” |
| `GENTUBE_VIZ_SPLIT_SCENE_THRESHOLD` | `70` | Divide visualizacao em 2 pedidos |

Codigo: `src/utils/max-scenes.ts`, `src/integrations/claude-batch.ts`, `src/services/claude-sync.ts`, tabela `claude_batch_jobs`.

### 24.4 Custos e latencia

- Batch Anthropic: ~**50%** input/output vs Messages API sync (ver pricing Anthropic).
- Recomendacao: **Sonnet** para seg/viz; **Opus** opcional so roteiro (`GENTUBE_CLAUDE_MODEL_ROTEIRO`).
- Latencia: maioria < 1 h; ate 24 h — adequado para `run-pipeline` overnight; retry de bloco faz poll inline.

### 24.5 Comandos

```bash
# Plano bloco 6 (exemplo video 20260521)
mv "03 - Imagens e Videos/block06.assets.json.error" "03 - Imagens e Videos/block06.assets.json.error.bak"
export GENTUBE_FORCE_VIZ_REGEN=1
npm run gentube -- retry --project 20260521-The-10-Brutal-Truths-how-AI-Ends \
  --stage imagens --block 6 --scene-plan-v2 --google-batch-mode \
  --max-videos-block1 0 --max-videos-other 0

npm run gentube -- image:sync --project 20260521-The-10-Brutal-Truths-how-AI-Ends --watch --interval 30s
npm run gentube -- claude:sync --project 20260521-The-10-Brutal-Truths-how-AI-Ends --watch
npm run gentube -- pipeline-report --project 20260521-The-10-Brutal-Truths-how-AI-Ends
```

### 24.6 Roteiro — alinhamento futuro (opcional)

Matriz atual: 8 blocos com **multiplas portas** por bloco (ex. bloco 5 = portas 4+5, bloco 6 = 6+7). Medio prazo: **10 blocos / 1 porta** no `create-video` ou revisao manual de `block06.md` … `block08.md` para evitar >100 cenas/bloco.

---

## 25) Analise de arquitetura e roadmap de evolucao (2026-05-25)

Sessao de revisao tecnica completa do estado atual do GenTube, cobrindo tres eixos: **arquitetura de agentes**, **otimizacao de custo** e **background processing com rastreabilidade**.

### 25.1 Diagnostico do estado atual

#### 25.1.1 O que funciona bem

- Rastreamento solido via SQLite (`pipeline_runs`, `pipeline_run_steps`, `project_logs`, `claude_batch_jobs`, `image_jobs`).
- Batch APIs ja utilizados: Claude Message Batch (~50% custo) e Google Batch API (~50% custo imagens).
- Retry por bloco com `continueOnError` e `fromStage`/`throughStage` para retomada.
- Modularidade entre etapas com salto inteligente (blocos `status=success` sao pulados).
- Modo Wojak completo com validacoes rigidas (sem stock, character_required, variante inferida).

#### 25.1.2 Problemas identificados

| Problema | Impacto |
|---|---|
| Nenhum agente de avaliacao de qualidade | Roteiro fraco avanca para imagens + TTS + video sem checagem |
| Claude Opus 4.7 em segmentacao e visualizacao | Segmentacao e tarefa de divisao de frases; visualizacao e JSON estruturado — Opus e overkill e caro |
| `promptBase` (matriz.md) enviado sem prompt caching | 50K+ tokens repetidos a cada bloco sem reutilizacao de cache |
| 1 batch Claude por bloco por etapa | 8 blocos × 3 etapas = 24 batches vs 3 possiveis |
| CLI bloqueante | Terminal precisa ficar aberto durante todo o pipeline; queda mata a corrida |
| Retentativas sem distincao de tipo de erro | Erro de validacao JSON tratado igual a erro de quota (429) |
| Sem loop de feedback script → qualidade | Roteiro ruim consome ElevenLabs + Gemini + Veo sem possibilidade de correcao |

---

### 25.2 Proposta: arquitetura de multi-agentes

> **Implementacao:** P1–P8 descritos abaixo estao codificados na branch **`multiagent`**; detalhes de ficheiros, schema e CLI em **secao 26**. A tabela **25.5** marca o status de cada prioridade.

O codigo atual possui **servicos**, nao **agentes**. A diferenca critica: agente tem responsabilidade propria, criterio de aceitacao e pode rejeitar/refinar antes de passar adiante.

#### 25.2.1 Grafo de agentes proposto

```
[ScriptAgent] → [QualityGateAgent] → [PlanAgent] → [AssetAgent] → [AssemblyAgent]
                      ↑ loop de feedback (max 2 iteracoes)
```

#### 25.2.2 ScriptAgent

Corresponde ao `runRoteiroBlock` atual. Sem mudanca estrutural — se beneficia das otimizacoes de custo (secao 25.3) e do loop de feedback do QualityGateAgent.

#### 25.2.3 QualityGateAgent (novo — maior impacto em qualidade)

**Objetivo:** avaliar o roteiro gerado antes de gastar recursos em imagens, TTS ou video.

**Quando roda:** apos cada bloco de roteiro, antes de submeter plano de imagens ou narracao.

**Modelo:** Claude Sonnet 4.6 (avaliacao estruturada JSON; ~5x mais barato que Opus).

**Criterios de avaliacao (score 0–100 por criterio):**

| Criterio | O que o agente verifica |
|---|---|
| **Forca do hook** | Primeiras 3 frases: pergunta, dado chocante ou promessa especifica? |
| **Analogias** | Conceitos abstratos tem comparacao concreta? |
| **Curiosity gap** | Tem "loops abertos" — afirmacoes que prometem revelacao futura? |
| **Ritmo (pacing)** | Sentencas variam em tamanho? Evita paragrafos longos sem respiro? |
| **Direcao visual** | Texto da pistas visuais — acoes, metaforas fisicas, movimento? |
| **Profundidade argum.** | Tem dados, causa + efeito ou so afirmacoes vazias? |
| **CTA final** | Bloco final tem chamada clara e especifica? |
| **Valor unico** | Existe insight que o viewer nao encontraria em 5 outros videos? |

**Output esperado:**
```json
{
  "score_total": 72,
  "criteria": {
    "hook": 85, "analogias": 60, "curiosity_gap": 70,
    "pacing": 80, "visual_direction": 65, "argument_depth": 55,
    "cta": 90, "unique_value": 60
  },
  "blockers": ["argument_depth abaixo de 50 — sem dados ou causa/efeito"],
  "suggestions": ["Adicionar estatistica no paragrafo 3", "Reescrever CTA do bloco 2 como pergunta especifica"]
}
```

**Politica de regeneracao:**
- `score_total >= threshold` (default 65, variavel `GENTUBE_QUALITY_GATE_THRESHOLD`): aprovado, segue.
- `score_total < threshold` (1a avaliacao): regenera roteiro do bloco com `suggestions` injetado como contexto adicional; avalia novamente.
- 2a avaliacao: passa independente do score (evita loop infinito e custo extra).
- Custo por bloco: ~$0.05 (Sonnet). Previne desperdicar $1–3 em imagens + TTS de bloco fraco.

**Variaveis `.env`:**

| Variavel | Default | Uso |
|---|---|---|
| `GENTUBE_QUALITY_GATE_ENABLED` | `1` | Ativa/desativa o agente |
| `GENTUBE_QUALITY_GATE_THRESHOLD` | `65` | Score minimo para aprovacao (0–100) |
| `GENTUBE_QUALITY_GATE_MAX_REGEN` | `1` | Maximo de regeneracoes por bloco |
| `GENTUBE_CLAUDE_MODEL_QUALITY_GATE` | `claude-sonnet-4-6` | Modelo do agente |

**Posicao no pipeline:** entre `roteiro` e `imagens` no `pipeline-orchestrator.ts`. Novo estagio: `quality_gate`.

**Ordem de estagios atualizada:**
```
roteiro → quality_gate → imagens → image_sync → imagens_retry → narracao → montagem → thumbnails
```

**Rastreamento:** nova coluna `quality_gate_score` e `quality_gate_attempts` em `script_blocks`; registro em `pipeline_run_steps` com `stage=quality_gate`.

#### 25.2.4 PlanAgent (segmentacao + visualizacao — refatoracao de modelos)

Manter estrutura atual, mas separar modelos por sub-tarefa (ver secao 25.3.2).

#### 25.2.5 AssetAgent (imagens + video — deduplicacao)

Manter estrutura atual, adicionar deduplicacao por hash de prompt (ver secao 25.3.4).

#### 25.2.6 AssemblyAgent (montagem — sem mudanca estrutural agora)

Sem mudancas nesta fase. Beneficia-se indiretamente da melhoria de qualidade upstream.

---

### 25.3 Otimizacao de custo: cinco pontos de acao

#### 25.3.1 Prompt Caching da Anthropic (impacto: -60 a 70% nos tokens de entrada)

**Problema:** `promptBase` (matriz.md, ~50K tokens) e enviado inteiro em cada chamada sem cache.

**Solucao:** usar `cache_control: { type: "ephemeral" }` na parte estatica do prompt.

```typescript
// src/integrations/claude.ts — buildMessageCreateParams()
messages: [{
  role: "user",
  content: [
    { type: "text", text: promptBase, cache_control: { type: "ephemeral" } },
    { type: "text", text: contextoDinamico }  // bloco-especifico, nao cachear
  ]
}]
```

Cache ephemeral da Anthropic: TTL de 5 minutos para chamadas sincronas; reutilizavel dentro de um mesmo batch. Com 8 blocos × 3 etapas = 24 chamadas enviando o mesmo `promptBase`, o cache economiza ~70% dos tokens de entrada a partir da 2a chamada.

**Arquivos a modificar:** `src/integrations/claude.ts` (`buildMessageCreateParams`, `generateScriptBlock`, `generateSegmentationPlanJson`, `generateVisualizationPlanJson`).

#### 25.3.2 Model tiering — usar modelo certo por etapa

As variaveis `GENTUBE_CLAUDE_MODEL_SEGMENTATION` e `GENTUBE_CLAUDE_MODEL_VISUALIZATION` ja existem no codigo mas provavelmente nao estao setadas no `.env`, caindo no default `CLAUDE_MODEL` (Opus 4.7). Definir esses valores ja reduz custo significativamente sem nenhuma mudanca de codigo.

| Etapa | Modelo atual | Modelo proposto | Justificativa | Economia est. |
|---|---|---|---|---|
| Roteiro | Opus 4.7 | **Manter Opus** | Qualidade criativa e o diferencial | 0% |
| QualityGate | (nao existe) | **Sonnet 4.6** | Avaliacao estruturada JSON | baseline |
| Segmentacao | Opus 4.7 (default) | **Haiku 4.5** | Tarefa pura de divisao de frases em cenas | ~90% |
| Visualizacao | Opus 4.7 (default) | **Sonnet 4.6** | JSON estruturado com regras claras | ~80% |
| Thumbnails | Opus 4.7 (default) | **Sonnet 4.6** | Descricao de imagem estruturada | ~80% |

**Acao imediata (so .env, sem codigo):**
```
GENTUBE_CLAUDE_MODEL_SEGMENTATION=claude-haiku-4-5-20251001
GENTUBE_CLAUDE_MODEL_VISUALIZATION=claude-sonnet-4-6
```

#### 25.3.3 Agrupar batches Claude por etapa, nao por bloco

**Problema atual:** 8 blocos × 3 etapas = 24 batches Claude separados, cada um com polling proprio.

**Proposta:** 1 batch por etapa com N requests internos.

```
Batch "segmentacao-p123": [
  { custom_id: "p123-seg-b1", params: {...} },
  { custom_id: "p123-seg-b2", params: {...} },
  ...ate bloco 8
]
```

A Message Batches API suporta ate 10K requests por batch. Um batch com 8 items termina no mesmo tempo que um batch com 1 item — o overhead de polling e fixo por batch, nao por item.

**Impacto:** reduz polling de 24 rounds para 3 (roteiro, segmentacao, visualizacao). Reduz latencia total e simplifica o fluxo de `claude:sync`.

**Arquivos a modificar:** `src/integrations/claude.ts` (submissao em grupo), `src/services/pipeline.ts` (coordenacao por etapa antes de aguardar), `src/repository-claude-batch.ts` (agrupamento de batch_id por etapa).

#### 25.3.4 Deduplicacao de imagens por hash de prompt

**Problema:** mesmo prompt Wojak (ex. "Wojak neutro olhando para cima") aparece em multiplos blocos ou projetos similares, gerando imagem identica N vezes.

**Proposta:** antes de submeter `image_job`, calcular `SHA256(prompt_text + reference_image_path + provider + model)`. Se hash ja existe em `image_jobs` com `outcome=done`, reusar o arquivo sem novo job.

**Schema:** adicionar coluna `prompt_hash TEXT` em `image_jobs` com indice unico `(prompt_hash, provider)`.

**Arquivos a modificar:** `src/db.ts` (migracao), `src/services/image-generation.ts` (checagem pre-submit), `src/repository.ts` (lookup por hash).

#### 25.3.5 Cache TTS por hash de texto

**Problema:** `runNarracaoBlock` ja verifica existencia de arquivo (≥1 KiB no mesmo caminho), mas nao reutiliza entre projetos nem quando `block_number` muda.

**Proposta:** tabela `tts_cache` com `(text_hash, voice_id, model_id) → file_path`. Antes de chamar ElevenLabs, consultar o cache. Intros padrao do canal, frases recorrentes ou blocos regenerados reusam MP3 existente.

```sql
CREATE TABLE tts_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text_hash TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  char_count INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(text_hash, voice_id, model_id)
);
```

**Arquivos a modificar:** `src/db.ts`, `src/integrations/elevenlabs.ts`, `src/services/pipeline.ts` (`runNarracaoBlock`).

---

### 25.4 Background processing e rastreabilidade aprimorada

#### 25.4.1 Problema atual: CLI bloqueante

`run-pipeline` bloqueia o terminal ate tudo terminar. O `image_sync` interno faz polling ativo em loop (`while rounds < maxRounds`). Isso e fragil: queda de conexao SSH, laptop fechado ou processo morto interrompem o pipeline sem recovery automatico.

#### 25.4.2 Proposta: tabela de fila de jobs (Tier 1 — minimo viavel)

Nova tabela `job_queue` no SQLite para desacoplar submissao de execucao:

```sql
CREATE TABLE job_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  stage TEXT NOT NULL,
  block_number INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  error_type TEXT,          -- 'transient' | 'permanent' | 'quota'
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_retry_at TEXT,       -- ISO; backoff exponencial
  payload_json TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES video_projects(id)
);
CREATE INDEX idx_job_queue_runnable ON job_queue(status, next_retry_at);
```

#### 25.4.3 Proposta: processo daemon (Tier 2)

Comando `gentube daemon start` que:
1. Processa fila via `SELECT ... WHERE status='pending' AND next_retry_at <= datetime('now')`.
2. Marca `status=running` antes de executar (evita duplo processamento em multiplos processos).
3. Ao concluir etapa, enfileira automaticamente a proxima conforme grafo de dependencias.
4. Persiste estado entre reinicializacoes — retoma do ponto exato sem perder trabalho.
5. Roda em background sem terminal aberto (`gentube daemon stop`, `gentube daemon status`).

#### 25.4.4 Distincao de tipo de erro nas retentativas

**Problema atual:** `continueOnError: true` trata qualquer falha identicamente.

**Proposta:** categorizar erros no `recordStep` antes de decidir sobre retry:

| Tipo | Exemplos | Acao |
|---|---|---|
| `transient` | Timeout, 5xx, network error | Retry com backoff exponencial (5s, 15s, 45s) |
| `permanent` | JSON invalido, validacao Wojak falhou, roteiro vazio | Sem retry — reportar imediatamente, nao gastar mais tokens |
| `quota` | 429 rate limit (Veo, ElevenLabs, Claude) | Retry apos janela especifica por provedor (Veo: 1h, ElevenLabs: aguardar reset, Claude: 60s) |

**Impacto:** erro de validacao do plano Wojak para na hora sem gastar tokens; quota do Veo agenda retry autonomo; timeout de ElevenLabs e re-tentado sem intervencao manual.

**Arquivos a modificar:** `src/utils/provider-errors.ts` (ja existe — expandir), `src/services/pipeline-orchestrator.ts` (`recordStep`), `src/services/pipeline.ts` (propagacao de tipo de erro).

#### 25.4.5 Notificacoes de conclusao (Tier 3)

- Arquivo flag ao finalizar pipeline: `05 - Modelagem/pipeline-done.flag` com `runId` e status.
- Webhook URL configuravel: `GENTUBE_WEBHOOK_URL` — POST com payload `RunSummary` ao terminar.
- Integracao opcional com `mcp__scheduled-tasks` para triggers agendados.

---

### 25.5 Prioridade de implementacao

| Prioridade | Acao | Impacto custo | Impacto qualidade | Complexidade | Status |
|---|---|---|---|---|---|
| 🔴 1 | Setar `.env`: `GENTUBE_CLAUDE_MODEL_SEGMENTATION=claude-haiku-4-5-20251001`, `GENTUBE_CLAUDE_MODEL_VISUALIZATION=claude-sonnet-4-6` | Alto (-80% seg/viz) | Nenhum | Minima (so .env) | ✅ sec. 26.1 |
| 🔴 2 | Prompt caching em `buildMessageCreateParams` | Alto (-60% input tokens) | Nenhum | Baixa | ✅ sec. 26.2 |
| 🟡 3 | QualityGateAgent (Sonnet 4.6) com loop de feedback por bloco | Medio (evita desperdicio downstream) | **Alto** | Media | ✅ sec. 26.3 |
| 🟡 4 | Batch Claude por etapa em vez de por bloco | Medio (menos overhead polling) | Nenhum | Media | ✅ sec. 26.4 |
| 🟡 5 | Categorizacao de erros transient/permanent/quota | Medio (evita retries inutils) | Nenhum | Media | ✅ sec. 26.7 |
| 🟢 6 | Deduplicacao de imagens por hash de prompt | Baixo-Medio | Nenhum | Baixa | ✅ sec. 26.8 |
| 🟢 7 | Cache TTS por hash de texto | Baixo | Nenhum | Baixa | ✅ sec. 26.9 |
| 🔵 8 | Tabela `job_queue` + daemon background | Nenhum | Nenhum | Alta | ✅ sec. 26.10 |
| 🔵 9 | Notificacoes webhook ao finalizar pipeline | Nenhum | Nenhum | Baixa | Pendente |

**Observacoes:**
- Prioridades 1 e 2 reduzem custo Claude em 60–80% sem alterar comportamento do pipeline.
- Prioridade 3 (QualityGateAgent) protege todos os gastos subsequentes — cada $0.05 no gate pode evitar $1–3 em recursos de producao aplicados a roteiro fraco.
- Prioridade 8 (daemon) esta implementada na secao 26.10; prioridade 9 (webhook) permanece pendente.

---

### 25.6 Arquivos principais afetados por cada proposta

| Proposta | Arquivos principais |
|---|---|
| Prompt caching | `src/integrations/claude.ts` |
| Model tiering | `.env`, `src/config.ts` (documentacao de defaults) |
| QualityGateAgent | `src/integrations/claude.ts`, `src/services/pipeline.ts`, `src/services/pipeline-orchestrator.ts`, `src/db.ts`, `src/repository.ts` |
| Batch por etapa | `src/integrations/claude.ts`, `src/services/pipeline.ts`, `src/repository-claude-batch.ts` |
| Categorizacao de erros | `src/utils/provider-errors.ts`, `src/services/pipeline-orchestrator.ts` |
| Dedup imagens | `src/db.ts`, `src/services/image-generation.ts`, `src/repository.ts` |
| Cache TTS | `src/db.ts`, `src/integrations/elevenlabs.ts`, `src/services/pipeline.ts` |
| Daemon + fila | `src/db.ts`, `src/services/pipeline-orchestrator.ts`, novo `src/services/daemon.ts` |

---

## 26) Implementacao das otimizacoes P1–P8 (branch `multiagent`, 2026-05-25)

Esta secao registra o que foi efetivamente implementado na sessao de 2026-05-25, seguindo o roadmap da **secao 25**. A secao 25 descreve a **proposta** (agentes, custo, daemon); aqui ficam ficheiros, schema, CLI e comportamento real. Branch de referencia: **`multiagent`** (em cima de `main` com Claude batch + `run-pipeline`).

### 26.1 P1 — Model tiering por etapa

**Status: ✅ Implementado**

Variaveis adicionadas ao `.env`:

```
GENTUBE_CLAUDE_MODEL_SEGMENTATION=claude-haiku-4-5-20251001
GENTUBE_CLAUDE_MODEL_VISUALIZATION=claude-sonnet-4-6
# Roteiro continua usando CLAUDE_MODEL=claude-opus-4-7 (criatividade)
```

Funcoes de configuracao adicionadas em `src/config.ts`:

- `claudeModelForStage(stage)` — retorna o modelo correto por etapa
- `claudeThinkingForStage(stage)` — retorna o modo de thinking correto por etapa

O modelo Haiku (-90% vs Opus) e suficiente para segmentacao (divisao de frases em cenas — tarefa estruturada). Sonnet (-80%) e suficiente para visualizacao (JSON com regras claras). Opus e mantido apenas para o roteiro criativo.

---

### 26.2 P2 — Prompt Caching da Anthropic

**Status: ✅ Implementado**

Tipo exportado em `src/integrations/claude.ts`:

```typescript
export type CacheablePrompt = string | { cacheable: string; dynamic: string };
```

Funcao `buildMessageCreateParams(stage, userPrompt)` atualizada: quando `userPrompt` e `{ cacheable, dynamic }`, constroi array de content com `cache_control: { type: "ephemeral" }` no bloco estatico e sem cache no dinamico.

Funcoes refatoradas para separar parte estatica (mesmo para todos os blocos/projetos) da parte dinamica (especifica por bloco):

| Funcao | Parte cacheable | Parte dinamica |
|---|---|---|
| `generateScriptBlock` | `formattedPrompt` + `formatRules` | titulo, voz do canal, blocos anteriores, feedback |
| `generateSegmentationPlanJson` | `promptBase` inteiro | contexto do bloco (roteiro, cenas, numero) |
| `generateVisualizationPlanJson` | `promptBase` inteiro | contexto por bloco (personagens, roteiro, cenas) |

Economia esperada: ~70% nos input tokens a partir da 2a chamada (TTL 5 min do cache Anthropic).

---

### 26.3 P3 — QualityGateAgent

**Status: ✅ Implementado**

#### 26.3.1 Configuracao

Variaveis adicionadas ao `.env`:

```
GENTUBE_QUALITY_GATE_ENABLED=1
GENTUBE_QUALITY_GATE_THRESHOLD=65
GENTUBE_QUALITY_GATE_MAX_REGEN=1
# GENTUBE_CLAUDE_MODEL_QUALITY_GATE=claude-sonnet-4-6  # default
```

Funcoes de config em `src/config.ts`: `qualityGateEnabled()`, `QUALITY_GATE_THRESHOLD`, `QUALITY_GATE_MAX_REGEN`, `QUALITY_GATE_MODEL`.

#### 26.3.2 Schema de banco de dados

Migracao idempotente em `src/db.ts` (`migrateQualityGateSchema`): adiciona colunas `quality_gate_score INTEGER` e `quality_gate_attempts INTEGER NOT NULL DEFAULT 0` na tabela `script_blocks`.

Funcao de repositorio em `src/repository.ts`: `updateScriptBlockQualityGate(projectId, blockNumber, score, attempts)`.

#### 26.3.3 Avaliacao de qualidade

Tipos exportados em `src/integrations/claude.ts`: `QualityGateCriteria`, `QualityGateResult`.

Prompt estatico `QUALITY_GATE_STATIC_PROMPT` com 8 criterios de avaliacao (hook, analogias, curiosity_gap, pacing, visual_direction, argument_depth, cta, unique_value). Marcado com `cache_control` ephemeral — prompt de avaliacao e identico para todos os blocos.

Funcao `evaluateScriptQuality(input)` — sempre sincrona (modo `sync`, independente de `GENTUBE_CLAUDE_DELIVERY`), sempre Sonnet, retorna `QualityGateResult`.

#### 26.3.4 Loop de regeneracao

Funcao `runQualityGateBlock(project, blockNumber, opts?)` em `src/services/pipeline.ts`:
- Le o bloco do disco (`blockNN.md`)
- Avalia com `evaluateScriptQuality`
- Se score >= threshold: passa imediatamente
- Se score < threshold e attempts < maxRegen: regenera com `runRoteiroBlock` passando `qualityFeedback` (blockers + suggestions formatados)
- Persiste score e tentativas no banco via `updateScriptBlockQualityGate`
- **Sempre retorna `passed: true` apos maxRegen iteracoes** — nunca bloqueia o pipeline

Etapa `"quality_gate"` adicionada ao `PipelineStage` e `STAGE_ORDER` em `src/services/pipeline-orchestrator.ts`, entre `"roteiro"` e `"imagens"`.

---

### 26.4 P4 — Batch Claude por etapa (stage-level batching)

**Status: ✅ Implementado**

#### 26.4.1 Helper exportavel de prompt

Tipo `RoteiroPromptInput` e funcao `buildRoteiroUserPrompt(input): CacheablePrompt` extraidos de `generateScriptBlock` em `src/integrations/claude.ts`. Permite reutilizacao da logica de construcao de prompt sem duplicacao entre modo sincrono e batch.

#### 26.4.2 Novo modulo de batch por etapa

Arquivo criado: `src/integrations/claude-stage-batch.ts`

Funcao `runRoteiroBatchAll(items, opts?)`:
- Recebe array de `RoteiroPromptInput & { projectId }` (todos os blocos pendentes)
- Constroi requests com `buildMessageCreateParams("roteiro", buildRoteiroUserPrompt(item))` para cada bloco
- Submete como unico `Message Batch` via `createClaudeMessageBatch`
- Registra jobs no banco via `insertClaudeBatchJob` (rastreabilidade)
- Aguarda conclusao via `pollClaudeBatchUntilEnded`
- Distribui resultados: extrai texto, sanitiza, atualiza job por bloco
- Retorna `Map<blockNumber, textoLimpo>`
- Lanca erro agregado se algum bloco falhar

**Tradeoff documentado:** blocos submetidos em paralelo — `previousBlocksText` carregado do disco antes da submissao. Em execucao inicial (todos pendentes), context cruzado entre blocos sera vazio. Em reruns parciais, blocos ja no disco fornecem contexto.

#### 26.4.3 Funcao de orquestracao de etapa

Funcao `runRoteiroBatchStage(project, opts?)` adicionada em `src/services/pipeline.ts`:
- Coleta blocos pendentes (status != "success")
- Carrega previousBlocksText e channelVoiceContext antes da submissao
- Marca blocos como "processing" no banco
- Chama `runRoteiroBatchAll`
- Em sucesso: persiste texto no disco e no banco para cada bloco
- Em falha: marca todos os blocos como "error" e lanca excecao

#### 26.4.4 Integracao no orquestrador

Em `src/services/pipeline-orchestrator.ts`, etapa roteiro agora tem dois modos:

```
GENTUBE_ROTEIRO_STAGE_BATCH=1  →  runRoteiroBatchStage (1 batch N blocos)
GENTUBE_ROTEIRO_STAGE_BATCH=   →  loop runRoteiroBlock (1 batch por bloco, default)
```

Config em `src/config.ts`: `roteiroStageBatchEnabled()`.

O modo default (sem a variavel) mantem o comportamento atual de loop por bloco — sem regressao.

---

### 26.5 Tabela de status das otimizacoes

| Prioridade | Otimizacao | Status | Data |
|---|---|---|---|
| P1 | Model tiering (.env + config.ts) | ✅ Implementado | 2026-05-25 |
| P2 | Prompt Caching (CacheablePrompt + buildMessageCreateParams) | ✅ Implementado | 2026-05-25 |
| P3 | QualityGateAgent (avaliacao + regeneracao + DB) | ✅ Implementado | 2026-05-25 |
| P4 | Stage-level batch roteiro (buildRoteiroUserPrompt + claude-stage-batch.ts) | ✅ Implementado | 2026-05-25 |
| P5 | Categorizacao de erros transient/permanent/quota | ✅ Implementado | 2026-05-25 |
| P6 | Deduplicacao de imagens por hash de prompt | ✅ Implementado | 2026-05-25 |
| P7 | Cache TTS por hash de texto | ✅ Implementado | 2026-05-25 |
| P8 | Daemon + tabela job_queue | ✅ Implementado | 2026-05-25 |

---

### 26.6 Variaveis de ambiente — resumo completo

| Variavel | Default | Descricao |
|---|---|---|
| `CLAUDE_MODEL` | — | Modelo para roteiro (criativo; usar Opus) |
| `GENTUBE_CLAUDE_MODEL_SEGMENTATION` | `CLAUDE_MODEL` | Modelo para segmentacao (Haiku suficiente) |
| `GENTUBE_CLAUDE_MODEL_VISUALIZATION` | `CLAUDE_MODEL` | Modelo para visualizacao (Sonnet suficiente) |
| `GENTUBE_CLAUDE_MODEL_QUALITY_GATE` | `claude-sonnet-4-6` | Modelo do QualityGateAgent |
| `GENTUBE_QUALITY_GATE_ENABLED` | `1` | `0` / `false` / `off` desativa QualityGate |
| `GENTUBE_QUALITY_GATE_THRESHOLD` | `65` | Score minimo (0–100) para passar sem regenerar |
| `GENTUBE_QUALITY_GATE_MAX_REGEN` | `1` | Max tentativas de regeneracao por bloco |
| `GENTUBE_CLAUDE_DELIVERY` | `batch` | `sync` ou `batch` (per-call) |
| `GENTUBE_ROTEIRO_STAGE_BATCH` | — | `1` para batch todos os blocos em 1 request |
| `GENTUBE_QUOTA_RETRY_DELAY_MS` | `30000` | Espera (ms) antes de retry em erro de rate limit |
| `GENTUBE_DAEMON_POLL_MS` | `10000` | Intervalo de polling do daemon (ms) |

---

### 26.7 P5 — Categorizacao de erros transient/permanent/quota

**Status: ✅ Implementado**

#### 26.7.1 Motivacao

Antes do P5, todos os erros dos provedores eram tratados identicamente: retry ate `maxRetriesPerBlock`. Isso desperdicava:
- **Erros permanentes** (prompt invalido, API key errada): retries nunca vao resolver — falha imediata e mais rapida.
- **Erros de quota (429)**: retry imediato agrava o rate limit — precisa de backoff.
- **Erros transientes** (5xx, timeout, ECONNRESET): retry imediato correto.

#### 26.7.2 Implementacao

Funcao `classifyClaudeError(error: unknown): ClaudeErrorKind` adicionada a `src/utils/provider-errors.ts`:

| Tipo | HTTP / campo Anthropic | Comportamento |
|------|------------------------|---------------|
| `quota` | 429, `rate_limit_error` | Retry com backoff (`GENTUBE_QUOTA_RETRY_DELAY_MS`, default 30s) |
| `permanent` | 400, 401, 403, `invalid_request_error`, `authentication_error` | Break imediato — sem retry |
| `transient` | 500, 502, 503, 529, `overloaded_error`, timeout, ECONNRESET | Retry imediato (comportamento anterior) |
| *(default)* | Qualquer outro | Tratado como `transient` — conservador |

Constante `QUOTA_RETRY_DELAY_MS` (default 30s, configuravel via `GENTUBE_QUOTA_RETRY_DELAY_MS`).

O SDK Anthropic expoe `.status: number` e `.error.type: string` nas excecoes — extraidos via `extractHttpStatus` e `extractAnthropicErrorType`.

#### 26.7.3 Integracao no orquestrador

`recordStep` em `src/services/pipeline-orchestrator.ts` modificado para retornar `{ status, caughtError? }` em vez de so `PipelineStepStatus`.

Loops de retry atualizados nas etapas **roteiro** (modo sequencial), **imagens**, **imagens_retry** e **narracao**:

```typescript
const { status, caughtError } = await recordStep(...);
if (status === "error") {
  const kind = classifyClaudeError(caughtError);
  if (kind === "permanent") break;                          // sem retry
  if (kind === "quota") await sleep(QUOTA_RETRY_DELAY_MS); // backoff
  // transient: retry imediato (continua o loop)
}
```

O campo `attemptsUsed` agora reflete o numero real de tentativas realizadas (antes era sempre `maxRetriesPerBlock` mesmo com break antecipado).

---

### 26.8 P6 — Deduplicacao de imagens por hash de prompt

**Status: ✅ Implementado**

#### 26.8.1 Motivacao

Em reruns parciais e projetos com cenas similares, o mesmo prompt de imagem era submetido multiplas vezes ao Gemini/HF gerando custo redundante. Com dedup por hash, a segunda geracao de imagem identica tem custo zero.

#### 26.8.2 Implementacao

**Schema** (`src/db.ts`, `migrateImageHashSchema`):
```sql
ALTER TABLE image_jobs ADD COLUMN prompt_hash TEXT;
CREATE INDEX idx_image_jobs_prompt_hash ON image_jobs(prompt_hash, outcome);
```

**Hash** (`src/services/image-generation.ts`, `computeImagePromptHash`):
```typescript
sha256(prompt + "|" + (referenceImagePath ?? ""))
```
Inclui `referenceImagePath` pois mesmo prompt com imagem de referencia diferente = imagem diferente.

**Lookup** (`src/repository.ts`, `findDoneImageJobByHash`):
Consulta `image_jobs WHERE prompt_hash = ? AND outcome = 'done'` — retorna o job mais recente.

**Fluxo em `renderSceneImage`**:
1. Compute hash no inicio
2. Se modo sincrono (nao batch) e hash existir em job done com arquivo no disco → copia arquivo para `outPathNoExt`, insere job com `status="dedup"`, retorna imediatamente
3. Caso contrario: executa pipeline normal, passando `promptHash` para `insertImageJob`

O dedup **nao se aplica** a modos `google_batch` / `local_batch` (arquivo nao disponivel no momento da submissao) nem a `forceSync` (bootstrap de video — nao pode depender de cache).

---

### 26.9 P7 — Cache TTS por hash de texto

**Status: ✅ Implementado**

#### 26.9.1 Motivacao

Quando um bloco de roteiro e regenerado (QualityGate, retry manual) mas o texto final nao muda, a narracao ElevenLabs era re-gerada sem necessidade, consumindo caracteres do plano.

#### 26.9.2 Implementacao

**Schema** (`src/db.ts`, `migrateTtsCacheSchema`):
```sql
CREATE TABLE tts_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text_hash TEXT NOT NULL UNIQUE,
  voice_id TEXT NOT NULL,
  file_path TEXT NOT NULL,        -- canonical em data/tts_cache/{hash}.mp3
  text_length INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_tts_cache_hash ON tts_cache(text_hash);
```

**Hash**: `sha256(stripMarkdownForSpeech(text) + "|" + voiceId)` — depois de remover Markdown (idempotente ao que ElevenLabs recebe).

**Novo modulo** `src/services/tts-cache.ts`, funcao `cachedTextToSpeech(input, destPath)`:
- Cache hit: copia `data/tts_cache/{hash}.mp3` para `destPath`, retorna `{ cacheHit: true }`
- Cache miss: chama `textToSpeechMp3`, escreve `destPath`, copia canonical para `data/tts_cache/`, insere registro no banco, retorna `{ cacheHit: false }`
- Tolerante a arquivo removido manualmente do cache (regera sem erro)

**Integracao** em `src/services/pipeline.ts`:
- Chamadas `textToSpeechMp3` + `fs.writeFile` substituidas por `cachedTextToSpeech` (por cena e monolitico)
- Import de `textToSpeechMp3` removido do `pipeline.ts` (indireto via `tts-cache.ts`)

---

### 26.10 P8 — Daemon + tabela job_queue

**Status: ✅ Implementado**

#### 26.10.1 Motivacao

O CLI era bloqueante: o usuario precisava manter o terminal aberto durante toda a execucao do pipeline (30–90 min por video). Com o daemon, os videos sao enfileirados e processados em background.

#### 26.10.2 Schema

**`src/db.ts`**, `migrateJobQueueSchema`:
```sql
CREATE TABLE job_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  profile TEXT NOT NULL DEFAULT 'wojak-images-only',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','running','done','failed','cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  options_json TEXT NOT NULL,   -- JobQueueOptions serializado
  run_id INTEGER,               -- pipeline_runs.id apos inicio
  worker_pid INTEGER,           -- PID do processo daemon
  error_message TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_job_queue_status ON job_queue(status, priority DESC, id ASC);
```

#### 26.10.3 Novos arquivos

**`src/repository-jobs.ts`** — CRUD da fila:
- `enqueueJob(input)` — insere job com status `pending`
- `claimNextPendingJob(pid)` — SELECT + UPDATE atomico (previne race conditions)
- `finishJob(id, result)` — atualiza para `done` ou `failed`
- `cancelJob(id)` — cancela job `pending`
- `listJobs(opts)` — lista com filtro de status
- `recoverStalledJobs()` — ao iniciar, marca como `failed` jobs `running` com PID morto

**`src/services/daemon.ts`** — loop de polling:
- `DAEMON_PID_FILE = data/daemon.pid`
- `DAEMON_LOG_FILE = data/daemon.log`
- `runDaemonLoop()` — escreve PID, registra SIGTERM, recupera jobs travados, loop `claimNextPendingJob → runJob → finishJob`
- `isDaemonRunning()` — verifica PID via `process.kill(pid, 0)`
- Interval configuravel via `GENTUBE_DAEMON_POLL_MS` (default 10s)
- Em `runJob`: desserializa `options_json` → `PipelineOrchestratorOptions` → `runFullPipeline`

#### 26.10.4 Comandos CLI

| Comando | Descricao |
|---------|-----------|
| `gentube daemon:start` | Inicia daemon detached (`--foreground` para debug) |
| `gentube daemon:stop` | Envia SIGTERM ao daemon |
| `gentube daemon:status` | Mostra PID, log path e ultimos 10 jobs |
| `gentube daemon:run` | Loop interno (chamado por `daemon:start`, nao usar diretamente) |
| `gentube job:add --project <slug>` | Enfileira projeto com mesmas opcoes de `run-pipeline` |
| `gentube job:list [--status <s>]` | Lista jobs (filtro por status opcional) |
| `gentube job:cancel --id <n>` | Cancela job `pending` |

#### 26.10.5 Fluxo tipico

```bash
# 1. Criar projetos
gentube create-video --title "Video 1" ...
gentube create-video --title "Video 2" ...

# 2. Enfileirar
gentube job:add --project video-1 --voice-id <id>
gentube job:add --project video-2 --voice-id <id> --priority 1

# 3. Iniciar daemon
gentube daemon:start

# 4. Monitorar
gentube daemon:status
gentube job:list

# 5. Parar quando ocioso
gentube daemon:stop
```

#### 26.10.6 Tolerancia a falhas

- `recoverStalledJobs()` ao iniciar: jobs `running` com PID morto → `failed` (evita ficar preso)
- `claimNextPendingJob` usa UPDATE com WHERE condicional para prevenir dois daemons pegando o mesmo job
- SIGTERM gracioso: termina o job atual antes de encerrar
- Daemon nao inicia se PID file existir e processo estiver vivo

#### 26.10.7 Branch e ficheiros novos

| Ficheiro | Papel |
|----------|--------|
| `src/services/daemon.ts` | Loop `claimNextPendingJob` → `runFullPipeline` |
| `src/repository-jobs.ts` | CRUD `job_queue` |
| `src/integrations/claude-stage-batch.ts` | `runRoteiroBatchAll` (P4) |
| `src/services/tts-cache.ts` | `cachedTextToSpeech` (P7) |

**Retomada via fila:** `job:add --from-stage imagens` equivale a `run-pipeline --from-stage imagens` (util quando o terminal nao pode ficar aberto). O perfil default do job e `wojak-images-only` (mesmo que `run-pipeline`).

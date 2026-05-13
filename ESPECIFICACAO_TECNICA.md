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
- Nome do nicho (substitui `[NOME DO NICHO]` em `Prompts/matriz.md`)
- Publico alvo (substitui `[PUBLICO]` em `Prompts/matriz.md`)

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

- `run-all` hoje executa automaticamente: Etapa 1 -> Etapa 2 (roteiro e narracao).
- A etapa **imagens** roda com `run-step --step imagens` (ou fluxo equivalente no codigo), nao esta incluida no `run-all` atual.
- Interrompe em erro, mantendo rastreabilidade

## 6) Etapa 1 - Roteiro (Claude API)

### 6.1 Requisitos

- Usar prompt base `Prompts/matriz.md`
- Injetar: titulo, nicho, publico, transcricao opcional e quantidade de blocos
- Numero de blocos no prompt e substituido dinamicamente (`.replace(/dividido em \d+ blocos/i, ...)`)
- Modelo, max_tokens e thinking sao configurados via `.env`:
  - `CLAUDE_MODEL` (default: `claude-opus-4-7`)
  - `CLAUDE_MAX_TOKENS` (default: `16000`)
  - `CLAUDE_THINKING` — `adaptive` habilita extended thinking do Opus 4.7 (remove `temperature` da chamada, pois sao incompativeis); `disabled` ou vazio usa `temperature: 0.7` sem thinking

### 6.1.1 Retomada inteligente (skip de blocos concluidos)

Tanto `runRoteiro` quanto `runNarracao` verificam o status de cada bloco antes de processar. Se o bloco ja tem `status = "success"` no SQLite, ele e pulado com log informativo. Isso evita desperdicio de creditos (Claude/ElevenLabs) ao reexecutar apos uma interrupcao parcial.

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

- **Direcao**: Claude le `01 - Roteiro/blockXX.md` e grava o plano em `03 - Imagens e Videos/blockXX.assets.json` (ver secao 18). Cada shot e marcado com `source: "ai_generated"` ou `source: "stock"` conforme proporcao configurada.
- **Producao mista**:
  - Shots `ai_generated` → Higgsfield (`hf generate create`)
  - Shots `stock` → API Magnific (busca por `search_keywords` + download)
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

7. `hf_cli_jobs` (filas do CLI Higgsfield, especialmente modo assincrono)
   - id, project_id, block_number, shot_id, asset_type (`image`|`video`)
   - out_path_no_ext, hf_job_id (UNIQUE), hf_status
   - outcome (`pending`|`done`|`failed`), result_url, error_message, downloaded_at
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

- `gentube channel:create`
  - cadastra um novo canal para organizar os videos

- `gentube channel:list`
  - lista canais cadastrados

- `gentube run-step --project <id|slug> --step <roteiro|narracao|imagens|thumbnails>`
  - executa uma unica etapa
  - **imagens**: direcao (Claude -> `blockXX.assets.json`) + producao (CLI `hf generate create`). Com `GENTUBE_HF_ASYNC=1` (`true`/`yes`), a producao enfileira jobs sem `--wait`; o usuario deve rodar `higgsfield:sync` para poll/download.
  - **thumbnails**: baixa referencia YouTube (se `--reference-url`), envia imagens + prompt direto ao Higgsfield (sem Claude). Flags: `--reference-url`, `--avatar-file`, `--count`, `--prompt`.

- `gentube run-all --project <id|slug>`
  - executa pipeline completo das etapas **roteiro** e **narracao** (nao inclui imagens automaticamente)

- `gentube higgsfield:status [--json]`
  - consulta conta/creditos via API de agents (Bearer a partir de `credentials.json` do CLI)

- `gentube higgsfield:generate ...`
  - repassa argumentos ao `hf generate create` (testes manuais; opcoes desconhecidas permitidas)

- `gentube higgsfield:sync [--project <id|slug>] [--max-jobs <n>] [--watch] [--interval <dur>]`
  - modo assincrono: para cada linha `hf_cli_jobs` com `outcome=pending`, executa `hf generate get`, baixa `result_url` para `out_path_no_ext`, atualiza SQLite e estados do bloco/projeto
  - `--watch`: repete ate nao haver pendentes (pausa `--interval`; Ctrl+C encerra)

- `gentube retry --project <id|slug> --stage <roteiro|narracao|imagens|thumbnails> [--block N] [--voice-id ...]`
  - sem `--block`: reprocessa a etapa inteira
  - com `--block N` (1-based): reprocessa apenas o bloco N (roteiro, narracao ou imagens)
  - `--voice-id` aplica-se a **narracao**; flags de limite do step 3 (`--max-videos-*`, `--max-images-*`, `--avatar-file`) aplicam-se a **imagens**
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
- `GENTUBE_STOCK_RATIO_BLOCK1` (opcional): % de shots do bloco 1 vindos do stock Magnific (default: `50`)
- `GENTUBE_STOCK_RATIO_OTHER` (opcional): % de shots dos blocos 2..N vindos do stock (default: `90`)
- `GENTUBE_HF_ASYNC` (opcional): habilita enfileiramento HF sem `--wait` no step imagens
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
- `EXAMPLE.md` — ignorado; runbook pessoal, nunca no remoto.
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
- `src/integrations/magnific.ts` — busca e download de stock footage/imagens via API Magnific
- `src/services/hf-cli-sync.ts` — sincronizacao de `hf_cli_jobs`
- `src/db/` conexao, migrations e repositorios
- `src/services/` orchestrator de pipeline
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
  - `create-video`
  - `run-step` (inclui `--step imagens`)
  - `run-all`
  - `status`
  - `delete-project`
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
  - Geracao de roteiro com Claude (bloco a bloco, salvando `blockXX.md`)
  - Geracao de narracao com ElevenLabs (salvando `blockXX.mp3`)
  - Step **imagens**: plano em `blockXX.assets.json`, renders via CLI Higgsfield; modo **sincrono** (`hf ... --wait --json`) ou **assincrono** (`GENTUBE_HF_ASYNC`, jobs em `hf_cli_jobs` + `higgsfield:sync` / `--watch`)
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
  - max videos: **4**
  - max imagens: **6**
- **Blocos 2..N**:
  - max videos: **2**
  - max imagens: **6**
  - regra adicional: max imagens deve ser maior que max videos.

Esses limites sao defaults e podem ser sobrescritos no CLI do step 3.

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

### 18.7.1 Flags de limite no CLI (step imagens)

- `--max-videos-block1 <n>`
- `--max-images-block1 <n>`
- `--max-videos-other <n>`
- `--max-images-other <n>`

Uso:

- disponiveis em `run-step --step imagens` e `retry --stage imagens`.
- quando omitidas, usam os defaults aprovados.

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

## 20) Politica aprovada — Producao mista Higgsfield (IA) + Magnific (Stock)

### 20.1 Objetivo

Reduzir o consumo de creditos Higgsfield usando stock footage/imagens da Magnific (ex-Freepik) para a maioria dos shots, reservando a geracao por IA apenas para momentos de maior impacto visual.

### 20.2 Provedores

- **Higgsfield (IA)**: gera imagens e videos unicos via `hf generate create`
- **Magnific (stock)**: busca e baixa imagens/videos do banco Magnific via API REST (`api.magnific.com`)

### 20.3 Proporcao configuravel

| | Higgsfield (IA) | Magnific (Stock) | Variavel |
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

- `source`: `"ai_generated"` (Higgsfield) ou `"stock"` (Magnific)
- `search_keywords`: termos de busca em ingles para a API Magnific (obrigatorio quando `source="stock"`, `null` quando `source="ai_generated"`)

### 20.6 API Magnific

- **Autenticacao**: header `x-magnific-api-key` com valor de `MAGNIFIC_API_KEY`
- **Busca**: `GET https://api.magnific.com/v1/videos?term=<keywords>&order=relevance`
- **Download video**: `GET https://api.magnific.com/v1/videos/{id}/download`
- **Busca imagens**: `GET https://api.magnific.com/v1/resources?term=<keywords>&filters[content_type][photo]=1`
- **Download imagem**: `GET https://api.magnific.com/v1/resources/{id}/download`
- Modulo: `src/integrations/magnific.ts`

### 20.7 Fluxo de execucao no pipeline

Para cada shot no plano:

1. Se `source = "stock"`:
   - Buscar na API Magnific usando `search_keywords`
   - Baixar o resultado mais relevante
   - Salvar em `03 - Imagens e Videos/renders/blockXX/`
   - Download e imediato (nao depende de `higgsfield:sync`)

2. Se `source = "ai_generated"`:
   - Fluxo atual via Higgsfield (sincrono ou assincrono)

### 20.8 Entregaveis por bloco

Mesmo diretorio de saida: `03 - Imagens e Videos/renders/blockXX/`

- `s01.png`, `s02.mp4`, etc. — independente da fonte (IA ou stock)
- `blockXX.assets.json` — plano com campo `source` indicando a origem de cada shot

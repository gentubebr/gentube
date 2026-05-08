# GenTube CLI (Node.js) - Especificacao Unificada (Funcional + Tecnica)

Este documento e a fonte unica de verdade para o desenvolvimento do **GenTube CLI**.
Ele combina requisitos funcionais e especificacao tecnica em um unico `.md`.

## 1) Objetivo

Automatizar, via terminal, a criacao de projetos de video YouTube com pipeline por etapas:

1. Roteiro
2. Narracao
3. Imagens ou Videos (fase futura)
4. Thumbnails (fase futura)

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

### 2.4 Estrutura de referencia do template

O template atual referencia o canal explicitamente:

- `Template/[Nome do Canal]/01 - Roteiro/`
- `Template/[Nome do Canal]/02 - Narracao/`
- `Template/[Nome do Canal]/03 - Imagens e Videos/`
- `Template/[Nome do Canal]/04 - Thumbnails/`

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

- Executa automaticamente: Etapa 1 -> Etapa 2
- Interrompe em erro, mantendo rastreabilidade

## 6) Etapa 1 - Roteiro (Claude API)

### 6.1 Requisitos

- Usar prompt base `Prompts/matriz.md`
- Injetar: titulo, nicho, publico, transcricao opcional e quantidade de blocos
- Modelo alvo: Opus 4.6 (confirmar identificador tecnico final na API)

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

## 9) Operacoes de CLI (contrato funcional)

- `gentube init`
  - configuracao guiada: `.env`, pastas, opcao de informar API keys e cadastrar primeiro canal

- `gentube create-video`
  - cria projeto vinculado a um canal existente e coleta entradas obrigatorias
  - permite escolher `iterativo` ou `sequencial`

- `gentube channel:create`
  - cadastra um novo canal para organizar os videos

- `gentube channel:list`
  - lista canais cadastrados

- `gentube run-step --project <id|slug> --step <roteiro|narracao>`
  - executa uma unica etapa

- `gentube run-all --project <id|slug>`
  - executa pipeline completo (etapas disponiveis)

- `gentube retry --project <id|slug> --stage <roteiro|narracao> [--block N] [--voice-id ...]`
  - sem `--block`: reprocessa a etapa inteira
  - com `--block N` (1-based): reprocessa apenas o bloco N (roteiro ou narracao)

- `gentube status --project <id|slug>`
  - mostra status consolidado e detalhado por bloco

- `gentube delete-project --project <id|slug>`
  - remove projeto completo com confirmacao dupla

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
   - `project_logs`
4. Exibir resultado final da operacao

Regras:

- Operacao transacional no banco quando aplicavel
- Em falha parcial, exibir erro claro e registrar log
- A exclusao remove somente o projeto de video; o canal permanece cadastrado

## 11) Integracoes e ambiente

Variaveis em `.env`:

- `CLAUDE_API_KEY`
- `ELEVENLABS_API_KEY`

Diretrizes:

- Nunca logar chaves no terminal
- Sanitizar erros antes de exibir ao usuario

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
- `src/db/` conexao, migrations e repositorios
- `src/services/` orchestrator de pipeline
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

- Etapa 3: Imagens ou Videos
- Etapa 4: Thumbnails
- Definicao de providers, prompts e formatos de saida dessas etapas

## 16) Status atual da implementacao

Implementado no codigo em `src/`:

- Base do CLI com comandos:
  - `init` (setup guiado)
  - `channel:create`
  - `channel:list`
  - `create-video`
  - `run-step`
  - `run-all`
  - `status`
  - `delete-project`
  - `retry` (etapa inteira ou `--block N`; apos cada bloco, `status_roteiro` / `status_narracao` e recalculado no SQLite)
- Banco SQLite local com tabelas:
  - `channels`
  - `video_projects`
  - `script_blocks`
  - `narration_blocks`
  - `project_logs`
- Pipeline funcional:
  - Geracao de roteiro com Claude (bloco a bloco, salvando `blockXX.md`)
  - Geracao de narracao com ElevenLabs (salvando `blockXX.mp3`)
- Estrutura de projeto por canal em:
  - `Videos/<canal>/<YYYYMMDD-video>/...`
- Exclusao de projeto:
  - remove arquivos do projeto
  - remove registros relacionados no SQLite

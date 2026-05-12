# GenTube

CLI em **Node.js** para organizar projetos de vídeo no estilo YouTube: **roteiro** (Claude), **narração** (ElevenLabs), **imagens e vídeos** (direção Claude + produção mista Higgsfield IA / Magnific stock), **thumbnails** (referência YouTube + avatar direto ao Higgsfield via múltiplos `--image`), pastas por **canal** e histórico em **SQLite**.

---

## Por que usar

- Estrutura fixa de pastas por canal e por vídeo (`Videos/<canal>/<data>-<titulo>/`).
- Roteiro em blocos (`block01.md`, …) a partir do prompt em `Prompts/matriz.md`.
- Áudio por bloco (`block01.mp3`, …) alinhado ao roteiro.
- Status de cada etapa e de cada bloco gravados localmente (sem depender só de arquivos soltos).

## Requisitos

- [Node.js](https://nodejs.org/) **18+** (recomendado LTS).
- Contas / chaves: **Anthropic (Claude)** e **ElevenLabs** (ver `.env.example`).

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
| `GENTUBE_HF_ASYNC` | Opcional | `1`, `true` ou `yes`: no step **imagens**, enfileira jobs no Higgsfield sem esperar no mesmo comando; use `higgsfield:sync` (ou `--watch`) para baixar resultados |
| `HIGGSFIELD_CLI_PATH`, `HIGGSFIELD_CREDENTIALS_PATH`, `HIGGSFIELD_CLI_WAIT_TIMEOUT`, `HIGGSFIELD_API_URL` | Opcionais | Caminho do binário `hf`, credenciais, timeout de `--wait` (modo síncrono), base da API de agents; ver [`.env.example`](.env.example) |

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

# 3) Criar projeto de vídeo (interativo ou com flags)
npm run gentube -- create-video

# Exemplo com referência de outro vídeo (estrutura / mensagens-chave — arquivo UTF-8)
npm run gentube -- create-video --channel 1 \
  --title "Meu título" \
  --niche "finanças pessoais" \
  --audience "adultos EUA 30+" \
  --blocks 8 \
  --transcript-file Transcripts/transcript.txt \
  --mode iterativo

# Apagar um projeto sem prompts (scripts)
npm run gentube -- delete-project --project 2 --yes

# 4) Só roteiro ou só narração (use id numérico ou slug da pasta do projeto)
npm run gentube -- run-step --project 1 --step roteiro
npm run gentube -- run-step --project 1 --step narracao

# 5) Roteiro + narração em sequência
npm run gentube -- run-all --project 1

# 6) Consultar status
npm run gentube -- status --project 1

# 6b) Modo assíncrono Higgsfield (GENTUBE_HF_ASYNC=1): após run-step imagens, sincronizar jobs
npm run gentube -- higgsfield:sync --project 1
npm run gentube -- higgsfield:sync --project 1 --watch --interval 30s

# 7) Gerar thumbnails
# (A) Com referência de outro canal (baixa thumbnail + avatar → direto ao HF)
npm run gentube -- run-step --project 1 --step thumbnails \
  --reference-url "https://www.youtube.com/watch?v=VIDEO_ID" \
  --avatar-file Avatars/lou02.jpeg \
  --count 2

# (B) Sem referência (apenas avatar + prompt → HF)
npm run gentube -- run-step --project 1 --step thumbnails \
  --avatar-file Avatars/lou02.jpeg \
  --count 2

# Com prompt customizado
npm run gentube -- run-step --project 1 --step thumbnails \
  --reference-url "https://www.youtube.com/watch?v=VIDEO_ID" \
  --avatar-file Avatars/lou02.jpeg \
  --prompt "generate a thumbnail with a man pointing at money" \
  --count 2

# 8) Consultar uso de caracteres ElevenLabs
npm run gentube -- elevenlabs:status

# 9) Reprocessar uma etapa ou só um bloco
npm run gentube -- retry --project 1 --stage roteiro --block 2
npm run gentube -- retry --project 1 --stage narracao --block 2
```

### Build (TypeScript → `dist/`)

```bash
npm run build
npm start -- --help
```

## Onde ficam os arquivos

- Projetos gerados: `Videos/<slug-do-canal>/<YYYYMMDD-slug-do-titulo>/`
  - `01 - Roteiro/` — `blockXX.md` (só texto narrado; sem cabeçalho de bloco nem pergunta de “continuar”)
  - `02 - Narracao/` — `blockXX.mp3`
  - `03 - Imagens e Videos/` — saídas do step **imagens**: mix de IA (Higgsfield) e stock (Magnific), proporção configurável via `.env`
  - `04 - Thumbnails/` — thumbnails geradas (step **thumbnails**): `thumb_ref_01.png` (com referência) ou `thumb_gen_01.png` (sem referência)
  - `05 - Modelagem/` — ex.: `transcript.txt` (transcricao de referência), `Thumbnail_<videoId>.jpg` (thumbnail de referência YouTube)
- Banco local: `data/gentube.db` (ignorado pelo Git)
- Template de referência: `Template/[Nome do Canal]/`

Arquivos de mídia em `Videos/` costumam ser ignorados pelo Git (veja `.gitignore`).

### Produção mista: Higgsfield (IA) + Magnific (stock)

O step **imagens** usa dois provedores para os shots de cada bloco:

- **Higgsfield (IA)**: gera imagens/vídeos únicos — reservado para o **hook** (abertura) e os **momentos mais impactantes/dramáticos** de cada bloco.
- **Magnific (stock)**: busca imagens/vídeos no banco da Magnific (ex-Freepik) — usado para ilustrações de apoio, transições e cenas genéricas.

A proporção é configurável via `.env`:

| Variável | Default | Efeito |
|----------|---------|--------|
| `GENTUBE_STOCK_RATIO_BLOCK1` | `50` | 50% stock / 50% IA no bloco 1 |
| `GENTUBE_STOCK_RATIO_OTHER` | `90` | 90% stock / 10% IA nos blocos 2..N |

O Claude decide **quais** shots são IA vs stock no plano de direção (`blockXX.assets.json`), priorizando IA para momentos de maior impacto visual e stock para o restante.

### Higgsfield (modo assíncrono)

Com `GENTUBE_HF_ASYNC` em `1`, `true` ou `yes`, os shots marcados como `ai_generated` são enfileirados no Higgsfield (sem `--wait` no mesmo processo). Os IDs ficam na tabela `hf_cli_jobs` no SQLite; os arquivos aparecem em `03 - Imagens e Videos/` depois de rodar **`higgsfield:sync`**. Shots `stock` são baixados da Magnific imediatamente, independente do modo async.

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

- Afinar defaults e observabilidade do step imagens (Higgsfield + Magnific).
- Incluir steps no `run-all` ou comando `run-all --with-imagens`.

## Licença

ISC (veja `package.json`). Ajuste aqui se mudar a licença do repositório.

# GenTube

CLI em **Node.js** para organizar projetos de vídeo no estilo YouTube: **roteiro** (Claude), **narração** (ElevenLabs), pastas por **canal** e histórico em **SQLite**. Etapas de imagens e thumbnails entram no roadmap.

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

Se ao rodar o CLI aparecer erro do tipo **NODE_MODULE_VERSION** com `better-sqlite3`, a versão do Node mudou desde o `npm install`. Recompile o addon:

```bash
npm rebuild better-sqlite3
```

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
| `CLAUDE_API_KEY` | Sim | API da Anthropic (roteiro) |
| `ELEVENLABS_API_KEY` | Sim | API da ElevenLabs (TTS) |
| `ELEVENLABS_VOICE_ID` | Recomendada | Voz padrão se você não passar `--voice-id` |

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

# 7) Reprocessar uma etapa ou só um bloco
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
  - `03 - Imagens e Videos/` — futuro
  - `04 - Thumbnails/` — futuro
  - `05 - Modelagem/` — ex.: `transcript.txt` quando você informa transcricao de referência na criação do projeto
- Banco local: `data/gentube.db` (ignorado pelo Git)
- Template de referência: `Template/[Nome do Canal]/`

Arquivos de mídia em `Videos/` costumam ser ignorados pelo Git (veja `.gitignore`).

## Documentação técnica

Regras de negócio, modelo de dados, contratos de comandos e decisões de implementação estão em:

**[ESPECIFICACAO_TECNICA.md](ESPECIFICACAO_TECNICA.md)**

## Roadmap

- Etapa **Imagens / vídeos** (B-roll).
- Etapa **Thumbnails**.

## Licença

ISC (veja `package.json`). Ajuste aqui se mudar a licença do repositório.

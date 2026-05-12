# EXAMPLE.md — Teste de geracao completa (Async HF)

Guia passo a passo para criar e executar um projeto de video completo com
roteiro (Claude), narracao (ElevenLabs) e imagens/videos (Higgsfield, modo assincrono).

> **Projeto:** *Ways Rich People Make Money With Debt*
> **Canal:** Late Bloomer Lou (id=1)
> **Data de referencia:** 2026-05-11

---

## Pre-requisitos (validar uma vez antes do teste)

```bash
# 1. Build atualizado
npm run build

# 2. Rebuild native (se mudou versao do Node)
npm run rebuild:native

# 3. Verificar credenciais e creditos Higgsfield
npm run gentube -- higgsfield:status

# 4. Verificar canal existente
npm run gentube -- channel:list
```

**`.env` deve conter (alem de CLAUDE_API_KEY/ELEVENLABS):**

```env
# Claude — modelo e comportamento
CLAUDE_MODEL=claude-opus-4-7
CLAUDE_MAX_TOKENS=16000
CLAUDE_THINKING=adaptive

# Magnific (stock footage/imagens)
MAGNIFIC_API_KEY=FPSXadb5ea68f40648e9b0aa913d3d42bb12
GENTUBE_STOCK_RATIO_BLOCK1=50
GENTUBE_STOCK_RATIO_OTHER=90

# Higgsfield
HIGGSFIELD_CLI_PATH=/home/development/.nvm/versions/node/v23.11.0/bin/higgsfield
GENTUBE_HF_ASYNC=1
```

> Para testar com outro modelo/config, basta trocar no `.env` e rodar `retry --stage roteiro --block 1`.
> Para ajustar a proporcao stock/IA, altere `GENTUBE_STOCK_RATIO_*` (0=100% IA, 100=100% stock).

---

## Parametros do projeto

| Parametro | Valor |
|-----------|-------|
| Canal | `1` (Late Bloomer Lou) |
| Titulo | `Ways Rich People Make Money With Debt` |
| Nicho | `Educação financeira e investimentos` |
| Publico | `público AMERICANO, ESTADOS UNIDOS com IDADE 40 anos ou acima` |
| Blocos | `9` |
| Transcript | `Transcripts/[Proactive Thinker] Ways Rich People Make Money With Debt.txt` |
| Avatar | `Avatars/lou02.jpeg` |
| Bloco 1 | 6 imagens + 6 videos (50% IA / 50% stock) |
| Blocos 2-9 | 15 imagens + 2 videos (10% IA / 90% stock) |
| Thumbnail ref | URL de outro canal (ex.: `https://www.youtube.com/watch?v=VIDEO_ID`) |
| Thumbnails | 2 variacoes |

**Custo estimado Higgsfield:** ~178 creditos (imagens + thumbnails)

---

## (A) Fluxo ITERATIVO — passo a passo com recuperacao de erros

Este e o fluxo recomendado. Cada passo e independente; se falhar,
basta corrigir e reexecutar a partir do passo que parou.

### PASSO 1 — Criar o projeto (id esperado: 3)

```bash
npm run gentube -- create-video \
  --channel 1 \
  --title "Ways Rich People Make Money With Debt" \
  --niche "Educação financeira e investimentos" \
  --audience "público AMERICANO, ESTADOS UNIDOS com IDADE 40 anos ou acima" \
  --blocks 9 \
  --transcript-file "Transcripts/[Proactive Thinker] Ways Rich People Make Money With Debt.txt" \
  --mode iterativo
```

> Anote o **id** retornado. Nos comandos abaixo usamos `--project 3`
> (substitua pelo id real se for diferente).

**Se falhar:** nao criou nada no banco; corrija o erro e rode novamente.

### PASSO 2 — Verificar status inicial

```bash
npm run gentube -- status --project 3
```

> Deve mostrar: roteiro=pending, narracao=pending, imagens=pending.

### PASSO 3 — Gerar roteiro (9 blocos via Claude)

```bash
npm run gentube -- run-step --project 3 --step roteiro
```

> **Tempo estimado:** 2-5 min (9 chamadas ao Claude Opus).
> O terminal mostra `[bloco X/9] Gerando roteiro...` para cada bloco.

**Se falhar no bloco N:** o erro aparece no terminal. Corrigir e retomar:

```bash
# Retry apenas do bloco que falhou (ex.: bloco 4)
npm run gentube -- retry --project 3 --stage roteiro --block 4

# Ou refazer o roteiro inteiro
npm run gentube -- run-step --project 3 --step roteiro
```

**Verificar resultado:**

```bash
npm run gentube -- status --project 3
# roteiro deve estar "success"
```

### PASSO 4 — Gerar narracao (9 blocos via ElevenLabs)

```bash
npm run gentube -- run-step --project 3 --step narracao
```

> **Tempo estimado:** 3-8 min (9 chamadas TTS).
> Terminal mostra `[bloco X/9] Gerando narracao...` → `Audio salvo`.

**Se falhar no bloco N:**

```bash
# Retry do bloco que falhou (ex.: bloco 7)
npm run gentube -- retry --project 3 --stage narracao --block 7

# Ou refazer narracao inteira
npm run gentube -- run-step --project 3 --step narracao
```

**Verificar:**

```bash
npm run gentube -- status --project 3
# narracao deve estar "success"
```

### PASSO 5 — Gerar imagens e videos (producao mista: Higgsfield IA + Magnific stock)

```bash
npm run gentube -- run-step --project 3 --step imagens \
  --avatar-file Avatars/lou02.jpeg \
  --max-videos-block1 6 \
  --max-images-block1 6 \
  --max-videos-other 2 \
  --max-images-other 15
```

> **Producao mista:** o Claude marca cada shot como `ai_generated` (Higgsfield) ou `stock` (Magnific).
> A proporcao e controlada por `GENTUBE_STOCK_RATIO_BLOCK1` (default 50%) e `GENTUBE_STOCK_RATIO_OTHER` (default 90%).
> Shots stock sao baixados imediatamente da API Magnific; shots IA sao enfileirados no Higgsfield (modo async) ou aguardados (modo sync).
>
> **Tempo estimado:** 3-10 min para enfileirar os jobs IA + baixar stocks (9 blocos × direcao Claude + enqueue/download).
> O terminal mostra detalhadamente:
> - `[bloco X/9] Gerando plano de direcao (Claude)...`
> - `[bloco X/9] Plano: 15 imagens + 2 videos (3 IA + 14 stock) → blockXX.assets.json`
> - `  [bloco X/9] Stock baixado: s02 (image) → s02.jpg`
> - `  [bloco X/9] HF enfileirado: s01 (image) → abc123...`
> - Resumo final com o comando de sync

**Se falhar no bloco N:** os blocos anteriores ja foram enfileirados com sucesso.

```bash
# Retry apenas do bloco que falhou (ex.: bloco 5)
npm run gentube -- retry --project 3 --stage imagens --block 5 \
  --avatar-file Avatars/lou02.jpeg \
  --max-videos-other 2 \
  --max-images-other 15

# Retry do bloco 1 (usa limites diferentes)
npm run gentube -- retry --project 3 --stage imagens --block 1 \
  --avatar-file Avatars/lou02.jpeg \
  --max-videos-block1 6 \
  --max-images-block1 6
```

**Verificar quantos jobs foram criados:**

```bash
npm run gentube -- status --project 3
# imagens_videos deve estar "processing" ou "awaiting_hf" (esperando sync)
```

### PASSO 6 — Sincronizar / polling dos resultados Higgsfield

```bash
# Loop automatico: verifica a cada 30s, para quando todos terminarem
npm run gentube -- higgsfield:sync --project 3 --watch --interval 30s
```

> **Tempo estimado:** 5-30 min (depende da fila do Higgsfield).
> O terminal mostra para cada job:
> - `[sync 1/154] Consultando job abc123... (bloco 2, image, shot s01)`
> - `Job abc123... completed, baixando image...` → `baixado → s01.png`
> - Ou: `Job abc123... ainda em andamento (status=queued)`
> - Resumo por bloco: `Bloco 3: CONCLUIDO (17/17 arquivos baixados)`
>
> Use **Ctrl+C** para parar a qualquer momento; os resultados ja baixados ficam salvos.

**Se parou / quer continuar depois:**

```bash
# Rodar sync novamente (retoma de onde parou, so processa pendentes)
npm run gentube -- higgsfield:sync --project 3 --watch --interval 30s

# Uma unica rodada (sem loop):
npm run gentube -- higgsfield:sync --project 3
```

**Se jobs falharam e quer refazer um bloco:**

```bash
# Retry gera novos jobs para o bloco (apaga os antigos daquele bloco)
npm run gentube -- retry --project 3 --stage imagens --block 2 \
  --avatar-file Avatars/lou02.jpeg \
  --max-videos-other 2 \
  --max-images-other 15

# Depois sincroniza novamente
npm run gentube -- higgsfield:sync --project 3 --watch --interval 30s
```

### PASSO 7 — Gerar thumbnails

```bash
# (A) Com referencia de outro canal: baixa thumbnail + avatar → direto ao HF
npm run gentube -- run-step --project 3 --step thumbnails \
  --reference-url "https://www.youtube.com/watch?v=VIDEO_ID" \
  --avatar-file Avatars/lou02.jpeg \
  --count 2
```

> **Tempo estimado:** ~1 min para enfileirar + tempo do Higgsfield (~1-3 min por imagem).
> O terminal mostra:
> - `Thumbnail de referencia: video ID = ...`
> - `Referencia baixada → Thumbnail_VIDEO_ID.jpg`
> - `[thumb 1/2] Gerando thumbnail via Higgsfield...`
> - `[thumb 1/2] HF enfileirado → abc123...`

**Se `GENTUBE_HF_ASYNC=1`:** rode sync para baixar as thumbnails geradas:

```bash
npm run gentube -- higgsfield:sync --project 3 --watch --interval 30s
```

**Se quiser sem referencia (fluxo B):**

```bash
npm run gentube -- run-step --project 3 --step thumbnails \
  --avatar-file Avatars/lou02.jpeg \
  --count 2
```

**Se quiser com prompt customizado:**

```bash
npm run gentube -- run-step --project 3 --step thumbnails \
  --reference-url "https://www.youtube.com/watch?v=VIDEO_ID" \
  --avatar-file Avatars/lou02.jpeg \
  --prompt "generate a thumbnail with a man pointing at debt documents" \
  --count 2
```

**Se falhou e quer refazer:**

```bash
npm run gentube -- retry --project 3 --stage thumbnails \
  --reference-url "https://www.youtube.com/watch?v=VIDEO_ID" \
  --avatar-file Avatars/lou02.jpeg \
  --count 2
```

### PASSO 8 — Verificacao final

```bash
npm run gentube -- status --project 3
# Esperado: roteiro=success, narracao=success, imagens_videos=success, thumbnails=success

npm run gentube -- higgsfield:status
# Ver creditos restantes
```

---

## (B) Fluxo SEQUENCIAL — roteiro + narracao automatico

Mesmo resultado que (A), mas os passos 3 e 4 sao unificados.

### B1) Criar projeto com modo sequencial (executa roteiro + narracao de uma vez)

```bash
npm run gentube -- create-video \
  --channel 1 \
  --title "Ways Rich People Make Money With Debt" \
  --niche "Educação financeira e investimentos" \
  --audience "público AMERICANO, ESTADOS UNIDOS com IDADE 40 anos ou acima" \
  --blocks 9 \
  --transcript-file "Transcripts/[Proactive Thinker] Ways Rich People Make Money With Debt.txt" \
  --mode sequencial
```

> Executa automaticamente: roteiro (9 blocos) → narracao (9 blocos).
> Se falhar no meio, use `retry` no bloco especifico (igual ao fluxo A).

### B2) Verificar status

```bash
npm run gentube -- status --project 3
# roteiro=success, narracao=success
```

### B3) Imagens (mesmo comando do Passo 5 do fluxo A)

```bash
npm run gentube -- run-step --project 3 --step imagens \
  --avatar-file Avatars/lou02.jpeg \
  --max-videos-block1 6 \
  --max-images-block1 6 \
  --max-videos-other 2 \
  --max-images-other 15
```

### B4) Sync (mesmo do Passo 6)

```bash
npm run gentube -- higgsfield:sync --project 3 --watch --interval 30s
```

### B5) Verificacao final

```bash
npm run gentube -- status --project 3
```

---

## Se o projeto ja existe (reexecutar run-all)

```bash
# Roteiro + narracao juntos
npm run gentube -- run-all --project 3

# Imagens
npm run gentube -- run-step --project 3 --step imagens \
  --avatar-file Avatars/lou02.jpeg \
  --max-videos-block1 6 \
  --max-images-block1 6 \
  --max-videos-other 2 \
  --max-images-other 15

# Sync
npm run gentube -- higgsfield:sync --project 3 --watch --interval 30s
```

---

## Referencia rapida — recuperacao de erros

| Situacao | Comando |
|----------|---------|
| Roteiro falhou no bloco N | `npm run gentube -- retry --project 3 --stage roteiro --block N` |
| Narracao falhou no bloco N | `npm run gentube -- retry --project 3 --stage narracao --block N` |
| Imagens falhou no bloco N | `npm run gentube -- retry --project 3 --stage imagens --block N --avatar-file Avatars/lou02.jpeg --max-videos-other 2 --max-images-other 15` |
| Imagens bloco 1 falhou | `npm run gentube -- retry --project 3 --stage imagens --block 1 --avatar-file Avatars/lou02.jpeg --max-videos-block1 6 --max-images-block1 6` |
| Thumbnails refazer | `npm run gentube -- retry --project 3 --stage thumbnails --reference-url "URL" --avatar-file Avatars/lou02.jpeg --count 2` |
| Sync parou / quer continuar | `npm run gentube -- higgsfield:sync --project 3 --watch --interval 30s` |
| Ver creditos Higgsfield | `npm run gentube -- higgsfield:status` |
| Ver status do projeto | `npm run gentube -- status --project 3` |
| Apagar projeto e recomecar | `npm run gentube -- delete-project --project 3 --yes` |

---

## Estrutura final esperada

```
Videos/Late-Bloomer-Lou/20260511-Ways-Rich-People-Make-Money-With-Debt/
├── 01 - Roteiro/
│   ├── block01.md ... block09.md
├── 02 - Narracao/
│   ├── block01.mp3 ... block09.mp3
├── 03 - Imagens e Videos/
│   ├── block01.assets.json ... block09.assets.json
│   └── renders/
│       ├── block01/   (6 imgs + 6 vids + bootstraps)
│       ├── block02/   (15 imgs + 2 vids + bootstraps)
│       ├── ...
│       └── block09/
├── 04 - Thumbnails/
│   ├── thumb_ref_01.png
│   └── thumb_ref_02.png
└── 05 - Modelagem/
    ├── transcript.txt
    └── Thumbnail_VIDEO_ID.jpg   (referencia baixada)
```

---

## Notas

1. **`GENTUBE_HF_ASYNC=1`** esta no `.env`; nao precisa repetir inline.
2. **Limites de imagens/videos** so se aplicam ao step imagens. O Claude recebe no prompt; a validacao rejeita planos que excedam.
3. O **avatar** (`--avatar-file`) e usado como referencia visual; shots com `character_required: true` recebem a imagem e sao sempre `ai_generated`. No step **thumbnails**, o avatar e passado diretamente ao HF via `--image`.
4. No modo async, videos sem avatar geram um **bootstrap** extra (imagem intermediaria como `--start-image`).
5. **`higgsfield:sync --watch`** para quando todos os jobs ficam `done` ou `failed`. Ctrl+C para e mantem progresso.
6. Creditos: verifique antes com `higgsfield:status` e `elevenlabs:status`. Se acabar no meio, jobs restantes falham e podem ser refeitos com `retry`.
7. **Thumbnails** nao usam Claude — a referencia e o avatar vao direto ao Higgsfield via multiplos `--image`. O prompt pode ser customizado com `--prompt`.
8. **Producao mista (Higgsfield + Magnific):** o Claude decide quais shots sao IA e quais sao stock no plano de direcao. IA e reservada para hooks e momentos dramaticos; stock para apoio e transicoes. A proporcao e configuravel via `GENTUBE_STOCK_RATIO_BLOCK1` (default 50%) e `GENTUBE_STOCK_RATIO_OTHER` (default 90%). Shots stock sao baixados imediatamente, independente do modo async.
9. **`copy-cmd`:** gera o comando rsync pronto para colar no terminal local. Defina `GENTUBE_REMOTE_HOST` no `.env` ou use `--remote-host`. Exemplo: `npm run gentube -- copy-cmd --project 3`.

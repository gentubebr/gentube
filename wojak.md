# Modalidade visual Wojak — plano e rastreabilidade

Documento mestre da funcionalidade **Wojak** no GenTube. Estado da implementação: ver secção [Status](#status) no final.

**Relacionado:** [README.md](README.md) (uso e variáveis `.env`) · [ESPECIFICACAO_TECNICA.md](ESPECIFICACAO_TECNICA.md) (secção 18.10)

---

## Objetivo

Canal com avatar **Wojak** (line art preto/branco) em que o personagem **participa da narração** em cenas cómicas e envolventes, com:

1. **Consistência de estilo** — referência visual obrigatória (PNG canónica) + prompt de cena contextual.
2. **Bootstrap-then-animate** — vídeo: imagem bootstrap sync (Gemini) → **Veo** (Google) com `scXX__bootstrap.png`.
3. **Style token canônico** — prefixo fixo no render (além do que o Claude escreve em `description`).
4. **Plano narrativo** — em modo Wojak: só `ai_generated`; Wojak ilustra o beat (não B-roll stock paralelo).

**Princípio de regressão:** modalidade **opt-in** (`GENTUBE_VISUAL_MODALITY=default` por defeito). Projetos e canais existentes não mudam até ativar env e regerar plano/renders.

**Política v2 (implementada):** ver [Política de plano v2](#política-de-plano-v2).

---

## Arquitetura

```text
segmenta01.md (inalterado)
       ↓
visualiza01.md + visualiza_wojak.md (só se modality=wojak)
       ↓
blockNN.assets.json  (character_required, character_variant?, description)
       ↓
pipeline: resolveWojakSceneVisualInput()
       ↓
  image  → renderSceneImage → Google Batch (PNG ref por job) ou sync se forceSync
  video  → bootstrap sync (PNG + buildWojakReferenceImagePrompt) → Veo text-to-video (sem ref PNG no Veo por defeito)
       ↓
montagem (inalterada; usa scXX.mp4 ou scXX__bootstrap.png se faltar vídeo)
```

### Três desafios e solução

| Desafio | Problema hoje | Solução |
|---------|---------------|---------|
| Consistência | Só texto ou avatar genérico (`--avatar-file`) | PNG em `src/assets/wojak/` + multimodal Gemini |
| Bootstrap vídeo | Com `character_required` + ref, bootstrap **não** corre | Em modo Wojak: **sempre** bootstrap antes do Veo |
| Style token | `promptForSceneVisual` = description + negative | `WOJAK_STYLE_TOKEN` + `description` do plano |

---

## Decisões fechadas

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | Prompt visualização | **Addon:** `visualiza01.md` + `Prompts/visualiza_wojak.md` |
| 2 | Ativação | `GENTUBE_VISUAL_MODALITY=wojak` (default `default`) |
| 3 | Override prompt | `GENTUBE_PROMPT_VISUALIZA` (opcional) |
| 4 | `--avatar-file` | Em modo Wojak: **override** da PNG canónica se passado |
| 5 | Vídeo + personagem | Bootstrap sync obrigatório, depois Veo |
| 6 | Token no pipeline | Sim, curto, em `wojak-prompt.ts` |
| 7 | Plano v1 `shots[]` | Fora do mínimo; fase 2 se necessário |
| 8 | Fontes no plano (v2) | Só `ai_generated`; **sem** `stock` / `manual_capture` em modo Wojak |
| 9 | Tom das cenas | Cômico, exagerado, meme-adjacent — engajar sem perder o beat financeiro |
| 10 | Provedores no render | Imagens **Gemini**; vídeos **Veo**; **sem** Magnific stock nem Higgsfield |
| 11 | `stock_ratio` com Wojak | **0** no prompt Claude (ignorar `GENTUBE_STOCK_RATIO_*`) |

---

## Política de plano v2

Requisitos para canais em `GENTUBE_VISUAL_MODALITY=wojak` (implementados em `visualiza_wojak.md`, `wojak-prompt.ts` e `pipeline.ts`).

### Plano (`blockNN.assets.json`)

| Regra | Detalhe |
|-------|---------|
| **Fonte** | Todas as cenas: `"source": "ai_generated"`, `"search_keywords": null`. Proibido `stock` e `manual_capture`. |
| **Personagem** | Wojak em **todas** as cenas (ou exceção raríssima documentada no JSON). `"character_required": true` + `character_variant` adequado. |
| **Narrativa** | `description` descreve o Wojak **a agir** o que a `narration_text` diz — não metáfora genérica sem personagem (ex.: showroom stock enquanto narra “compro a concessionária”). |
| **Tom** | Cenas **cómicas e engraçadas**: expressões exageradas, gestos meme, ironia visual, escala absurda do trilhão — mantendo line art Wojak (sem virar cartoon colorido). |
| **Tipo image/video** | Priorizar `"type": "video"` nos beats narrativos (movimento explícito na `description` para o Veo). `"type": "image"` só para transições muito curtas ou quando o cap de vídeos do bloco estiver cheio. |
| **Vídeo** | `description` com **motion cues** (walk, point, throw money, facepalm, celebrate, etc.). |

### Caps (imagens / vídeos / cenas)

- Defaults do GenTube: bloco 1 → até **20** imagens + **16** vídeos (máx. **36** cenas = soma dos caps).
- Podes **aumentar** quando precisares via CLI ou `.env`:
  - `--max-videos-block1`, `--max-images-block1` (e `*-other` para blocos 2+)
  - `GENTUBE_MAX_VIDEOS_BLOCK1`, `GENTUBE_MAX_IMAGES_BLOCK1`, etc.
- Mais vídeos Wojak = mais custo Google (bootstrap + Veo por cena).

### Render (após plano aprovado)

| Provedor | Uso |
|----------|-----|
| **Gemini** | `GENTUBE_IMAGE_BACKEND=gemini` — imagens e bootstrap |
| **Veo** | `GENTUBE_VIDEO_BACKEND=veo` — animação |
| **Excluído** | Magnific/stock, Higgsfield (não alterar qualidade com outro backend) |

Env recomendado na corrida Wojak (ver também `.env.example`):

```bash
export GENTUBE_VISUAL_MODALITY=wojak
export GENTUBE_IMAGE_BACKEND=gemini
export GENTUBE_IMAGE_DELIVERY=google_batch   # imagens estaticas: forcado google_batch em wojak (exceto bootstrap)
export GENTUBE_VIDEO_BACKEND=veo
export GENTUBE_HF_ASYNC=0
export GENTUBE_SCENE_PLAN_V2=1
export GENTUBE_WOJAK_VEO_USE_REF=0          # Veo sem PNG ref; prompt sanitizado (evita RAI third-party)
```

### Opção B — batch Google com referência (produção)

| Tipo de cena | Entrega | Referência multimodal |
|--------------|---------|------------------------|
| `type: image` | `resolveSceneImageDelivery()` → **`google_batch`** em modo wojak | PNG da variant (`src/assets/wojak/`) ou `--avatar-file`; partes via `buildGeminiMultimodalParts` em `gemini-batch.ts` |
| Bootstrap `scXX__bootstrap` | **sync** (`forceSync: true`) | `buildWojakReferenceImagePrompt(description, negative)` + PNG canónica |
| `type: video` (Veo) | **sync** (sem batch Veo) | Por defeito **sem** enviar bootstrap ao Veo (`GENTUBE_WOJAK_VEO_USE_REF=0`); bootstrap fica em disco para montagem |

Poll das imagens em batch: `npm run gentube -- image:sync --project <id> --watch`.

**Estimativa de custo:** `npm run gentube -- cost-estimate --project <id>` — usa tarifas `GENTUBE_COST_USD_*` (ver `.env.example`); implementação em `src/services/wojak-cost-estimate.ts`.

### Critérios de aceite do plano (revisão manual)

Antes de `narracao` / render, confirmar no JSON:

- [ ] Zero cenas com `source: stock` ou `manual_capture`
- [ ] Quase todas com `character_required: true` e `character_variant` coerente com o tom
- [ ] Cada `description` responde: “o que o Wojak está fazendo **agora** nesta frase?”
- [ ] Tom cômico perceptível (não só pose neutra em fundo branco)
- [ ] Vídeos com indicação de movimento; contagem `type: video` ≤ cap do bloco

### Histórico do plano piloto

- **Pré-v2 (rejeitado):** primeiro `block01.assets.json` — 19 stock, 13 com Wojak.
- **Pós-v2 (conforme):** regerado com `GENTUBE_FORCE_VIZ_REGEN=1` + `plan-only` — 36 cenas, todas `ai_generated`, Wojak em todas, 16 vídeos + 20 imagens.

---

## Assets

Diretório: `src/assets/wojak/`

| Ficheiro | Variante | Uso |
|----------|----------|-----|
| `wojak_neutral.png` | `neutral` | Tom explicativo / neutro |
| `wojak_happy.png` | `happy` | Conteúdo positivo |
| `wojak_smiling.png` | `smiling` | Sorriso aberto |
| `wojak_tired.png` | `tired` | Fadiga, burnout |
| `wojak_doomer.png` | `doomer` | Tom cínico (beanie) |
| `wojak_frontal.png` | `frontal` | Olhar para câmara |
| `wojak_impressed.png` | `impressed` | Surpresa positiva |
| `wojak_pain.png` | `pain` | Perda, frustração |

Script opcional: `scripts/setup-wojak.sh` (copia PNGs de origem externa).

---

## Variáveis de ambiente

| Variável | Default | Descrição |
|----------|---------|-----------|
| `GENTUBE_VISUAL_MODALITY` | `default` | `default` \| `wojak` |
| `GENTUBE_PROMPT_VISUALIZA` | (auto) | Ficheiro em `Prompts/`; se vazio, `wojak` usa composição `visualiza01` + `visualiza_wojak` |
| `GENTUBE_WOJAK_STYLE_TOKEN` | (built-in) | Override opcional do prefixo de estilo |

`--avatar-file` no CLI: inalterado; em modo `wojak` substitui a PNG da variant quando definido.

---

## Schema do plano (v2)

Campo **opcional** em `visual` (planos antigos válidos sem ele):

```json
"character_variant": "neutral|happy|smiling|tired|doomer|frontal|impressed|pain"
```

Regras alvo no `visualiza_wojak.md` (v2 — após implementação):

- Todas as cenas → `ai_generated`, `character_required: true`, `search_keywords: null`
- `description` em inglês: Wojak + ação cômica ligada à narração + motion cues se `type: video`
- Proibido `stock` e `manual_capture` em modo Wojak

---

## Ficheiros do código

| Ficheiro | Papel |
|----------|--------|
| `Prompts/visualiza_wojak.md` | Regras v2 do plano (só `ai_generated`, tom cômico, motion cues) |
| `src/utils/wojak-prompt.ts` | `prepareSceneVisualRender`, `assertWojakBlockPlan`, prompts ref/Veo, sanitização |
| `src/assets/wojak/*.png` | Referências por `character_variant` (×8) |
| `src/config.ts` | `resolveVisualModality`, `resolveStockRatioForBlock`, `resolveSceneImageDelivery` |
| `src/integrations/gemini-batch.ts` | Batch com `buildGeminiMultimodalParts` + ref PNG |
| `src/services/pipeline.ts` | Plano Claude, loop render v2, guards sem stock/HF |
| `src/services/image-generation.ts` | `renderSceneImage`, flush batch |
| `src/services/video-generation.ts` | Força Veo em modo wojak |
| `src/services/wojak-cost-estimate.ts` | `cost-estimate` CLI |
| `scripts/setup-wojak.sh` | Copiar PNGs de origem externa (opcional) |
| `scripts/continue-missing-renders.ts` | Retomar imagens/bootstraps quando `retry` trava no primeiro Veo (ex. 429) |
| **Inalterados no contrato** | `segmenta01.md`, `visualiza01.md`, `montagem.ts` (consome renders existentes) |

---

## Implementação — ordem

1. Assets PNG + `setup-wojak.sh`
2. `config.ts`
3. `Prompts/visualiza_wojak.md`
4. Tipos + `assertVisual`
5. `wojak-prompt.ts`
6. `pipeline.ts` (uma linha prompt + helper no loop ~997–1036)
7. Documentação e `.env.example`
8. Testes (checklist abaixo)

### Contrato `prepareSceneVisualRender` (`wojak-prompt.ts`)

Entrada: `visual`, `narrationText`, `modality`, `avatarRef?`.

Saída (`SceneVisualRenderPrep`):

```ts
{
  hfPrompt: string;              // imagem / bootstrap (multimodal ref)
  bootstrapPrompt?: string;
  veoPrompt?: string;            // texto sanitizado (sem "Wojak" quando RAI bloqueia)
  referenceImageUrl?: string;    // PNG da variant ou avatar-file
  wojakVideoBootstrap?: boolean; // true → pipeline gera scXX__bootstrap antes do Veo
}
```

Lógica resumida:

- `modality !== "wojak"` ou `!character_required` → `promptForSceneVisual` + `avatarRef` opcional.
- `modality === "wojak"` && `character_required` → ref por variant; bootstrap obrigatório se `type === "video"`.

---

## O que não é impactado

| Item | Motivo |
|------|--------|
| `segmenta01.md` | Sem campo visual |
| `visualiza01.md` | Só leitura em `default` |
| `blockNN.assets.json` em disco | Válidos sem `character_variant` |
| Renders / montagem existentes | Só mudam se reexecutar imagens |
| Stock / manual_capture em modo `default` | Inalterado |
| Canais sem `GENTUBE_VISUAL_MODALITY=wojak` | Ramo `default` idêntico ao atual |

---

## Implementação v2

Alterações acordadas; **implementadas** no código (prompt, `stock_ratio: 0`, validação, render sem stock/HF).

| # | Entrega | Ficheiros / comportamento |
|---|---------|---------------------------|
| 1 | **Prompt** | Reescrever `Prompts/visualiza_wojak.md` (só `ai_generated`, Wojak em todas, tom cômico, motion cues, sem stock) |
| 2 | **`stock_ratio: 0`** | `pipeline.ts` + contexto Claude quando `modality === "wojak"` |
| 3 | **Validação** | Pós-parse: rejeitar plano Wojak com `stock` / `manual_capture`; avisos para `character_required: false` ou excesso de `image` |
| 4 | **Render** | Em modo Wojak: não chamar Magnific/stock; não enfileirar HF; imagens/vídeos só Gemini+Veo |
| 5 | **Docs** | Atualizar `README.md`, `ESPECIFICACAO_TECNICA.md` §18.10, `.env.example` |
| 6 | **Regenerar piloto** | `FORCE_VIZ_REGEN` + `plan-only` bloco 1; revisar JSON; depois narracao + render piloto sync |

Ordem sugerida de desenvolvimento: **1 → 2 → 3 → 4 → 5 → 6**.

---

## Testes manuais

1. **Regressão default** — sem env Wojak, `plan-only` → prompt `visualiza01` apenas.
2. **Plano Wojak v2** — `modality=wojak`, `plan-only`, `stock_ratio` efetivo 0 → só `ai_generated`, Wojak em todas, tom cômico.
3. **Imagem** — cena `image` + personagem → Gemini com PNG + estilo estável.
4. **Vídeo** — `scXX__bootstrap.png` gerado → vídeo; montagem usa bootstrap se sem mp4.
5. **Override** — `--avatar-file` em modo Wojak.
6. **Fallback variant** — plano sem `character_variant` → detecção por `narration_text`.
7. **Batch Google** — `reference_image_path` no job aponta para Wojak.
8. **Projeto antigo** — reutilizar `assets.json` sem regerar.

---

## Rollout (ex.: canal Late-Bloomer-Lou)

1. Deploy com default `default`.
2. `.env`: `GENTUBE_VISUAL_MODALITY=wojak`.
3. `GENTUBE_FORCE_VIZ_REGEN=1` + `--plan-only` / imagens só nos blocos desejados.
4. Não regerar montagem inteira só por Wojak.

---

## Exemplo de execução (projeto piloto)

Referência real: projeto **id 11**, slug `20260520-Can-you-spend-1Tri-Dollar` (canal Late Bloomer Lou, 1 bloco, transcript Jack Pockets). Pasta:

`Videos/Late-Bloomer-Lou/20260520-Can-you-spend-1Tri-Dollar/`

Use **Node 23** no PATH (`better-sqlite3` falha no Node 20 do Cursor).

### Ordem correta (não pular o plan-only)

| # | Etapa | Notas |
|---|--------|--------|
| 0 | `create-video` + transcript | `--blocks 1`, `--transcript-file`, `--prompt-canal-voice canal_voice.md` |
| 1 | Roteiro | `run-step --step roteiro` |
| 2 | **Cenas Wojak** | `imagens` + `--scene-plan-v2` + **`--plan-only`** + **`GENTUBE_VISUAL_MODALITY=wojak`** |
| 3 | Revisar plano | Abrir `03 - Imagens e Videos/block01.assets.json` |
| 4 | Narração por cena | `run-step --step narracao` (com plano no disco → `02 - Narracao/block01/scXX.mp3`) |
| 5 | Renders / qualidade | Ver [Próximos passos após o plano](#próximos-passos-após-o-plano) |

**Erro comum:** rodar `imagens` sem `--plan-only` (ou `narracao` antes do plano) — gera MP3 monolítico e tenta render antes de existir `scenes[]` com regras Wojak.

### Comandos copiáveis

```bash
cd /home/development/gentube
export PATH="/home/development/.nvm/versions/node/v23.11.0/bin:$PATH"
export GENTUBE_VISUAL_MODALITY=wojak

# 1) Roteiro (se ainda não existir block01.md)
npm run gentube -- run-step --project 20260520-Can-you-spend-1Tri-Dollar \
  --step roteiro \
  --prompt-matrix matriz_tutorial.md \
  --prompt-canal-voice canal_voice.md

# 2) Só bloco 1 — criar cenas (Claude segmenta + visualiza Wojak), SEM renders
npm run gentube -- retry --project 20260520-Can-you-spend-1Tri-Dollar \
  --stage imagens --block 1 --scene-plan-v2 --plan-only

# Equivalente para todos os blocos do projeto:
# npm run gentube -- run-step --project 20260520-Can-you-spend-1Tri-Dollar \
#   --step imagens --scene-plan-v2 --plan-only

# 3) Depois de revisar o JSON — narração por cena (texto = narration_text do plano)
npm run gentube -- run-step --project 20260520-Can-you-spend-1Tri-Dollar \
  --step narracao --block 1 --voice-id <ELEVENLABS_VOICE_ID>
# Nova voz ou plano atualizado — regenera todos os scXX.mp3:
# npm run gentube -- retry --project 20260520-Can-you-spend-1Tri-Dollar \
#   --stage narracao --block 1 --force-narracao --voice-id <VOICE_ID>

# 4) Regerar plano (se mudou prompt Wojak ou caps)
export GENTUBE_FORCE_VIZ_REGEN=1
npm run gentube -- retry --project 20260520-Can-you-spend-1Tri-Dollar \
  --stage imagens --block 1 --scene-plan-v2 --plan-only
```

### Resultado do plan-only (projeto 11, bloco 1)

- **Pós-v2:** 36 cenas, 100% `ai_generated`, Wojak + `character_variant` em todas; ver ficheiro em `03 - Imagens e Videos/block01.assets.json`

### Próximos passos após o plano (v2) — produção opção B

1. `cost-estimate --project <id>` — rever custo por bloco/projeto
2. `narracao`
3. `retry --stage imagens --block N --scene-plan-v2` (ou `run-step --step imagens` com `--enqueue-only`) — imagens → batch+ref; bootstraps+vídeos na mesma corrida
4. `image:sync --project <id> --watch` — poll batch Google
5. Se o passo 3 parar em **Veo 429** antes de enfileirar imagens mais à frente no plano: `npx tsx scripts/continue-missing-renders.ts` + `image:sync` (passo 4)
6. Quando a cota Veo voltar: `retry --stage imagens --block N` (salta PNG/bootstrap/mp4 já no disco; gera só `.mp4` em falta)

**Piloto sync (debug qualidade, mais caro):** `GENTUBE_IMAGE_DELIVERY=sync` no `.env` (sobrescreve batch só se remover modo wojak auto-batch — em wojak o codigo forca batch nas imagens estaticas).

**Teste rápido sync (legado):**

```bash
export GENTUBE_VISUAL_MODALITY=wojak
export GENTUBE_IMAGE_BACKEND=gemini
export GENTUBE_VIDEO_BACKEND=veo
export GENTUBE_IMAGE_DELIVERY=sync
export GENTUBE_HF_ASYNC=0

npm run gentube -- retry --project 20260520-Can-you-spend-1Tri-Dollar \
  --stage imagens --block 1 --scene-plan-v2
```

**Produção (batch Google):**

```bash
export GENTUBE_VISUAL_MODALITY=wojak
export GENTUBE_IMAGE_BACKEND=gemini
export GENTUBE_VIDEO_BACKEND=veo
export GENTUBE_HF_ASYNC=0

npm run gentube -- retry --project 20260520-Can-you-spend-1Tri-Dollar \
  --stage imagens --block 1 --scene-plan-v2 --google-batch-mode --enqueue-only

npm run gentube -- image:sync --project 11 --watch --interval 30s
```

**Caps customizados (exemplo):**

```bash
npm run gentube -- retry --project 20260520-Can-you-spend-1Tri-Dollar \
  --stage imagens --block 1 --scene-plan-v2 --plan-only \
  --max-videos-block1 20 --max-images-block1 10
```

Renders esperados: `03 - Imagens e Videos/renders/block01/scXX.png` (e `scXX__bootstrap.png` antes de vídeos Wojak).

### Retomada parcial (quota Veo / 429)

O `retry --stage imagens` processa cenas **em ordem** e **falha** no primeiro vídeo Veo sem quota — imagens **depois** dessa cena no plano não chegam a ser enfileiradas.

**Fluxo recomendado:**

1. Gerar imagens estáticas e bootstraps pendentes (sem chamar Veo):

```bash
npx tsx scripts/continue-missing-renders.ts --project <id|slug> --block 1
npm run gentube -- image:sync --project <id> --watch --interval 30s
```

2. Quando a cota Veo voltar, só os `.mp4` em falta:

```bash
sqlite3 data/gentube.db "UPDATE media_blocks SET renders_status='pending', plan_error=NULL WHERE project_id=<id> AND block_number=1;"
npm run gentube -- retry --project <slug> --stage imagens --block 1 --scene-plan-v2
```

O retry **salta** ficheiros já no disco (`scXX.png`, `scXX__bootstrap.png`, `scXX.mp4`).

**Erro comum no SQLite:** bloco marcado `awaiting_hf` sem jobs pendentes fazia o pipeline saltar o bloco inteiro — corrigido em `shouldSkipImagensBlock` (`pipeline.ts`). Se precisar, reset manual de `renders_status` como acima.

**Monitorar cota Google:** https://ai.dev/rate-limit

### Execução em background (narração + renders por bloco)

Recomendado **dois terminais**:

| Terminal A | Terminal B (opcional mas útil) |
|--------------|--------------------------------|
| Pipeline por bloco (narração → imagens → sync) | Poll contínuo dos batches Google |

**Terminal A — iniciar em background:**

```bash
cd /home/development/gentube
nohup ./scripts/background-wojak-blocks.sh \
  --project 20260520-Can-you-spend-1Tri-Dollar \
  --from 2 --to 8 \
  --voice-id PzuBz8h2SxBvQ7lnUC44 \
  > /dev/null 2>&1 &
echo $!   # PID para kill se precisar
```

**Terminal B — enquanto A corre:**

```bash
npm run gentube -- image:sync --project 11 --watch --interval 30s
```

**Monitorar progresso:**

```bash
tail -f Videos/Late-Bloomer-Lou/20260520-Can-you-spend-1Tri-Dollar/pipeline-background.log
npm run gentube -- status --project 20260520-Can-you-spend-1Tri-Dollar
npm run gentube -- image:status --project 11
```

**Pré-requisitos:** `blockNN.assets.json` já existe (`--plan-only` antes). `.env` com `GENTUBE_VISUAL_MODALITY=wojak`, `GENTUBE_IMAGE_DELIVERY=google_batch`, `GENTUBE_VIDEO_BACKEND=veo`.

Alternativas: `tmux new -s gentube` / `screen`; ou job no Cursor com comando acima.

---

## Status

| Etapa | Estado |
|-------|--------|
| Modalidade Wojak v1 (opt-in, PNG, bootstrap, addon prompt) | Concluído |
| Assets PNG em `src/assets/wojak/` | Concluído (×8) |
| **Política de plano v2** (só IA, Wojak narrativo, cômico, Google-only) | Implementada |
| Implementação v2 (prompt + stock_ratio 0 + validação + render guards) | Concluída |
| Opção B — Batch Google com ref PNG por job | Concluída |
| `gentube cost-estimate --project` | Concluída |
| `scripts/continue-missing-renders.ts` (retomada sem Veo) | Concluída |
| Plano piloto `block01.assets.json` (projeto 11) | Conforme v2 — 36 cenas, 20 image + 16 video |
| Renders piloto bloco 1 (2026-05-20) | **30/36** no disco; **6 vídeos Veo** pendentes (quota `429 RESOURCE_EXHAUSTED`) |
| Montagem piloto | Pendente (após os 6 `.mp4`) |

### Veo: política (guardrails) e quota

| Sintoma | Causa provável | Mitigação |
|---------|----------------|-----------|
| `third-party content` / RAI | Nome ou estilo meme no prompt Veo | `sanitizeWojakPromptForVeo`; `GENTUBE_WOJAK_VEO_USE_REF=0` |
| `429 RESOURCE_EXHAUSTED` | Cota/rate limit Google (Veo) | Esperar reset; `continue-missing-renders` + `image:sync` para PNG; depois `retry` só vídeos |
| Bootstrap OK, mp4 falha | Normal em RAI ou quota | Montagem pode usar `scXX__bootstrap.png` até haver mp4 |

**Bootstrap / imagem:** PNG canónica + `buildWojakReferenceImagePrompt`; emoção na `description` reforça a variant quando não é `neutral`.

*Última atualização: 2026-05-20 — v2, opção B, cost-estimate, retomada parcial (piloto bloco 1).*

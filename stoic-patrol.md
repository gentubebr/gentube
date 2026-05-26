# Modalidade visual Stoic Patrol — plano e rastreabilidade

Documento mestre da funcionalidade **Stoic Patrol** no GenTube.

**Estado:** MVP operacional — Hyperframes (+40% typing), montagem com **freeze** no último frame quando narração > vídeo em `quote_card`; piloto 1 bloco em `Videos/Stoic-Patrol/`.

**Relacionado:** [README.md](README.md) · [ESPECIFICACAO_TECNICA.md](ESPECIFICACAO_TECNICA.md) (futura sec. 18.11 ou 27) · padrão [wojak.md](wojak.md)

**Canal:** Stoic Patrol · **Público:** EUA, 30+, filosofia, estoicismo, psicologia, religião  
**Tom:** masculino, maduro, conversacional (derivado de `matriz.md`, adaptado)  
**Idioma do roteiro:** inglês (como `matriz.md`)

---

## Objetivo

Vídeos longos (8 blocos) com:

1. **B-roll 100% stock** (Magnific, fallback **Pexels**, cache local) para a maior parte dos beats.
2. **Cartões de citação** quando o roteiro traz citação **explícita** (Bíblia, filósofo, “quote”, alguém “saying”, etc.) — texto grande + atribuição menor, animação **typing**, fundo preto, fonte estilo Montserrat.
3. **Sincronização na montagem:** enquanto a narração **diz** a citação, o espectador vê o texto a ser “digitado”; logo a seguir o stock retoma o fluxo visual.

**Princípio de regressão:** modalidade **opt-in** (`GENTUBE_VISUAL_MODALITY=stoic_patrol`). Projetos `default` e `wojak` não mudam.

---

## Respostas às decisões (fechadas nesta proposta)

| # | Pergunta | Decisão proposta |
|---|----------|------------------|
| 1 | Quando gerar quote? | Só quando **explícito no roteiro** (padrões abaixo). Prompts dedicados como no Wojak. |
| 2 | Layout do cartão | **Frase** em fonte maior; **atribuição** logo abaixo, menor, se existir. |
| 3 | Limite de quotes | **Sem teto** por bloco. Caps de **stock** por bloco via `GENTUBE_MAX_*` / CLI (como hoje). |
| 4 | Hyperframes | Instalar na fase de implementação (Node ≥ 22, FFmpeg já usado na montagem). |
| 5 | video-use? | **Não** no pipeline automático do GenTube (ver secção abaixo). |
| 6 | Onde vive o “tipo”? | **Schema** em `blockNN.assets.json` + flag de modalidade; opcionalmente `channels.visual_modality` no SQLite (ver secção Schema). |

---

## video-use — precisamos?

**Não**, para o fluxo Stoic Patrol descrito aqui.

| Ferramenta | Função | Stoic Patrol |
|------------|--------|----------------|
| **GenTube + Hyperframes** | Plano por cena → quote cards + stock (Magnific → Pexels) → montagem FFmpeg | **Núcleo** |
| **video-use** | Agente edita **footage bruto** (takes, cortes, legendas queimadas, color grade) a partir de pastas | **Opcional / à parte** |

**video-use** assume que colocas vídeos crus numa pasta e pedes “edita isto” no chat. Não lê `blockNN.assets.json`, não chama Magnific por `search_keywords`, não gera cartões typing a partir do roteiro.

**Quando faria sentido video-use (fora do GenTube):**

- Refinar um `final.mp4` já montado (cortar silêncios, legendas estilo TikTok, etc.).
- Editar entrevistas ou takes que **não** passaram pelo pipeline de blocos.

**Conclusão:** Stoic Patrol = **Hyperframes** (quotes) + **stock** (Magnific, fallback Pexels) + **montagem GenTube** (sync áudio ↔ cartão). **video-use** fica fora do MVP; podes usar manualmente depois se quiseres pós-produção conversacional.

---

## Arquitetura (espelho Wojak)

```text
matriz_stoic_patrol.md          (roteiro: como citar Bíblia, filósofos, quotes)
       ↓
segmenta01.md + segmenta_stoic_patrol.md   (cenas verbatim; hint opcional is_quote_beat)
       ↓
visualiza01.md + visualiza_stoic_patrol.md (stock OU quote_card)
       ↓
blockNN.assets.json
       ↓
pipeline stoic_patrol:
  source=stock     → Magnific; se falhar → Pexels (GENTUBE_STOCK_PROVIDER=magnific_then_pexels)
                   → cache data/stock_cache/ por type+keywords
  source=quote_card → Hyperframes render → scXX.mp4 (sem áudio)
  narração         → scXX.mp3 (ElevenLabs, mesmo narration_text)
       ↓
montagem: clip quote mais curto que o MP3 → **último frame estático** até fim da narração (`holdLastFrame`); depois stock na cena seguinte
```

### Impacto visual (requisito de produto)

```text
[narração normal]  →  stock A
[narração = citação explícita]  →  quote card (typing) + áudio sincronizado
[narração continua]  →  stock B (sem “colar” a citação no stock anterior)
```

A **segmentação** deve preferir **uma cena = uma unidade de citação** quando o roteiro trouxer a frase isolada (aspas, “as X said”, versículo, etc.), para `narration_text` do MP3 coincidir com o texto do cartão.

### Transcrição de referência (fidelidade de tom)

- Gravar em `05 - Modelagem/transcript.txt` via `project:create --transcript-file` (pode estar em PT ou outro idioma).
- **`matriz_stoic_patrol.md`** exige: mesma **arco emocional** e **tipo de humor/melancolia**, texto **100% original em inglês**, zero cópia de frases da fonte.
- Piloto temático: *remoção dolorosa que liberta para a próxima fase* (inspirado em transcrições tipo “Changes hurt, but worth” — Lot, óleo de 2 Reis 4, separação de Ló, etc., **recontados** para o público US).

### Montagem quote_card

- Typing Hyperframes **~40% mais rápido** que o baseline (`typingDuration / 1.4`).
- Se `tAudio > tVideo`: **congelar último frame** (`tpad=stop_mode=clone`) — não fazer loop do vídeo inteiro.

---

## Deteção de citação explícita (roteiro + segmentação + visualização)

### Padrões no roteiro (`matriz_stoic_patrol.md` deve **ensinar** o autor a escrever assim)

| Tipo | Exemplos no texto (inglês) |
|------|----------------------------|
| Bíblia | `John 3:16`, `Psalm 23:1`, “Scripture says”, “the Bible tells us” + frase entre aspas |
| Citação direta | Texto entre `"..."` ou `“...”` |
| Filósofo / pensador | “Marcus Aurelius said”, “as Seneca wrote”, “Epictetus reminds us” |
| Alguém a falar | “he said”, “she whispered”, “the voice in your head says” (quando seguido de frase citável) |
| Rótulo explícito | “Quote:”, “Remember this:” + frase memorável |

**Não** gerar `quote_card` quando:

- Paráfrase sem aspas nem atribuição clara.
- Menção vaga (“the Stoics believed…”) sem frase citável delimitada.
- Nome bíblico só como **metáfora visual** (“like David facing Goliath”) — aí usar **stock**, não cartão.

### Segmentação (`segmenta_stoic_patrol.md` — addon)

Regras **adicionais** a `segmenta01.md` (verbatim e caps inalterados):

1. Se um trecho do bloco for **só** a citação (+ atribuição curta), **isolar** em cena(s) própria(s) — não misturar com comentário do narrador na mesma `narration_text`.
2. Campo opcional por cena (novo na saída de segmentação):

```json
"quote_hint": true
```

`quote_hint: true` quando o trecho corresponde a padrões explícitos acima (heurística no prompt; validação no pipeline na implementação).

3. Se citação longa (> ~25 palavras), **partir** em várias cenas só se o roteiro tiver pausas naturais; cada parte mantém `quote_hint` e texto verbatim.

### Visualização (`visualiza_stoic_patrol.md` — addon)

Regras **adicionais** a `visualiza01.md`:

| Condição | `visual.source` | Stock |
|----------|-----------------|-------|
| `quote_hint: true` ou narração com citação explícita | `quote_card` | Não |
| Resto | `stock` | Sim (`search_keywords` em inglês) |

- **`stock_ratio` efetivo:** tratar como **100% stock** entre cenas que **não** são `quote_card` (quotes **fora** do denominador do ratio, como `manual_capture` em `visualiza01.md`).
- **`manual_capture`:** proibido neste canal (salvo decisão futura).
- **`ai_generated`:** proibido no MVP (sem HF/Gemini/Veo). Stock: Magnific → Pexels; **sem** fallback IA (diferente do modo `default`).

---

## Schema proposto

### 1) Modalidade e canal (configuração)

| Camada | Campo | Valor |
|--------|-------|-------|
| `.env` / projeto | `GENTUBE_VISUAL_MODALITY` | `stoic_patrol` |
| Canal (SQLite, proposta) | `channels.content_type` ou `channels.visual_modality` | `stoic_patrol` |
| Projeto (opcional) | `video_projects.visual_modality` | override por vídeo |

`type = "religious"` pode ser **tag semântica** do canal (nicho) em `channels.niche` / metadados, sem substituir `visual_modality=stoic_patrol` no pipeline.

### 2) Segmentação — extensão opcional (`2.0-segmentation-stoic`)

```json
{
  "schema_version": "2.0-segmentation",
  "stage": "segmentation",
  "block_number": 1,
  "total_blocks": 8,
  "scenes": [
    {
      "id": "sc12",
      "narration_text": "\"The obstacle is the way.\"",
      "narration_word_count": 5,
      "quote_hint": true
    }
  ]
}
```

Campos herdados de `segmenta01.md` permanecem obrigatórios; `quote_hint` omitido ou `false` = beat normal.

### 3) Visualização — novo `source`: `quote_card`

Extensão de `VisualSourceV2` (implementação futura):

```ts
type VisualSourceV2 =
  | "ai_generated"
  | "stock"
  | "manual_capture"
  | "quote_card";   // novo — só stoic_patrol
```

#### Cena stock (inalterada em estrutura)

```json
{
  "id": "sc11",
  "narration_text": "And that is when everything changes for the man who waits.",
  "narration_word_count": 11,
  "visual": {
    "type": "image",
    "source": "stock",
    "role": "illustration",
    "duration_seconds_max": 5,
    "description": "Man sitting alone at dawn, contemplative mood, cinematic",
    "search_keywords": "man thinking sunrise window silhouette",
    "capture_brief": null,
    "ip_risk": "low",
    "character_required": false
  }
}
```

#### Cena quote_card (nova)

```json
{
  "id": "sc12",
  "narration_text": "\"The obstacle is the way.\"",
  "narration_word_count": 5,
  "visual": {
    "type": "video",
    "source": "quote_card",
    "role": "quote",
    "duration_seconds_max": 6,
    "description": "Quote card: black background, white Montserrat, typing animation",
    "search_keywords": null,
    "quote_text": "The obstacle is the way.",
    "quote_attribution": "Marcus Aurelius",
    "animation_type": "typing",
    "render_engine": "hyperframes",
    "capture_brief": null,
    "ip_risk": "none",
    "character_required": false
  }
}
```

| Campo | Obrigatório | Regra |
|-------|-------------|-------|
| `quote_text` | Sim | Texto **sem** aspas externas; deve ser substring **literal** de `narration_text` (ou igual ao trecho citado). |
| `quote_attribution` | Não | Ex.: `Marcus Aurelius`, `John 3:16 (NIV)`, `Seneca, Letters`. Omitir se o roteiro não atribuir. |
| `animation_type` | Sim | MVP: só `"typing"`. |
| `render_engine` | Sim | MVP: `"hyperframes"`. |
| `type` | Sim | Sempre `"video"` (animação typing). |
| `duration_seconds_max` | Sim | Teto; montagem ajusta ao MP3 real. |

**Caps `max_videos` / `max_images`:** cenas `quote_card` contam como **`type: video`** para o cap de vídeos do bloco (1 quote = 1 vídeo Hyperframes).

### 4) Plano final (`blockNN.assets.json`)

`schema_version` permanece `"2.0"`; validador stoic_patrol exige:

- Toda cena com `quote_hint` ou citação explícita → `source: quote_card` + campos quote.
- Demais cenas → `source: stock` apenas.
- Nenhuma cena `ai_generated` no MVP.

### 5) Artefactos em disco (proposta)

| Cena | Ficheiro | Origem |
|------|----------|--------|
| quote | `03 - Imagens e Videos/renders/blockNN/scXX.mp4` | Hyperframes (mudo) |
| stock image | `.../scXX.jpg` | Magnific ou Pexels |
| stock video | `.../scXX.mp4` | Magnific ou Pexels |
| narração | `02 - Narracao/blockNN/scXX.mp3` | ElevenLabs |
| template HF (dev) | `03 - Imagens e Videos/quote_templates/blockNN/scXX/` | HTML + assets (opcional, debug) |
| cache quote | `data/quote_cache/<hash>.mp4` | Reuso se `quote_text` + `animation_type` + estilo iguais |

---

## Hyperframes — especificação do cartão (sem código)

Composição HTML 1920×1080, 30 fps, **sem faixa de áudio** no ficheiro renderizado.

| Elemento | Estilo |
|----------|--------|
| Fundo | `#000000` sólido |
| Texto principal | `#FFFFFF`, família **Montserrat** (Google Fonts ou ficheiro local), peso 600–700, tamanho ~64–80px, centralizado verticalmente com margem |
| Atribuição | Mesma família, peso 400, ~28–36px, abaixo do principal, opacidade ~0.85 |
| Animação | `animation_type: typing` — revelar `quote_text` caractere a caractere (GSAP ou adapter CSS/WAAI compatível com seek do Hyperframes) |
| Duração | `max(duration_seconds_max, tempo_estimado_typing)`; montagem **corta ou estende** o MP4 ao comprimento do `scXX.mp3` |

**Sincronização com narração (montagem):**

1. Gerar `scXX.mp4` (typing completo dentro do clip).
2. Gerar `scXX.mp3` com `narration_text` (inclui aspas se o roteiro tiver — TTS pode strip leve conforme `stripMarkdownForSpeech`).
3. FFmpeg: `trim/setpts` do vídeo à duração do áudio da cena (mesmo padrão Ken Burns / clipes v2).
4. Cena seguinte: stock já planeado para o beat **após** a citação.

Se o áudio for **mais longo** que o typing visual, proposta MVP: **congelar** texto completo após typing terminar (hold no último frame) até o MP3 acabar — impacto mantido.

---

## Stock por bloco (Magnific + Pexels)

| Variável | Proposta Stoic Patrol |
|----------|----------------------|
| `GENTUBE_STOCK_RATIO_BLOCK1` | `100` |
| `GENTUBE_STOCK_RATIO_OTHER` | `100` |
| `GENTUBE_STOCK_PROVIDER` | `magnific_then_pexels` (Magnific primeiro; Pexels se rate limit/erro/sem 16:9) |
| `MAGNIFIC_API_KEY` | Obrigatório para tentativa primária |
| `PEXELS_API_KEY` | Obrigatório para fallback ([API Pexels](https://www.pexels.com/api/documentation/)) |
| `GENTUBE_MAX_IMAGES_BLOCK1` / `OTHER` | Ajustar por canal (ex. 30–40 imagens) |
| `GENTUBE_MAX_VIDEOS_BLOCK1` / `OTHER` | Incluir **quotes** no cap de vídeos + stock vídeo |

**Provedores:**

- **Magnific** (`api.magnific.com`): primário; filtro 16:9 em vídeo; imagens com validação/recorte FFmpeg.
- **Pexels** (`api.pexels.com`): fallback; `orientation=landscape`; limites default 200 req/h e 20k/mês — usar cache e retomar com `--enqueue-only` para não esgotar quota numa única corrida.
- **Keywords:** se a busca falhar, o integrador remove tokens do fim da query (ex. `handshake opportunity open door bright office professional success` → … → `handshake opportunity open door`) até obter asset ou esgotar provedores.

**Cache local:**

- Stock: `data/stock_cache/` — chave `sha256(type|keywords)`; hit evita Magnific **e** Pexels.
- Quote: `data/quote_cache/` — hash `quote_text + attribution + animation_type`.

**Atribuição Pexels:** na descrição/créditos do vídeo publicado (requisito da API); ver `ESPECIFICACAO_TECNICA.md` §20.6.1.

**Retomar renders:** `run-step --step imagens --scene-plan-v2 --enqueue-only` salta ficheiros já em `renders/blockNN/`.

---

## Prompts propostos (ficheiros novos)

Mesmo padrão Wojak: **base inalterada** + **addon** onde possível.

| Ficheiro | Base | Função |
|----------|------|--------|
| `Prompts/matriz_stoic_patrol.md` | Inspira `matriz.md` | Roteiro 8 blocos EN; regras de **como** escrever citações (versículo, filósofo, aspas); tom stoic/religious; sem perguntar “continuar?” no pipeline automatizado (adaptar para geração batch) |
| `Prompts/segmenta_stoic_patrol.md` | Addon → `segmenta01.md` | `quote_hint`, isolar citações em cenas |
| `Prompts/visualiza_stoic_patrol.md` | Addon → `visualiza01.md` | `quote_card` vs `stock`, campos quote, stock_ratio 100% |
| `Prompts/canal_voice_stoic_patrol.md` | Opcional | Voz do canal Stoic Patrol (bloco 1), injetado como `canal_voice.md` |

**Carregamento (implementação futura):**

```text
GENTUBE_VISUAL_MODALITY=stoic_patrol
  → roteiro: GENTUBE_PROMPT_MATRIX=matriz_stoic_patrol.md
  → segmentação: segmenta01.md + segmenta_stoic_patrol.md
  → visualização: visualiza01.md + visualiza_stoic_patrol.md
```

Override: `GENTUBE_PROMPT_VISUALIZA`, `GENTUBE_PROMPT_SEGMENTA` (nomes a definir no `config.ts`).

### Esboço — regras `visualiza_stoic_patrol.md` (conteúdo a redigir na implementação)

- `visual_modality: stoic_patrol`
- Proibido: `ai_generated`, `manual_capture`
- Se `quote_hint` ou deteção de citação explícita em `narration_text` → `source: quote_card`, preencher `quote_text` / `quote_attribution`, `animation_type: typing`
- Caso contrário → `source: stock`, `search_keywords` concretos (inglês), metáforas visuais alinhadas ao beat (templos, natureza, silhueta, livros antigos, etc.) — **sem** rosto de celebridade/IP (`ip_risk` alto → clip curto ou imagem)
- `role: quote` só em `quote_card`
- Priorizar `type: image` no stock para poupar cap de vídeo; reservar `type: video` stock para movimento essencial

### Esboço — regras `matriz_stoic_patrol.md`

- Nicho: stoicism, psychology, faith, meaning, discipline
- Instruir: sempre que usar citação **memorável**, usar aspas + atribuição numa linha própria
- Versículos: formato `Book Chapter:Verse` antes ou depois da frase
- Evitar blocos onde metade é paráfrase sem citação delimitada — dificulta `quote_card`

---

## Pipeline e CLI (implementação futura — só referência)

| Etapa | Comportamento stoic_patrol |
|-------|----------------------------|
| `roteiro` | `matriz_stoic_patrol.md` |
| `quality_gate` | Opcional (igual multiagent) |
| `imagens` | Plano v2; render stock + enqueue Hyperframes por cena `quote_card` |
| `image_sync` | Poll HF/Google (se aplicável); stock Magnific/Pexels é síncrono no enqueue |
| `narracao` | Por cena; cache TTS (P7) |
| `montagem` | Sync quote MP4 ↔ MP3; stock nas cenas adjacentes |

**Perfil sugerido:** `stoic-patrol-stock` (nome a definir) — `stock_ratio` 100, sem HF/Gemini.

**Não** incluir `video-use` no `run-pipeline`.

---

## Comparação rápida com Wojak

| | Wojak | Stoic Patrol |
|---|-------|----------------|
| Modalidade | `wojak` | `stoic_patrol` |
| Plano v2 | Sim | Sim |
| Fonte principal | `ai_generated` | `stock` |
| Fonte especial | — | `quote_card` |
| Render especial | Gemini + Veo | Hyperframes |
| Stock Magnific + Pexels | 0% | ~100% (entre quotes) |
| Limite quotes | — | Nenhum |
| video-use | Não | Não |

---

## Critérios de aceite (MVP documental → depois código)

1. Roteiro com citação explícita gera pelo menos uma cena `quote_card` no plano.
2. Cartão: fundo preto, texto branco Montserrat, typing, atribuição abaixo quando existir.
3. Montagem: durante o MP3 da cena quote, o vídeo mostra o texto; cena seguinte é stock.
4. Cenas não-citação usam stock Magnific → Pexels (ou cache local).
5. Modalidade opt-in; Wojak/default intactos.

---

## Checklist (aprovado 2026-05-25)

- [x] Modalidade: `stoic_patrol` (alias `religious` no env)
- [x] `source: quote_card`
- [x] `quote_hint` na segmentação
- [x] Sem limite de quotes; caps stock via `GENTUBE_MAX_*`
- [x] Prompts criados em `Prompts/`
- [x] Secção **18.12** em `ESPECIFICACAO_TECNICA.md`
- [x] Render quote cards → MP4 (`quote-card-render.ts`: Hyperframes ou FFmpeg ASS)
- [x] Cache local stock (`data/stock_cache/`) + quote (`data/quote_cache/`)
- [x] Perfil `run-pipeline` **`stoic-patrol-stock`**

---

## Uso rápido (.env)

```bash
GENTUBE_VISUAL_MODALITY=stoic_patrol
GENTUBE_SCENE_PLAN_V2=1
GENTUBE_STOCK_RATIO_BLOCK1=100
GENTUBE_STOCK_RATIO_OTHER=100
GENTUBE_STOCK_PROVIDER=magnific_then_pexels
MAGNIFIC_API_KEY=...
PEXELS_API_KEY=...
# Opcional: GENTUBE_PROMPT_MATRIX=matriz_stoic_patrol.md
```

```bash
npm run gentube -- run-step --project <slug> --step imagens --scene-plan-v2 --block 1
```

```bash
# So quotes (apos plano)
npm run gentube -- quote:render --project <slug> --block 1

# Pipeline completo Stoic Patrol
npm run gentube -- run-pipeline --project <slug> --profile stoic-patrol-stock --voice-id <id>
```

| Variável | Default | Função |
|----------|---------|--------|
| `GENTUBE_STOCK_PROVIDER` | `magnific` | Stoic Patrol: usar `magnific_then_pexels` |
| `GENTUBE_QUOTE_RENDER` | `auto` | `hyperframes` \| `ffmpeg` \| `auto` (HF se FFmpeg no PATH) |

---

*Atualizado: 2026-05-26 — stock: Magnific + fallback Pexels via `src/integrations/stock-download.ts` (`GENTUBE_STOCK_PROVIDER`, `PEXELS_API_KEY`).*

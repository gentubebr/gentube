# Modalidade visual Wojak — plano e rastreabilidade

Documento mestre da funcionalidade **Wojak** no GenTube. Estado da implementação: ver secção [Status](#status) no final.

**Relacionado:** [README.md](README.md) (uso e variáveis `.env`) · [ESPECIFICACAO_TECNICA.md](ESPECIFICACAO_TECNICA.md) (secção 18.10)

---

## Objetivo

Canal com avatar **Wojak** (line art preto/branco) em cenas `character_required: true`, com:

1. **Consistência de estilo** — referência visual obrigatória (PNG canónica) + prompt de cena contextual.
2. **Bootstrap-then-animate** — vídeo: imagem bootstrap sync (Gemini) → Veo com `scXX__bootstrap.png`.
3. **Style token canônico** — prefixo fixo no render (além do que o Claude escreve em `description`).

**Princípio de regressão:** modalidade **opt-in** (`GENTUBE_VISUAL_MODALITY=default` por defeito). Projetos e canais existentes não mudam até ativar env e regerar plano/renders.

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
  image  → renderSceneImage(prompt, referenceImagePath=wojak PNG)
  video  → bootstrap sync (prompt + wojak PNG) → Veo/HF (ref=bootstrap)
       ↓
montagem (inalterada; usa renders ou __bootstrap)
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

Regras no `visualiza_wojak.md`:

- Avatar na tela → `ai_generated`, `character_required: true`, `search_keywords: null`
- `description` em inglês com cena + ação (não só “wojak style”)
- Stock / `manual_capture` → `character_required: false`

---

## Ficheiros do código

| Ação | Ficheiro |
|------|----------|
| Criar | `Prompts/visualiza_wojak.md` |
| Criar | `src/utils/wojak-prompt.ts` |
| Criar | `src/assets/wojak/*.png` (×8) |
| Criar | `scripts/setup-wojak.sh` (opcional) |
| Alterar | `src/config.ts` — modalidade, paths, `resolveVisualizaPromptContent()` |
| Alterar | `src/types/scenes-plan.ts` — `WojakCharacterVariant`, `character_variant?` |
| Alterar | `src/utils/scenes-plan.ts` — validação opcional da variant |
| Alterar | `src/services/pipeline.ts` — prompt Claude + loop render v2 |
| Alterar | `.env.example`, `README.md`, `ESPECIFICACAO_TECNICA.md` |
| **Não alterar** | `segmenta01.md`, `visualiza01.md`, `image-generation.ts`, `video-generation.ts`, `montagem.ts` |

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

### Contrato `resolveWojakSceneVisualInput`

Entrada: `scene`, `visual`, `avatarRef?`, `modality`.

Saída:

```ts
{
  prompt: string;
  referenceImagePath?: string;
  forceVideoBootstrap: boolean;
}
```

Lógica:

- `modality !== "wojak"` ou `!character_required` → delegar ao fluxo atual (`promptForSceneVisual` + `avatarRef`).
- `modality === "wojak"` && `character_required` → token + description; ref = variant ou `avatarRef`; `forceVideoBootstrap = (type === "video")`.

---

## O que não é impactado

| Item | Motivo |
|------|--------|
| `segmenta01.md` | Sem campo visual |
| `visualiza01.md` | Só leitura em `default` |
| `blockNN.assets.json` em disco | Válidos sem `character_variant` |
| Renders / montagem existentes | Só mudam se reexecutar imagens |
| Stock / manual_capture | Sem Wojak |
| Canais sem `GENTUBE_VISUAL_MODALITY=wojak` | Ramo `default` idêntico ao atual |

---

## Testes manuais

1. **Regressão default** — sem env Wojak, `plan-only` → prompt `visualiza01` apenas.
2. **Plano Wojak** — `modality=wojak`, `plan-only` → `character_variant` + descriptions.
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

## Status

| Etapa | Estado |
|-------|--------|
| Documentação (`wojak.md`, README, ESPECIFICACAO) | Concluído (commit `478a363`) |
| Implementação código | Concluído |
| Assets PNG em `src/assets/wojak/` | Concluído (×8) |
| Testes manuais | Pendente |

*Última atualização: implementação modalidade Wojak (opt-in).*

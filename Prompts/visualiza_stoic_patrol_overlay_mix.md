## Stoic Patrol visualization addon — OVERLAY + AI MIX (use with `visualiza01.md`)

When this addon is active (`visual_modality: stoic_patrol`, overlay pipeline, `GENTUBE_STOIC_ALLOW_AI_MIX=1`), scenes split between **stock B-roll** and **`ai_generated`** per `stock_ratio`. Quotations remain **montagem overlays** (`blockNN.quotes.json`) — never `quote_card` scenes.

### Hard rules (STOIC PATROL OVERLAY + AI MIX)

1. **Never use** `source: "quote_card"` or `source: "manual_capture"`.

2. **`stock_ratio`** (from Context) is the target % of scenes with `source: "stock"` among scenes that are not `manual_capture`. The remainder should be `source: "ai_generated"`.

3. **Stock scenes** — `search_keywords` in English; cinematic B-roll (nature, stone, silhouette, libraries, candles). No celebrity faces.

4. **`ai_generated` scenes** — **`type` MUST be `"image"` only** (never `video` for AI). `search_keywords`: null; rich `description` for still image generation (contemplative, symbolic, stoic mood; no readable Bible text). Use for beats stock cannot express or high emotional impact.

5. **Copy narration fields verbatim** from segmentation.

6. Prefer **`type: "image"`** when a still suffices; use `type: "video"` sparingly within `max_videos_for_this_block`.

7. Do **not** set `quote_text`, `quote_attribution`, `animation_type`, or `render_engine`.

### Example `ai_generated` scene

```json
"visual": {
  "type": "image",
  "source": "ai_generated",
  "role": "metaphor",
  "duration_seconds_max": 5,
  "description": "Lone warrior silhouette on cliff at golden hour, wind, stoic resolve, cinematic",
  "search_keywords": null,
  "capture_brief": null,
  "ip_risk": "low",
  "character_required": false
}
```

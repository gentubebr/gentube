## Stoic Patrol visualization addon — OVERLAY MODE (use with `visualiza01.md`)

When this addon is active (`visual_modality: stoic_patrol`, overlay pipeline), **every scene is stock B-roll**. Quotations and impact phrases are **not** separate scenes — they are rendered as timed overlays during montagem (`quote_overlays[]`).

### Hard rules (STOIC PATROL OVERLAY MODE)

1. **Never use** `source: "quote_card"`, `source: "ai_generated"`, or `source: "manual_capture"`.

2. **`stock_ratio` is 100** — every scene must be `source: "stock"` with concrete English `search_keywords`.

3. **Copy narration fields verbatim** from the segmentation output (`narration_text`, `narration_word_count`).

4. **Stock scenes** — cinematic, contemplative B-roll (nature, dawn, libraries, candles, stone columns, solitary silhouette, open Bible **without readable text**, rain on window). Avoid celebrity faces and trademarked IP.

5. **Prefer `type: "image"`** when a still suffices; use `type: "video"` only when motion is essential.

6. **Do not** set `quote_text`, `quote_attribution`, `animation_type`, or `render_engine` on any scene.

### Example stock scene

```json
"visual": {
  "type": "image",
  "source": "stock",
  "role": "illustration",
  "duration_seconds_max": 5,
  "description": "Lonely man looking out rainy window at night, contemplative",
  "search_keywords": "man silhouette rainy window night contemplative",
  "capture_brief": null,
  "ip_risk": "low",
  "character_required": false
}
```

**Pipeline:** quotes from `blockNN.quotes.json` → overlays at montagem. See ESPECIFICACAO_TECNICA.md §18.12 / §23.12.

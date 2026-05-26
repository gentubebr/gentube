## Stoic Patrol visualization addon (use with `visualiza01.md`)

When this addon is active (`visual_modality: stoic_patrol`), the channel uses **stock** (Magnific, fallback Pexels at enqueue) for illustration and **Hyperframes quote cards** for explicit quotations. `search_keywords` stay in English for both providers.

### Hard rules (STOIC PATROL MODE)

1. **Never use** `source: "ai_generated"` or `source: "manual_capture"` unless the pipeline explicitly allows fallback (default: **forbidden**).

2. **`stock_ratio` is 100** among scenes that are **not** `quote_card` — every non-quote scene must be `source: "stock"` with concrete English `search_keywords`.

3. **`quote_card` scenes** — use when `quote_hint: true` on the scene **or** when `narration_text` contains an **explicit quotation** (text inside `"..."`, Scripture verse read aloud, philosopher line with attribution). **Every such beat gets its own `quote_card`** — do not leave a long Bible/philosopher quote on stock B-roll. Set:
   - `"source": "quote_card"`
   - `"type": "video"` (always — typing animation)
   - `"role": "quote"`
   - `"search_keywords": null`
   - `"quote_text"`: the words on screen (**without** outer `"` marks). **Max ~150 characters per card** — if the Scripture/quote is longer, split into **two consecutive `quote_card` scenes** (part A + part B) with the same `quote_attribution`. Never put 180+ characters in a single `quote_text`.
   - `"quote_attribution"`: optional string below the quote (e.g. `Marcus Aurelius`, `John 3:16`, `Seneca`) — omit or `null` if none
   - `"animation_type": "typing"`
   - `"render_engine": "hyperframes"`
   - `"description": "Quote card: black background, white Montserrat, typing animation"`
   - `"capture_brief": null`
   - `"ip_risk": "none"`
   - `"character_required": false`

4. **No limit** on how many `quote_card` scenes per block.

5. **Stock scenes** — cinematic, contemplative B-roll aligned with narration (nature, dawn, libraries, candles, stone columns, solitary figure silhouette, open Bible on table **without readable text**, ancient paths, rain on window). Avoid celebrity faces and trademarked IP (`ip_risk: high` → shorter clip cap per base rules).

6. **Prefer `type: "image"`** for stock when a still suffices; use `type: "video"` for stock only when motion is essential — remember `quote_card` counts toward **`max_videos_for_this_block`**.

7. **`quote_text` validation:** Must be a literal substring of `narration_text` (after removing outer `"` marks for display only).

### Stock ratio math

Treat `quote_card` like `manual_capture` in ratio math: **exclude** `quote_card` scenes from the stock_ratio denominator. All remaining scenes should be `stock`.

### Example quote_card scene

```json
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
```

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

---

**Montage:** narration MP3 for the quote scene plays while the typing card is shown; the next scene returns to stock.

**Pipeline:** see [stoic-patrol.md](../stoic-patrol.md).

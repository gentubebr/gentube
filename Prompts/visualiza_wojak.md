## Canal Wojak (addon — apply with base visualiza rules)

This channel uses a **Wojak** line-art avatar (bold black outlines, white fill, minimal gray shading) when the channel character must appear on screen.

### When the avatar is on screen

- Set `"source": "ai_generated"`, `"character_required": true`, `"search_keywords": null`.
- Set `"character_variant"` to one of: `neutral`, `happy`, `smiling`, `tired`, `doomer`, `frontal`, `impressed`, `pain`.
- Write `"description"` in **English** as a concrete scene prompt, e.g.  
  `Wojak character, tired expression, sitting at desk looking at laptop showing red chart, minimalist line art, bold black outlines, white background`
- Do **not** use stock for avatar shots (stock cannot supply this character).

### Variant guide

| variant | Use when narration suggests |
|---------|------------------------------|
| `neutral` | explaining, default beat |
| `happy` | relief, small win, calm positivity |
| `smiling` | open smile, celebration, joke landing |
| `tired` | exhaustion, late nights, burnout |
| `doomer` | cynicism, despair, hoodie/beanie mood |
| `frontal` | direct address to viewer |
| `impressed` | surprise, “wow”, discovery |
| `pain` | loss, mistake, frustration, “oof” |

### When the avatar is NOT on screen

- Stock, B-roll, metaphors without the face: `"character_required": false`, no `character_variant`.
- `manual_capture`: unchanged from base rules.

### negative_prompt (recommended for ai_generated avatar shots)

`photorealistic, 3d render, anime, cartoon color, detailed skin texture, cinematic lighting`

### Output schema addition

Inside each `visual` object with `character_required: true`, include:

```json
"character_variant": "neutral"
```

Plans without `character_variant` are still valid; the pipeline may infer from narration.

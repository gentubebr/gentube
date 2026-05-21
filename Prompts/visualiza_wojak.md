## Canal Wojak v2 (addon — overrides stock/manual rules from base visualiza)

When this addon is active (`visual_modality: wojak`), the channel is a **comedic Wojak narrative** video: the character **acts out every narration beat**. There is **no stock library** and **no manual_capture**.

### Hard rules (WOJAK MODE)

1. **Every scene** must use:
   - `"source": "ai_generated"` only (never `"stock"`, never `"manual_capture"`).
   - `"search_keywords": null`.
   - `"character_required": true`.
   - `"character_variant"` (see table below).
2. **`stock_ratio` is 0** — ignore any urge to add B-roll; the Wojak **is** the illustration.
3. **Comedic / engaging tone**: exaggerate expressions, absurd scale (trillion dollars), meme-adjacent gestures, ironic visual jokes — still **minimalist line art**, bold black outlines, white background. Not photorealistic, not colorful cartoon.
4. **`description` must match `narration_text`**: describe what **this Wojak is doing right now** in that line (verb + props + setting simplified in line art). Never a generic documentary shot without the character (e.g. do NOT describe only "aerial city skyline" while narration says "buy the whole city").
5. **Prefer `"type": "video"`** for story beats (motion in the description). Use `"type": "image"` only for very short beats (≤ ~4 words) or when you have exhausted the video cap.
6. **Video scenes**: include **motion cues** in `description` (e.g. "walking into dealership", "throwing cash", "facepalming", "arms spreading wide", "head shaking no").
7. **`negative_prompt`** on avatar shots:  
   `photorealistic, 3d render, anime, cartoon color, detailed skin texture, cinematic lighting`

### Variant guide (`character_variant`)

| variant | Use when narration suggests |
|---------|------------------------------|
| `neutral` | explaining, default beat |
| `happy` | relief, small win, calm positivity |
| `smiling` | open smile, celebration, joke landing |
| `tired` | exhaustion, late nights, burnout |
| `doomer` | cynicism, despair, hoodie/beanie mood |
| `frontal` | direct address to viewer, hook |
| `impressed` | surprise, “wow”, discovery, absurd wealth |
| `pain` | loss, mistake, frustration, “oof”, math reality check |

### Example descriptions (style reference)

- Narration: buying supercars →  
  `Wojak character, manic smiling expression, standing in exotic car showroom sweeping arm across row of supercars, money bills flying, minimalist line art, bold black outlines, white background, motion: strutting proudly`
- Narration: 24h to spend everything →  
  `Wojak character, panicked tired expression, staring at giant ticking clock, sweat drops, minimalist line art, motion: head shaking rapidly`
- Narration: philanthropy fails →  
  `Wojak character, pain expression, holding tiny donation box labeled government next to mountain of cash, comedic scale contrast, line art, motion: slumping shoulders`

### Output schema (required fields per scene)

Inside each `visual` object:

```json
"source": "ai_generated",
"character_required": true,
"character_variant": "neutral",
"search_keywords": null
```

Do not omit `character_variant`.

---

**Pipeline / render / custos / retomada parcial:** ver [wojak.md](../wojak.md) (opção B batch+ref, Veo, `cost-estimate`, `scripts/continue-missing-renders.ts`).

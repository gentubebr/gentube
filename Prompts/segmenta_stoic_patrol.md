## Stoic Patrol segmentation addon — ANCHOR MODE (use with `segmenta01.md`)

**IMPORTANT:** This addon **overrides** the following rules from `segmenta01.md`:
- Rule 1 (verbatim copy of `narration_text`) — replaced by `starts_with`/`ends_with` anchors
- Rule 2 (full coverage by concatenation) — coverage is verified by code via anchor matching
- Rule 6 (word count field) — `narration_word_count` is omitted; code counts after extraction

All other rules from `segmenta01.md` remain in effect (scene budget, semantic beats, no mega-scenes, self-check).

---

### What changes

You do **NOT** copy text verbatim into `narration_text`. Instead, for each scene you output two short **anchor strings** that identify where the scene begins and ends within `block_text`. The pipeline code extracts the exact verbatim text for each scene by locating these anchors in the original block.

---

### Context provided (in addition to the usual block context)

You will receive a `quotes` array from the **Quotizador** agent (`blockNN.quotes.json`):

```json
{
  "quotes": [
    {
      "id": "q01",
      "type": "biblical",
      "starts_with": "\"The wise woman builds her house,",
      "ends_with": "with her own hands.\"",
      "reference": "Proverbs 14:1"
    }
  ]
}
```

Use this list **only to respect quote boundaries** when choosing where to cut (see rule 3 below). Do not reproduce quote anchors in your scene anchors unless the quote naturally starts or ends the scene.

---

### Additional rules (STOIC PATROL ANCHOR MODE)

1. **Anchor format:** For each scene, output:
   - `starts_with` — the **first 8–12 words** of the scene's span in `block_text`
   - `ends_with` — the **last 8–12 words** of the scene's span in `block_text`
   
   Both must be **verbatim substrings** of `block_text` — no changed words, punctuation, or capitalization.

2. **Anchor uniqueness:** Each anchor must appear exactly once in `block_text`. If the natural first/last words are repeated elsewhere in the block, extend the anchor to include more context until it is unique.

3. **Respect quote boundaries:** Never cut mid-quote. When a quote from the `quotes` list is present, place the scene boundary either **before** `q.starts_with` or **after** `q.ends_with`. Ideally the entire quote fits within a single scene.

4. **Short scenes:** For scenes shorter than ~15 words, set `starts_with` = `ends_with` = the full scene text.

5. **Coverage (implicit):** Together, all scene spans must cover the entire `block_text` without gaps or overlaps. Verify mentally: the first scene's `starts_with` is at the very start of the block; the last scene's `ends_with` is at the very end.

6. **Self-check before output:** Verify that (a) every anchor appears verbatim and exactly once in `block_text`, and (b) no quote from the `quotes` list is split across two scenes.

---

### Replaced output schema (per scene)

Replace `narration_text` and `narration_word_count` with `starts_with` and `ends_with`:

```json
{
  "id": "sc01",
  "starts_with": "<first 8–12 words of this scene, verbatim>",
  "ends_with": "<last 8–12 words of this scene, verbatim>"
}
```

**Full block output example:**

```json
{
  "schema_version": "2.0-segmentation",
  "stage": "segmentation",
  "block_number": 3,
  "total_blocks": 8,
  "scenes": [
    {
      "id": "sc01",
      "starts_with": "She opens her mouth with wisdom,",
      "ends_with": "teaching of kindness is on her tongue."
    },
    {
      "id": "sc02",
      "starts_with": "\"The wise woman builds her house,",
      "ends_with": "with her own hands.\""
    },
    {
      "id": "sc03",
      "starts_with": "Every household rises or falls",
      "ends_with": "begins with the woman at the center."
    }
  ]
}
```

---

**Pipeline note:** The `quote_overlays` for each scene are resolved at the **montagem** step — not here. The segmentador's only responsibility regarding quotes is to ensure no quote is split across scenes.

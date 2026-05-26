## Stoic Patrol segmentation addon (use with `segmenta01.md`)

When this addon is active (`visual_modality: stoic_patrol`), you are segmenting for a channel that uses **stock footage** for most beats and **on-screen quote cards** for explicit quotations.

### Additional rules (STOIC PATROL MODE)

1. **Quote isolation:** If a passage in the block is an **explicit quotation** (text in `"..."`, Scripture reference + quoted line, `Marcus Aurelius said, "..."`, `as X wrote, "..."`, `Quote:` / `Remember this:` + memorable line), put **only that quoted unit** (plus minimal attribution words if they are in the same breath) in its own scene when possible — do not merge the quote with long narrator commentary in one `narration_text`.

2. **`quote_hint`:** Set `"quote_hint": true` on scenes whose `narration_text` is primarily a **deliverable quote** (Scripture line, philosopher quote, direct speech in quotes). Set `"quote_hint": false` or omit on normal narration beats.

3. **Verbatim still mandatory:** `narration_text` must remain exact substrings of the block; `quote_hint` does not allow paraphrase.

4. **Scene budget unchanged:** Still respect `max_scenes_for_this_block` and 8–25 words per scene when possible. **Long on-screen quotes (> ~150 characters):** split into **two consecutive scenes** at a natural pause (semicolon, comma, or breath); each scene gets `quote_hint: true` and only its fragment in `narration_text`.

5. **Self-check:** Every scene with `quote_hint: true` should contain quotation marks **or** a clear Scripture reference pattern (`Book Chapter:Verse`) with quoted content.

### Extended output schema (per scene)

Add optional field:

```json
{
  "id": "sc12",
  "narration_text": "\"The obstacle is the way.\"",
  "narration_word_count": 5,
  "quote_hint": true
}
```

If not a quote beat, omit `quote_hint` or set `false`.

---

**Pipeline:** see [stoic-patrol.md](../stoic-patrol.md).

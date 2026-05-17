// n8n Function node — Manual Capture Shot List Generator
// =========================================================
// INPUT: items from previous nodes. Each item.json should be one block's
//        visualization output (the JSON returned by visualiza.md), i.e.:
//        { schema_version, stage: "visualization", block_number, scenes: [...] }
//
// OUTPUT: a single item containing:
//        - markdown_recording_order : shot list ordered by block + scene
//        - markdown_batched         : shot list grouped by target (Binance, Coinbase…)
//        - csv                      : CSV ready to paste into Google Sheets
//        - scenes                   : raw filtered scene array
//        - total_captures           : count
//
// PLACE THIS NODE: after the loop that calls visualiza.md for every block,
//                  merging all outputs into this Function node.

const allScenes = [];

for (const item of $input.all()) {
  const data = item.json;
  const blockNumber = data.block_number;

  for (const scene of (data.scenes || [])) {
    const v = scene.visual;
    if (v && v.source === 'manual_capture' && v.capture_brief) {
      allScenes.push({
        block_number: blockNumber,
        scene_id: scene.id,
        narration_text: scene.narration_text,
        estimated_duration_seconds: scene.estimated_duration_seconds,
        method: v.capture_brief.method,
        target: v.capture_brief.target,
        actions: v.capture_brief.actions,
        highlights: v.capture_brief.highlights,
        duration_hint_seconds: v.capture_brief.duration_hint_seconds,
        ip_risk: v.ip_risk,
      });
    }
  }
}

// Sort by block + scene id (recording order)
allScenes.sort((a, b) => {
  if (a.block_number !== b.block_number) return a.block_number - b.block_number;
  return a.scene_id.localeCompare(b.scene_id);
});

// -------------------------------------------------
// View 1 — Markdown in recording order
// -------------------------------------------------
const mdLines = [];
mdLines.push(`# Shot List — Recording Order`);
mdLines.push('');
mdLines.push(`Total manual captures: **${allScenes.length}**`);
mdLines.push('');

let currentBlock = null;
for (const s of allScenes) {
  if (s.block_number !== currentBlock) {
    currentBlock = s.block_number;
    mdLines.push(`## Block ${currentBlock}`);
    mdLines.push('');
  }
  mdLines.push(`### ☐ ${s.scene_id} — ${s.target}`);
  mdLines.push('');
  mdLines.push(`**Method:** ${s.method}  `);
  mdLines.push(`**Raw duration:** ~${s.duration_hint_seconds}s · **Narration:** ~${s.estimated_duration_seconds}s  `);
  if (s.ip_risk === 'high') mdLines.push(`**⚠ IP risk: high** — trim clip to ≤5s in edit  `);
  mdLines.push('');
  mdLines.push(`> *Narration:* "${s.narration_text}"`);
  mdLines.push('');
  mdLines.push(`**Actions:** ${s.actions}`);
  mdLines.push('');
  mdLines.push(`**Highlights:** ${s.highlights}`);
  mdLines.push('');
  mdLines.push('---');
  mdLines.push('');
}

// -------------------------------------------------
// View 2 — Markdown batched by target (Binance, Coinbase…)
// -------------------------------------------------
const batched = {};
for (const s of allScenes) {
  if (!batched[s.target]) batched[s.target] = [];
  batched[s.target].push(s);
}
const batchedKeys = Object.keys(batched).sort();

const bmdLines = [];
bmdLines.push(`# Shot List — Batched by Target`);
bmdLines.push('');
bmdLines.push('Open each app/site once, record all its shots in a single session.');
bmdLines.push('');

for (const target of batchedKeys) {
  const shots = batched[target];
  bmdLines.push(`## ${target}  *(${shots.length} shot${shots.length > 1 ? 's' : ''})*`);
  bmdLines.push('');
  for (const s of shots) {
    bmdLines.push(`### ☐ Block ${s.block_number} / ${s.scene_id}`);
    bmdLines.push(`**Method:** ${s.method} · **Duration:** ~${s.duration_hint_seconds}s`);
    bmdLines.push('');
    bmdLines.push(`> *Narration:* "${s.narration_text}"`);
    bmdLines.push('');
    bmdLines.push(`**Actions:** ${s.actions}`);
    bmdLines.push('');
    bmdLines.push(`**Highlights:** ${s.highlights}`);
    bmdLines.push('');
    bmdLines.push('---');
    bmdLines.push('');
  }
}

// -------------------------------------------------
// CSV for Google Sheets (first column "done" for checkboxes)
// -------------------------------------------------
const csvEscape = (val) => {
  if (val == null) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const csvHeader = [
  'done', 'block', 'scene_id', 'method', 'target',
  'duration_s', 'narration', 'actions', 'highlights', 'ip_risk',
];
const csvRows = [csvHeader.join(',')];
for (const s of allScenes) {
  csvRows.push([
    '',
    s.block_number,
    s.scene_id,
    s.method,
    s.target,
    s.duration_hint_seconds,
    s.narration_text,
    s.actions,
    s.highlights,
    s.ip_risk,
  ].map(csvEscape).join(','));
}

return [{
  json: {
    total_captures: allScenes.length,
    markdown_recording_order: mdLines.join('\n'),
    markdown_batched: bmdLines.join('\n'),
    csv: csvRows.join('\n'),
    scenes: allScenes,
  },
}];

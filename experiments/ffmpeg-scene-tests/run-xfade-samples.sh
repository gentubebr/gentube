#!/usr/bin/env bash
# Amostras de transicao xfade (0.1s) entre dois clipes ja montados.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FFMPEG="${ROOT}/experiments/ffmpeg-bin/ffmpeg"
FFPROBE="${ROOT}/experiments/ffmpeg-bin/ffprobe"
SRC="${1:-${ROOT}/experiments/ffmpeg-scene-tests/output/20260518-182713}"
OUT="${ROOT}/experiments/ffmpeg-scene-tests/output/xfade-$(date +%Y%m%d-%H%M%S)"
DUR=0.1

A="${SRC}/4.1-sc02-image-plus-mp3.mp4"
B="${SRC}/4.2-sc01-loop-video-plus-mp3.mp4"
mkdir -p "$OUT"

if [[ ! -f "$A" || ! -f "$B" ]]; then
  echo "Clipes de origem nao encontrados. Rode run-tests.sh antes ou passe a pasta: $0 <output-dir>"
  exit 1
fi

DA=$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$A")
OFF=$(awk -v d="$DA" -v t="$DUR" 'BEGIN{printf "%.3f", d - t}')

# Transicoes recomendadas para YouTube / narrativa (subtis em 0.1s)
TRANSITIONS=(
  fade
  dissolve
  fadefast
  smoothleft
  smoothright
  fadeblack
  fadewhite
  wipeleft
  slideright
  radial
  distance
  hblur
)

REPORT="${OUT}/xfade-report.md"
{
  echo "# Xfade — duracao ${DUR}s"
  echo ""
  echo "- Clipes: \`4.1-sc02\` + \`4.2-sc01\`"
  echo "- offset: ${OFF}s (fim do clip A menos ${DUR}s)"
  echo "- Reverso: **descartado**"
  echo ""
  echo "## Catalogo FFmpeg (filtro xfade)"
  echo ""
  echo "Parametro \`transition=\`: fade (default), dissolve, fadefast, fadeslow, fadeblack, fadewhite, fadegrays,"
  echo "wipeleft/right/up/down, slideleft/right/up/down, smoothleft/right/up/down,"
  echo "circlecrop, circleopen, circleclose, radial, distance, pixelize, hblur,"
  echo "coverleft/right/up/down, revealleft/right/up/down, squeezeh/v, zoomin, diagtl/tr/bl/br, etc."
  echo ""
  echo "## Amostras geradas"
  echo ""
  echo "| Transicao | Ficheiro | Duracao |"
  echo "|-----------|----------|---------|"
} > "$REPORT"

for tr in "${TRANSITIONS[@]}"; do
  out="${OUT}/xfade-${DUR}s-${tr}.mp4"
  if ! "$FFMPEG" -hide_banner -loglevel error -y -i "$A" -i "$B" \
    -filter_complex "[0:v]fps=30,format=yuv420p,settb=AVTB[v0];[1:v]fps=30,format=yuv420p,settb=AVTB[v1];[v0][v1]xfade=transition=${tr}:duration=${DUR}:offset=${OFF}[v];[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0];[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1];[a0][a1]acrossfade=d=${DUR}:c1=tri:c2=tri[a]" \
    -map "[v]" -map "[a]" -c:v libx264 -preset fast -crf 23 -c:a aac "$out" 2>"${OUT}/.err-${tr}.log"; then
    echo "| ${tr} | ERRO | — |" >> "$REPORT"
    echo "  ERRO: $tr (ver .err-${tr}.log)" >&2
    continue
  fi
  dv=$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$out")
  echo "| ${tr} | \`xfade-${DUR}s-${tr}.mp4\` | ${dv}s |" >> "$REPORT"
  echo "  ok: $tr (${dv}s)"
done

{
  echo ""
  echo "## Sugestao para GenTube (0.1s)"
  echo ""
  echo "1. **fade** ou **dissolve** — mais neutros entre cenas de talking head / B-roll."
  echo "2. **fadefast** — corte quase seco com suavizacao minima (bom para ritmo alto)."
  echo "3. **smoothleft** / **smoothright** — leve movimento horizontal; usar com moderacao."
  echo "4. Evitar em 0.1s: **pixelize**, **circlecrop**, **zoomin** (parecem glitch em transicao curta)."
  echo "5. Audio: \`acrossfade=d=0.1\` alinhado ao video; evita 'click' entre MP3s por cena."
} >> "$REPORT"

echo ""
echo "Relatorio: $REPORT"
echo "Videos: $OUT"

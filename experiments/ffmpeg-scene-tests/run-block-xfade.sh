#!/usr/bin/env bash
# Monta bloco curto (3 cenas) com xfade 0.1s entre cada par.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FFMPEG="${ROOT}/experiments/ffmpeg-bin/ffmpeg"
FFPROBE="${ROOT}/experiments/ffmpeg-bin/ffprobe"
SRC="${1:-${ROOT}/experiments/ffmpeg-scene-tests/output/20260518-182713}"
TRANSITION="${2:-fade}"
DUR=0.1
OUT="${ROOT}/experiments/ffmpeg-scene-tests/output/block-xfade-${TRANSITION}-$(date +%Y%m%d-%H%M%S)"

mkdir -p "$OUT"
C1="${SRC}/4.1-sc02-image-plus-mp3.mp4"
C2="${SRC}/4.2-sc01-loop-video-plus-mp3.mp4"
C3="${SRC}/4.3a-sc03-trim-video-to-mp3.mp4"
FINAL="${OUT}/block3-${TRANSITION}-${DUR}s.mp4"

xfade_two() {
  local a="$1" b="$2" out="$3"
  local da
  da=$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$a")
  local off
  off=$(awk -v d="$da" -v t="$DUR" 'BEGIN{printf "%.3f", d - t}')
  "$FFMPEG" -hide_banner -loglevel error -y -i "$a" -i "$b" \
    -filter_complex "[0:v]fps=30,format=yuv420p,settb=AVTB[v0];[1:v]fps=30,format=yuv420p,settb=AVTB[v1];[v0][v1]xfade=transition=${TRANSITION}:duration=${DUR}:offset=${off}[v];[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0];[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1];[a0][a1]acrossfade=d=${DUR}:c1=tri:c2=tri[a]" \
    -map "[v]" -map "[a]" -c:v libx264 -preset fast -crf 23 -c:a aac "$out"
}

TMP1="${OUT}/.pair01.mp4"
TMP2="${OUT}/.pair012.mp4"
xfade_two "$C1" "$C2" "$TMP1"
xfade_two "$TMP1" "$C3" "$FINAL"
rm -f "$TMP1"

dv=$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$FINAL")
echo "Bloco 3 cenas | transition=${TRANSITION} | duration=${DUR}s | total=${dv}s"
echo "Saida: $FINAL"

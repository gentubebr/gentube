#!/usr/bin/env bash
# Testes isolados de montagem por cena (FFmpeg) — nao altera o GenTube principal.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FFMPEG="${ROOT}/experiments/ffmpeg-bin/ffmpeg"
FFPROBE="${ROOT}/experiments/ffmpeg-bin/ffprobe"
PROJECT="${ROOT}/Videos/Late-Bloomer-Lou/20260518-How-to-Invest-as-a-Teen-With-dollar0"
NAR="${PROJECT}/02 - Narracao/block01"
REN="${PROJECT}/03 - Imagens e Videos/renders/block01"
OUT="$(cd "$(dirname "$0")" && pwd)/output/$(date +%Y%m%d-%H%M%S)"
REPORT="${OUT}/report.md"

mkdir -p "$OUT"

duration() {
  "$FFPROBE" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$1" 2>/dev/null || echo "0"
}

log() { echo "$*" | tee -a "$REPORT"; }

log "# Testes FFmpeg — montagem por cena"
log ""
log "- Data: $(date -Iseconds)"
log "- Projeto: Late-Bloomer-Lou / block01"
log "- Saida: \`${OUT}\`"
log ""

# --- 4.1 imagem + mp3 longo ---
SC41_IMG="${REN}/sc02.png"
SC41_MP3="${NAR}/sc02.mp3"
SC41_OUT="${OUT}/4.1-sc02-image-plus-mp3.mp4"
TA41=$(duration "$SC41_MP3")
log "## 4.1 — MP3 longo + imagem (sc02)"
log "- Audio: \`sc02.mp3\` (${TA41}s)"
log "- Visual: \`sc02.png\`"
"$FFMPEG" -hide_banner -loglevel warning -y \
  -loop 1 -i "$SC41_IMG" -i "$SC41_MP3" \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p" \
  -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -shortest \
  "$SC41_OUT"
DV41=$(duration "$SC41_OUT")
log "- Saida: \`$(basename "$SC41_OUT")\` — duracao ${DV41}s (esperado ~${TA41}s)"
log ""

# --- 4.1 Ken Burns (zoom lento em imagem estatica) ---
FPS=30
FRAMES41=$(awk -v t="$TA41" -v f="$FPS" 'BEGIN{printf "%d", int(t*f+0.5)}')
SC41_KB_IN="${OUT}/4.1-sc02-kenburns-zoom-in.mp4"
SC41_KB_OUT="${OUT}/4.1-sc02-kenburns-zoom-out.mp4"
log "## 4.1b — Mesma cena com Ken Burns (zoom lento)"
log "- \`zoom-in\`: 100% → ~112% no centro | \`zoom-out\`: ~112% → 100%"
"$FFMPEG" -hide_banner -loglevel warning -y -loop 1 -i "$SC41_IMG" -i "$SC41_MP3" \
  -vf "scale=8000:-1,zoompan=z='min(zoom+0.0004,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${FRAMES41}:s=1920x1080:fps=${FPS},format=yuv420p" \
  -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -shortest "$SC41_KB_IN"
"$FFMPEG" -hide_banner -loglevel warning -y -loop 1 -i "$SC41_IMG" -i "$SC41_MP3" \
  -vf "scale=8000:-1,zoompan=z='if(lte(zoom,1.0),1.12,max(1.001,zoom-0.0004))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${FRAMES41}:s=1920x1080:fps=${FPS},format=yuv420p" \
  -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -shortest "$SC41_KB_OUT"
log "- Saida zoom-in: \`$(basename "$SC41_KB_IN")\` — $(duration "$SC41_KB_IN")s"
log "- Saida zoom-out: \`$(basename "$SC41_KB_OUT")\` — $(duration "$SC41_KB_OUT")s"
log ""

# --- 4.2 video curto + mp3 longo (loop) ---
SC42_VID="${REN}/sc01.mov"
SC42_MP3="${NAR}/sc01.mp3"
SC42_OUT="${OUT}/4.2-sc01-loop-video-plus-mp3.mp4"
TA42=$(duration "$SC42_MP3")
TV42=$(duration "$SC42_VID")
log "## 4.2 — MP3 longo + video curto (sc01, loop sem audio do stock)"
log "- Audio: \`sc01.mp3\` (${TA42}s)"
log "- Visual: \`sc01.mov\` (${TV42}s) — ratio audio/video = $(awk "BEGIN{printf \"%.2f\", $TA42/$TV42}")"
"$FFMPEG" -hide_banner -loglevel warning -y \
  -stream_loop -1 -i "$SC42_VID" -i "$SC42_MP3" \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p" \
  -map 0:v:0 -map 1:a:0 \
  -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -shortest \
  "$SC42_OUT"
DV42=$(duration "$SC42_OUT")
log "- Saida: \`$(basename "$SC42_OUT")\` — duracao ${DV42}s"
log ""

# --- 4.3a trim ---
SC43_VID="${REN}/sc03.mp4"
SC43_MP3="${NAR}/sc03.mp3"
SC43_TRIM="${OUT}/4.3a-sc03-trim-video-to-mp3.mp4"
TA43=$(duration "$SC43_MP3")
TV43=$(duration "$SC43_VID")
RATIO43=$(awk "BEGIN{printf \"%.3f\", $TV43/$TA43}")
log "## 4.3 — MP3 curto + video longo (sc03)"
log "- Audio: \`sc03.mp3\` (${TA43}s)"
log "- Visual: \`sc03.mp4\` (${TV43}s) — ratio video/audio = ${RATIO43}"
log ""
log "### 4.3a — Cortar video (-t audio)"
"$FFMPEG" -hide_banner -loglevel warning -y \
  -i "$SC43_VID" -i "$SC43_MP3" \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p" \
  -map 0:v:0 -map 1:a:0 -t "$TA43" \
  -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k \
  "$SC43_TRIM"
DV43a=$(duration "$SC43_TRIM")
log "- Saida: \`$(basename "$SC43_TRIM")\` — ${DV43a}s"
log ""

# --- 4.3b speed ---
SC43_SPEED="${OUT}/4.3b-sc03-speed-video-to-mp3.mp4"
SPEED=$(awk "BEGIN{printf \"%.6f\", $TV43/$TA43}")
log "### 4.3b — Acelerar video (setpts=PTS/${SPEED})"
"$FFMPEG" -hide_banner -loglevel warning -y \
  -i "$SC43_VID" -i "$SC43_MP3" \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setpts=PTS/${SPEED},format=yuv420p" \
  -map 0:v:0 -map 1:a:0 \
  -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -shortest \
  "$SC43_SPEED"
DV43b=$(duration "$SC43_SPEED")
log "- Saida: \`$(basename "$SC43_SPEED")\` — ${DV43b}s (speed ${SPEED}x)"
log ""

# --- Bootstrap fallback (sem .mov — so imagem bootstrap) ---
SC_BOOT_IMG="${REN}/sc01__bootstrap.png"
SC_BOOT_MP3="${NAR}/sc01.mp3"
SC_BOOT_OUT="${OUT}/2-bootstrap-sc01-fallback.mp4"
log "## 2 — Fallback bootstrap (sc01__bootstrap.png + sc01.mp3)"
log "- Simula video ausente: usa apenas bootstrap PNG"
"$FFMPEG" -hide_banner -loglevel warning -y \
  -loop 1 -i "$SC_BOOT_IMG" -i "$SC_BOOT_MP3" \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p" \
  -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -shortest \
  "$SC_BOOT_OUT"
DVBOOT=$(duration "$SC_BOOT_OUT")
log "- Saida: \`$(basename "$SC_BOOT_OUT")\` — ${DVBOOT}s"
log ""

# --- Bloco 3 cenas com xfade 0.1s (Ken Burns na imagem) ---
XFADE_DUR=0.1
xfade_pair() {
  local a="$1" b="$2" dest="$3"
  local da off
  da=$(duration "$a")
  off=$(awk -v d="$da" -v t="$XFADE_DUR" 'BEGIN{printf "%.3f", d - t}')
  "$FFMPEG" -hide_banner -loglevel error -y -i "$a" -i "$b" \
    -filter_complex "[0:v]fps=30,format=yuv420p,settb=AVTB[v0];[1:v]fps=30,format=yuv420p,settb=AVTB[v1];[v0][v1]xfade=transition=fade:duration=${XFADE_DUR}:offset=${off}[v];[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0];[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1];[a0][a1]acrossfade=d=${XFADE_DUR}:c1=tri:c2=tri[a]" \
    -map "[v]" -map "[a]" -c:v libx264 -preset fast -crf 23 -c:a aac "$dest"
}
BLOCK_KB="${OUT}/bloco3-kenburns-zoom-in-xfade-0.1s.mp4"
TMP_X1="${OUT}/.xfade-pair01.mp4"
xfade_pair "$SC41_KB_IN" "$SC42_OUT" "$TMP_X1"
xfade_pair "$TMP_X1" "$SC43_TRIM" "$BLOCK_KB"
rm -f "$TMP_X1"
log "## Bloco demo — 3 cenas (Ken Burns in + loop + trim) com xfade ${XFADE_DUR}s"
log "- Saida: \`$(basename "$BLOCK_KB")\` — $(duration "$BLOCK_KB")s"
log ""

# --- Concat 3 clipes (estatico, sem xfade) ---
SC_CONCAT="${OUT}/concat-3-scenes.mp4"
LIST="${OUT}/concat-list.txt"
printf "file '%s'\n" "$SC41_OUT" "$SC42_OUT" "$SC43_TRIM" > "$LIST"
log "## Extra — Concat simples (imagem estatica + 4.2 + 4.3a)"
"$FFMPEG" -hide_banner -loglevel warning -y -f concat -safe 0 -i "$LIST" -c copy "$SC_CONCAT" 2>/dev/null || \
"$FFMPEG" -hide_banner -loglevel warning -y -f concat -safe 0 -i "$LIST" \
  -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k "$SC_CONCAT"
DVCON=$(duration "$SC_CONCAT")
log "- Saida: \`$(basename "$SC_CONCAT")\` — ${DVCON}s (~$(awk "BEGIN{print $DV41+$DV42+$DV43a}")s esperado)"
log ""
log "## Resumo"
log "| Teste | Cena | Estrategia | Duracao saida |"
log "|-------|------|------------|---------------|"
log "| 4.1 | sc02 | imagem estatica | ${DV41}s |"
log "| 4.1b in | sc02 | Ken Burns zoom-in | $(duration "$SC41_KB_IN")s |"
log "| 4.1b out | sc02 | Ken Burns zoom-out | $(duration "$SC41_KB_OUT")s |"
log "| bloco3 | 3 cenas | Ken Burns + xfade 0.1s | $(duration "$BLOCK_KB")s |"
log "| 4.2 | sc01 | loop video | ${DV42}s |"
log "| 4.3a | sc03 | trim | ${DV43a}s |"
log "| 4.3b | sc03 | speed ${SPEED}x | ${DV43b}s |"
log "| bootstrap | sc01 | png fallback | ${DVBOOT}s |"
log "| concat | 3 cenas | copy/reencode | ${DVCON}s |"

# --- Guia de avaliacao ---
GUIDE="${OUT}/PARA-AVALIAR.md"
{
  echo "# Pacote para avaliacao visual"
  echo ""
  echo "Abra os MP4 nesta pasta no player. Compare principalmente a **cena sc02 (imagem)**."
  echo ""
  echo "## 1. Imagem estatica vs Ken Burns (mesmo audio sc02)"
  echo ""
  echo "| Ficheiro | O que avaliar |"
  echo "|----------|----------------|"
  echo "| \`4.1-sc02-image-plus-mp3.mp4\` | Baseline: PNG parado |"
  echo "| \`4.1-sc02-kenburns-zoom-in.mp4\` | **PADRAO APROVADO** — Ken Burns zoom-in |"
  echo "| \`4.1-sc02-kenburns-zoom-out.mp4\` | Zoom lento para fora |"
  echo ""
  echo "## 2. Estrategias de video (outras cenas)"
  echo ""
  echo "| Ficheiro | Estrategia |"
  echo "|----------|------------|"
  echo "| \`4.2-sc01-loop-video-plus-mp3.mp4\` | Video curto em loop + narracao |"
  echo "| \`4.3a-sc03-trim-video-to-mp3.mp4\` | Cortar video longo |"
  echo "| \`4.3b-sc03-speed-video-to-mp3.mp4\` | Acelerar video (alternativa) |"
  echo "| \`2-bootstrap-sc01-fallback.mp4\` | So PNG bootstrap (sem .mov) |"
  echo ""
  echo "## 3. Montagem de bloco"
  echo ""
  echo "| Ficheiro | O que e |"
  echo "|----------|---------|"
  echo "| \`concat-3-scenes.mp4\` | 3 cenas coladas (imagem **estatica**) |"
  echo "| \`bloco3-kenburns-zoom-in-xfade-0.1s.mp4\` | **PADRAO APROVADO** — bloco com Ken Burns + xfade 0.1s (fade) |"
  echo ""
  echo "## 4. Transicoes (pasta separada)"
  echo ""
  echo "Compare transicoes 0.1s entre dois clipes:"
  echo "\`../xfade-20260518-183310/\` (fade, dissolve, fadefast, wipeleft, ...)"
  echo ""
  echo "**Descartado:** reverso (nao usar)."
  echo ""
  echo "Detalhes tecnicos: \`report.md\`"
} > "$GUIDE"

echo ""
echo "=== PARA AVALIAR ==="
echo "Guia:   $GUIDE"
echo "Pasta:  $OUT"
echo ""
echo "Compare primeiro:"
echo "  $OUT/4.1-sc02-image-plus-mp3.mp4"
echo "  $OUT/4.1-sc02-kenburns-zoom-in.mp4"
echo "  $OUT/bloco3-kenburns-zoom-in-xfade-0.1s.mp4"

# Testes de montagem por cena (FFmpeg)

Experimentos **fora** do CLI GenTube. Nao altera `src/`.

## Requisitos

- Binarios em `experiments/ffmpeg-bin/` (ffmpeg 7 static). Se faltar:

```bash
# ver run-tests.sh — download automatico na primeira execucao do script pai
```

## Executar

```bash
./experiments/ffmpeg-scene-tests/run-tests.sh
./experiments/ffmpeg-scene-tests/run-xfade-samples.sh   # 12 transicoes xfade 0.1s
./experiments/ffmpeg-scene-tests/run-block-xfade.sh "" fade   # bloco 3 cenas
```

Saida em `output/<timestamp>/` + `report.md`.

**Xfade:** duracao padrao **0.1s**. Reverso descartado. Ver `xfade-report.md` na pasta `output/xfade-*`.

## Defaults aprovados (spec sec. 23)

| Item | Valor |
|------|--------|
| Imagem estatica / bootstrap | **Ken Burns zoom-in** (~100% → 112%) |
| Bloco | Clipes por cena + **xfade 0.1s** tipo **fade** |
| Referencia visual | `output/20260518-183855/bloco3-kenburns-zoom-in-xfade-0.1s.mp4` |
| Descartado | Reverso; imagem parada como padrao; zoom-out |

## Cenas usadas (block01 Late-Bloomer-Lou)

| Teste | Ficheiros | Estrategia |
|-------|-----------|------------|
| 4.1 | sc02.png + sc02.mp3 | imagem em loop ate fim do audio |
| 4.2 | sc01.mov + sc01.mp3 | loop video (sem audio stock) |
| 4.3a | sc03.mp4 + sc03.mp3 | cortar video ao tempo do mp3 |
| 4.3b | sc03.mp4 + sc03.mp3 | acelerar ~1.57x |
| bootstrap | sc01__bootstrap.png + sc01.mp3 | fallback sem .mov |

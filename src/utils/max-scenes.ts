import {
  DEFAULT_MAX_IMAGES_BLOCK1,
  DEFAULT_MAX_IMAGES_OTHER_BLOCKS,
  DEFAULT_MAX_VIDEOS_BLOCK1,
  DEFAULT_MAX_VIDEOS_OTHER_BLOCKS,
  MAX_SCENES_CAP,
  MAX_SCENES_DYNAMIC_ENABLED,
  MAX_SCENES_WORDS_DIVISOR,
} from "../config.js";
import type { Step3Limits } from "../types/step3-limits.js";
import { wordCountForCoverage } from "./text-coverage.js";

export type ResolvedSceneCaps = {
  maxScenes: number;
  maxVideos: number;
  maxImages: number;
  wordCount: number;
  dynamic: boolean;
};

function limitsForBlock(blockNumber: number, limits?: Step3Limits): {
  maxVideos: number;
  maxImages: number;
} {
  if (blockNumber === 1) {
    return {
      maxVideos: limits?.maxVideosBlock1 ?? DEFAULT_MAX_VIDEOS_BLOCK1,
      maxImages: limits?.maxImagesBlock1 ?? DEFAULT_MAX_IMAGES_BLOCK1,
    };
  }
  return {
    maxVideos: limits?.maxVideosOtherBlocks ?? DEFAULT_MAX_VIDEOS_OTHER_BLOCKS,
    maxImages: limits?.maxImagesOtherBlocks ?? DEFAULT_MAX_IMAGES_OTHER_BLOCKS,
  };
}

/** Calcula max_scenes por bloco: formula dinamica ou soma caps legada. */
export function resolveSceneCapsForBlock(
  blockText: string,
  blockNumber: number,
  limits?: Step3Limits,
): ResolvedSceneCaps {
  const { maxVideos, maxImages } = limitsForBlock(blockNumber, limits);
  const wordCount = wordCountForCoverage(blockText);
  const legacyCap = maxVideos + maxImages;

  if (!MAX_SCENES_DYNAMIC_ENABLED) {
    return {
      maxScenes: legacyCap,
      maxVideos,
      maxImages,
      wordCount,
      dynamic: false,
    };
  }

  const fromWords = Math.ceil(wordCount / MAX_SCENES_WORDS_DIVISOR);
  // Margem para citacoes longas / versiculos (segmentacao costuma exceder 1-4 cenas)
  const slack = Math.min(6, Math.ceil(wordCount / 300));
  const maxScenes = Math.min(MAX_SCENES_CAP, Math.max(fromWords + slack, legacyCap));

  const effectiveMaxImages = Math.max(maxImages, maxScenes - maxVideos);

  return {
    maxScenes,
    maxVideos,
    maxImages: effectiveMaxImages,
    wordCount,
    dynamic: true,
  };
}

/** Limiar para dividir visualizacao em dois pedidos Claude (evita truncar JSON). */
export function visualizationShouldSplit(sceneCount: number): boolean {
  const threshold = Math.max(
    40,
    parseInt(process.env.GENTUBE_VIZ_SPLIT_SCENE_THRESHOLD ?? "70", 10) || 70,
  );
  return sceneCount > threshold;
}

export function splitScenesForVisualization<T extends { id: string }>(
  scenes: T[],
): [T[], T[]] {
  const mid = Math.ceil(scenes.length / 2);
  return [scenes.slice(0, mid), scenes.slice(mid)];
}

/** Limites de parse/enforce alinhados ao max_scenes dinamico (evita 105 imagens vs cap 40). */
export function step3LimitsFromSceneCaps(
  blockNumber: number,
  caps: ResolvedSceneCaps,
  limits?: Step3Limits,
): Step3Limits | undefined {
  if (!limits) return undefined;
  if (blockNumber === 1) {
    return {
      ...limits,
      maxVideosBlock1: caps.maxVideos,
      maxImagesBlock1: caps.maxImages,
    };
  }
  return {
    ...limits,
    maxVideosOtherBlocks: caps.maxVideos,
    maxImagesOtherBlocks: caps.maxImages,
  };
}

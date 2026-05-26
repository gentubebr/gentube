import fs from "node:fs/promises";
import path from "node:path";
import type { MontagemConfig } from "../config/montagem.js";
import type { ScenePlanV2, SceneVisualPlanV2 } from "../types/scenes-plan.js";
import { narrationSceneMp3, rendersBlockDir } from "./montagem-paths.js";

export type SceneReadiness =
  | { ok: true; mp3Path: string; visualPath: string; isImage: boolean; holdLastFrame?: boolean }
  | { ok: false; sceneId: string; reason: string };

async function fileSize(path: string): Promise<number> {
  try {
    const st = await fs.stat(path);
    return st.size;
  } catch {
    return 0;
  }
}

async function firstExisting(basePaths: string[]): Promise<string | null> {
  for (const p of basePaths) {
    try {
      await fs.access(p);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

export async function resolveSceneVisualPath(
  rendersDir: string,
  sceneId: string,
  visual: SceneVisualPlanV2,
  cfg: MontagemConfig,
): Promise<{ path: string; isImage: boolean } | null> {
  const vidPaths = cfg.videoExts.map((ext) => path.join(rendersDir, `${sceneId}.${ext}`));
  const imgPaths = cfg.imageExts.map((ext) => path.join(rendersDir, `${sceneId}.${ext}`));
  const bootstrapPaths = [
    path.join(rendersDir, `${sceneId}__bootstrap.png`),
    path.join(rendersDir, `${sceneId}__bootstrap.jpg`),
  ];

  if (visual.type === "image" || visual.source === "manual_capture") {
    const found = await firstExisting(imgPaths);
    if (found) return { path: found, isImage: true };
    return null;
  }

  const video = await firstExisting(vidPaths);
  if (video) return { path: video, isImage: false };

  const boot = await firstExisting(bootstrapPaths);
  if (boot) return { path: boot, isImage: true };

  return null;
}

export async function checkSceneReady(
  projectPath: string,
  blockNumber: number,
  scene: ScenePlanV2,
  cfg: MontagemConfig,
): Promise<SceneReadiness> {
  const mp3Path = narrationSceneMp3(projectPath, blockNumber, scene.id);
  const size = await fileSize(mp3Path);
  if (size < cfg.minMp3Bytes) {
    return { ok: false, sceneId: scene.id, reason: `mp3 ausente ou < ${cfg.minMp3Bytes} bytes` };
  }

  const rendersDir = rendersBlockDir(projectPath, blockNumber);
  const visual = await resolveSceneVisualPath(rendersDir, scene.id, scene.visual, cfg);
  if (!visual) {
    return {
      ok: false,
      sceneId: scene.id,
      reason: `visual ausente (tipo ${scene.visual.type}, source ${scene.visual.source})`,
    };
  }

  return {
    ok: true,
    mp3Path,
    visualPath: visual.path,
    isImage: visual.isImage,
    holdLastFrame: scene.visual.source === "quote_card",
  };
}

export type SceneSegment = {
  sceneIds: string[];
  clipPaths: string[];
};

/** Agrupa cenas consecutivas completas; buracos quebram segmento. */
export function buildSegments(
  scenes: ScenePlanV2[],
  readyById: Map<string, { clipPath: string }>,
): SceneSegment[] {
  const segments: SceneSegment[] = [];
  let currentIds: string[] = [];
  let currentClips: string[] = [];

  const flush = () => {
    if (currentIds.length > 0) {
      segments.push({ sceneIds: [...currentIds], clipPaths: [...currentClips] });
      currentIds = [];
      currentClips = [];
    }
  };

  for (const scene of scenes) {
    const r = readyById.get(scene.id);
    if (r) {
      currentIds.push(scene.id);
      currentClips.push(r.clipPath);
    } else {
      flush();
    }
  }
  flush();
  return segments;
}

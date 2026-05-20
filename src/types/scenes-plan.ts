import type { IpRisk } from "./assets-plan.js";
import type { WojakCharacterVariant } from "../config.js";

export type VisualSourceV2 = "ai_generated" | "stock" | "manual_capture";

export type CaptureBrief = {
  method: string;
  target: string;
  actions: string;
  highlights: string;
  duration_hint_seconds?: number;
};

export type SceneVisualPlanV2 = {
  type: "image" | "video";
  source: VisualSourceV2;
  role: string;
  duration_seconds_max: number;
  description: string;
  search_keywords?: string | null;
  negative_prompt?: string;
  capture_brief?: CaptureBrief | null;
  ip_risk: IpRisk;
  character_required?: boolean;
  /** Modo Wojak: expressao da referencia PNG (opcional; pipeline infere se ausente). */
  character_variant?: WojakCharacterVariant;
};

export type ScenePlanV2 = {
  id: string;
  narration_text: string;
  narration_word_count: number;
  estimated_duration_seconds: number;
  visual: SceneVisualPlanV2;
};

/** Plano final persistido em blockXX.assets.json */
export type BlockScenesPlanV2 = {
  schema_version: "2.0";
  block_number: number;
  total_blocks: number;
  scenes: ScenePlanV2[];
};

/** Saida intermedia da segmentacao (antes de visualiza). */
export type SegmentationPlanV2 = {
  schema_version: "2.0-segmentation";
  stage: "segmentation";
  block_number: number;
  total_blocks: number;
  scenes: Array<{
    id: string;
    narration_text: string;
    narration_word_count: number;
  }>;
};

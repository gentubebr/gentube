import { resolveVisualModality } from "../config.js";
import type { BlockScenesPlanV2 } from "../types/scenes-plan.js";
import {
  stoicAllowAiMixEnabled,
  stoicOverlayModeEnabled,
  stoicPatrolAiImagesOnly,
} from "./stoic-overlay-mode.js";

export function isStoicPatrolModality(): boolean {
  return resolveVisualModality() === "stoic_patrol";
}

export function validateStoicPatrolBlockPlan(plan: BlockScenesPlanV2): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const overlayMode = stoicOverlayModeEnabled() && !plan.scenes.some((s) => s.visual.source === "quote_card");
  const overlayAiMix = overlayMode && stoicAllowAiMixEnabled();

  for (const scene of plan.scenes) {
    const v = scene.visual;
    const id = scene.id;

    if (v.source === "manual_capture") {
      errors.push(`${id}: source "${v.source}" proibido em stoic_patrol`);
    }

    if (overlayAiMix) {
      if (v.source === "quote_card") {
        errors.push(`${id}: quote_card proibido em stoic_patrol overlay mode (use quote_overlays na montagem)`);
      }
      if (v.source === "ai_generated") {
        if (stoicPatrolAiImagesOnly() && v.type !== "image") {
          errors.push(`${id}: ai_generated em stoic_patrol exige type "image" (sem video IA)`);
        }
        if (v.search_keywords?.trim()) {
          warnings.push(`${id}: ai_generated deve ter search_keywords null`);
        }
        if (!v.description?.trim()) {
          errors.push(`${id}: description obrigatorio para ai_generated`);
        }
      }
      if (v.source === "stock" && !v.search_keywords?.trim()) {
        errors.push(`${id}: search_keywords obrigatorio para stock`);
      }
      continue;
    }

    if (v.source === "ai_generated" || v.source === "manual_capture") {
      errors.push(`${id}: source "${v.source}" proibido em stoic_patrol`);
    }

    if (overlayMode) {
      if (v.source === "quote_card") {
        errors.push(`${id}: quote_card proibido em stoic_patrol overlay mode (use quote_overlays na montagem)`);
      }
      if (v.source === "stock" && !v.search_keywords?.trim()) {
        errors.push(`${id}: search_keywords obrigatorio para stock`);
      }
      continue;
    }

    if (v.source === "quote_card") {
      if (v.type !== "video") errors.push(`${id}: quote_card exige type video`);
      const quoteText = v.quote_text?.trim() ?? "";
      if (!quoteText) errors.push(`${id}: quote_text obrigatorio para quote_card`);
      if (v.animation_type && v.animation_type !== "typing") {
        warnings.push(`${id}: animation_type "${v.animation_type}" — MVP so typing`);
      }
      const displayQuote = quoteText;
      const normNarration = scene.narration_text.replace(/^["“]|["”]$/g, "").trim();
      if (!normNarration.includes(displayQuote) && !scene.narration_text.includes(displayQuote)) {
        errors.push(`${id}: quote_text deve aparecer em narration_text`);
      }
      if (v.search_keywords) warnings.push(`${id}: quote_card deve ter search_keywords null`);
    }

    if (v.source === "stock") {
      if (!v.search_keywords?.trim()) {
        errors.push(`${id}: search_keywords obrigatorio para stock`);
      }
    }
  }

  return { errors, warnings };
}

/** Corrige planos antigos: ai_generated + video → image (antes da validacao/enqueue). */
export function normalizeStoicPatrolBlockPlan(plan: BlockScenesPlanV2): string[] {
  const notes: string[] = [];
  if (!isStoicPatrolModality() || !stoicPatrolAiImagesOnly()) return notes;
  for (const scene of plan.scenes) {
    const v = scene.visual;
    if (v.source === "ai_generated" && v.type !== "image") {
      v.type = "image";
      notes.push(`${scene.id}: ai_generated ${v.type} → image`);
    }
  }
  return notes;
}

export function assertStoicPatrolBlockPlan(plan: BlockScenesPlanV2): void {
  if (!isStoicPatrolModality()) return;
  for (const n of normalizeStoicPatrolBlockPlan(plan)) {
    console.warn(`[stoic_patrol plano] ${n}`);
  }
  const { errors, warnings } = validateStoicPatrolBlockPlan(plan);
  for (const w of warnings) {
    console.warn(`[stoic_patrol plano] ${w}`);
  }
  if (errors.length > 0) {
    throw new Error(`Plano Stoic Patrol invalido:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
}

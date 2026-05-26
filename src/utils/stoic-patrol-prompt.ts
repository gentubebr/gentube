import { resolveVisualModality } from "../config.js";
import type { BlockScenesPlanV2 } from "../types/scenes-plan.js";

export function isStoicPatrolModality(): boolean {
  return resolveVisualModality() === "stoic_patrol";
}

export function validateStoicPatrolBlockPlan(plan: BlockScenesPlanV2): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const scene of plan.scenes) {
    const v = scene.visual;
    const id = scene.id;

    if (v.source === "ai_generated" || v.source === "manual_capture") {
      errors.push(`${id}: source "${v.source}" proibido em stoic_patrol`);
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

export function assertStoicPatrolBlockPlan(plan: BlockScenesPlanV2): void {
  if (!isStoicPatrolModality()) return;
  const { errors, warnings } = validateStoicPatrolBlockPlan(plan);
  for (const w of warnings) {
    console.warn(`[stoic_patrol plano] ${w}`);
  }
  if (errors.length > 0) {
    throw new Error(`Plano Stoic Patrol invalido:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
}

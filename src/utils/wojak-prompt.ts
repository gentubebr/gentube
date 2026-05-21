import path from "node:path";
import {
  resolveVisualModality,
  wojakStyleToken,
  WOJAK_REF_PATHS,
  type VisualModality,
  type WojakCharacterVariant,
} from "../config.js";
import type { BlockScenesPlanV2, SceneVisualPlanV2 } from "../types/scenes-plan.js";

const VARIANT_SET = new Set<string>(Object.keys(WOJAK_REF_PATHS));

export function isWojakCharacterVariant(v: string): v is WojakCharacterVariant {
  return VARIANT_SET.has(v);
}

export function detectWojakVariant(text: string): WojakCharacterVariant {
  const t = text.toLowerCase();
  if (/\b(pain|hurt|loss|lost|crash|fail|mistake|regret|oof|perdeu|perda|erro|fracasso)\b/.test(t)) {
    return "pain";
  }
  if (/\b(impressed|amazed|wow|whoa|surprised|descobri|surpreso)\b/.test(t)) {
    return "impressed";
  }
  if (/\b(doomer|cynical|hopeless|nihil|beanie|hoodie)\b/.test(t)) {
    return "doomer";
  }
  if (/\b(tired|exhausted|burnout|sleepy|insomnia|late night|cansado|exausto|sono)\b/.test(t)) {
    return "tired";
  }
  if (/\b(smiling|grin|laugh|celebrat|win|profit|gain|sorriso|riso|ganho|lucro)\b/.test(t)) {
    return "smiling";
  }
  if (/\b(happy|glad|relief|content|feliz|alegre|aliviado)\b/.test(t)) {
    return "happy";
  }
  if (/\b(looking at camera|face camera|direct address|olhando para camera)\b/.test(t)) {
    return "frontal";
  }
  return "neutral";
}

export function resolveWojakReferencePath(
  variant: WojakCharacterVariant,
  avatarOverride?: string,
): string {
  if (avatarOverride?.trim()) {
    return /^https?:\/\//i.test(avatarOverride) ? avatarOverride.trim() : path.resolve(avatarOverride);
  }
  return WOJAK_REF_PATHS[variant];
}

/** Variante: emoção na description tem prioridade sobre character_variant do plano quando não é neutral. */
export function resolveWojakVariantForScene(
  visual: SceneVisualPlanV2,
  narrationText: string,
): WojakCharacterVariant {
  const fromDesc = detectWojakVariant(visual.description);
  const rawPlan = visual.character_variant?.trim().toLowerCase();
  const fromPlan =
    rawPlan && isWojakCharacterVariant(rawPlan) ? rawPlan : detectWojakVariant(narrationText);
  return fromDesc !== "neutral" ? fromDesc : fromPlan;
}

/** Gemini com PNG de referência: preservar identidade da face (não repetir style token pesado). */
export function buildWojakReferenceImagePrompt(description: string, negativePrompt?: string): string {
  const scene = description
    .replace(/\bwojak\s+character,?\s*/gi, "")
    .replace(/\bminimalist line art[^,]*,?\s*/gi, "")
    .replace(/\bbold black outlines[^,]*,?\s*/gi, "")
    .replace(/\bwhite background,?\s*/gi, "")
    .trim();
  let p =
    "The attached image is the canonical character reference. Keep the exact same face, head shape, line-art style, and proportions. " +
    "Only change body pose, hands, props, and background for this frame.\n\n" +
    `Scene: ${scene}`;
  const neg = negativePrompt?.trim();
  if (neg) p += `\nAvoid: ${neg}`;
  p += "\nDo not replace the face with a different character.";
  return p;
}

export function buildWojakPrompt(
  description: string,
  narrationText?: string,
  negativePrompt?: string,
): string {
  let p = `${wojakStyleToken()} ${description.trim()}`;
  const neg = negativePrompt?.trim();
  if (neg) p += ` Avoid: ${neg}`;
  if (narrationText?.trim()) {
    p += ` Scene context from narration: ${narrationText.trim().slice(0, 280)}`;
  }
  return p;
}

/** Prompt curto para Veo (text-to-video; sem nome Wojak / meme). */
export function buildWojakVeoPrompt(description: string, negativePrompt?: string): string {
  const raw = buildWojakReferenceImagePrompt(description, negativePrompt);
  return sanitizeWojakPromptForVeo(
    `${raw}\nAnimate with subtle motion as described in the scene (line art stick figure, white background).`,
  );
}

/**
 * Veo RAI costuma bloquear "Wojak" / meme nomeado (third-party content).
 * Gemini (bootstrap/imagem) mantém o prompt completo; so o video usa texto generico.
 */
export function sanitizeWojakPromptForVeo(prompt: string): string {
  return prompt
    .replace(/\bwojak\s+meme\s+face\s+style\b/gi, "minimalist line art face style")
    .replace(/\bwojak\s+character\b/gi, "line art stick figure character")
    .replace(/\bwojak\b/gi, "line art stick figure character")
    .replace(/\bmeme[- ]?style\b/gi, "cartoon line art style")
    .replace(/\bmeme\b/gi, "internet cartoon")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export type SceneVisualRenderPrep = {
  hfPrompt: string;
  /** Gemini bootstrap / imagem com PNG canónica (preserva face). */
  bootstrapPrompt?: string;
  /** Veo text-to-video (sanitizado; ref opcional via GENTUBE_WOJAK_VEO_USE_REF). */
  veoPrompt?: string;
  referenceImageUrl?: string;
  wojakReferenceLabel?: string;
  /** Wojak: always bootstrap video before Veo when character on screen. */
  wojakVideoBootstrap: boolean;
};

export function promptForSceneVisual(v: SceneVisualPlanV2): string {
  let p = v.description.trim();
  const neg = v.negative_prompt?.trim();
  if (neg) p += ` Avoid: ${neg}`;
  return p;
}

export function prepareSceneVisualRender(
  v: SceneVisualPlanV2,
  narrationText: string,
  modality: VisualModality,
  avatarRef?: string,
): SceneVisualRenderPrep {
  if (modality !== "wojak" || !v.character_required) {
    return {
      hfPrompt: promptForSceneVisual(v),
      referenceImageUrl: v.character_required ? avatarRef : undefined,
      wojakVideoBootstrap: false,
    };
  }

  const variant = resolveWojakVariantForScene(v, narrationText);
  const referenceImageUrl = resolveWojakReferencePath(variant, avatarRef);
  const refPrompt = buildWojakReferenceImagePrompt(v.description, v.negative_prompt);
  const hfPrompt = refPrompt;
  const bootstrapPrompt = refPrompt;
  const veoPrompt = buildWojakVeoPrompt(v.description, v.negative_prompt);

  return {
    hfPrompt,
    bootstrapPrompt,
    veoPrompt,
    referenceImageUrl,
    wojakReferenceLabel: `${variant} → ${path.basename(referenceImageUrl)}`,
    wojakVideoBootstrap: v.type === "video",
  };
}

export function currentVisualModality(): VisualModality {
  return resolveVisualModality();
}

export type WojakPlanValidationResult = {
  errors: string[];
  warnings: string[];
};

/** Valida plano v2 em modo Wojak (fonte, personagem, keywords). */
export function validateWojakBlockPlan(plan: BlockScenesPlanV2): WojakPlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let imageCount = 0;

  for (const scene of plan.scenes) {
    const v = scene.visual;
    if (v.type === "image") imageCount += 1;

    if (v.source === "stock" || v.source === "manual_capture") {
      errors.push(`${scene.id}: source "${v.source}" proibido em modo wojak (use ai_generated)`);
    }
    if (v.source !== "ai_generated") {
      errors.push(`${scene.id}: source deve ser ai_generated`);
    }
    if (v.search_keywords != null && String(v.search_keywords).trim() !== "") {
      errors.push(`${scene.id}: search_keywords deve ser null em modo wojak`);
    }
    if (!v.character_required) {
      errors.push(`${scene.id}: character_required deve ser true (Wojak em todas as cenas)`);
    }
    const cv = v.character_variant?.trim().toLowerCase();
    if (!cv || !isWojakCharacterVariant(cv)) {
      errors.push(`${scene.id}: character_variant obrigatorio em modo wojak`);
    }
    const desc = v.description.trim().toLowerCase();
    if (!desc.includes("wojak")) {
      warnings.push(`${scene.id}: description sem "Wojak" — confirme personagem na cena`);
    }
    if (v.type === "video" && !/\b(motion|walking|running|turning|pointing|throwing|shaking|nodding|waving|celebrat|strut|slump|grab|push|pull)\b/i.test(v.description)) {
      warnings.push(`${scene.id}: video sem motion cue explicito na description`);
    }
  }

  const imageRatio = plan.scenes.length > 0 ? imageCount / plan.scenes.length : 0;
  if (imageRatio > 0.45) {
    warnings.push(
      `Plano com ${imageCount}/${plan.scenes.length} imagens (${Math.round(imageRatio * 100)}%) — preferir mais videos para animacao`,
    );
  }

  return { errors, warnings };
}

export function assertWojakBlockPlan(plan: BlockScenesPlanV2): void {
  if (resolveVisualModality() !== "wojak") return;
  const { errors, warnings } = validateWojakBlockPlan(plan);
  for (const w of warnings) {
    console.warn(`[wojak plano] ${w}`);
  }
  if (errors.length > 0) {
    throw new Error(`Plano Wojak invalido:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
}

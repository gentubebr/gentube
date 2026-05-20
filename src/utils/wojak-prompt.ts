import path from "node:path";
import {
  resolveVisualModality,
  wojakStyleToken,
  WOJAK_REF_PATHS,
  type VisualModality,
  type WojakCharacterVariant,
} from "../config.js";
import type { SceneVisualPlanV2 } from "../types/scenes-plan.js";

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

export type SceneVisualRenderPrep = {
  hfPrompt: string;
  referenceImageUrl?: string;
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

  const rawVariant = v.character_variant?.trim().toLowerCase();
  const variant =
    rawVariant && isWojakCharacterVariant(rawVariant)
      ? rawVariant
      : detectWojakVariant(`${narrationText} ${v.description}`);

  const referenceImageUrl = resolveWojakReferencePath(variant, avatarRef);
  const hfPrompt = buildWojakPrompt(v.description, narrationText, v.negative_prompt);

  return {
    hfPrompt,
    referenceImageUrl,
    wojakVideoBootstrap: v.type === "video",
  };
}

export function currentVisualModality(): VisualModality {
  return resolveVisualModality();
}

import fs from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import {
  GEMINI_IMAGE_ASPECT_RATIO,
  GEMINI_IMAGE_MODEL,
  GEMINI_IMAGE_SIZE,
  geminiApiKey,
} from "../config.js";

let client: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  const key = geminiApiKey();
  if (!key) {
    throw new Error("GEMINI_API_KEY (ou google_api_key) nao definida no .env");
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey: key });
  }
  return client;
}

export function extFromMime(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  return ".png";
}

export function extractInlineImageFromResponse(response: {
  candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
}): { base64: string; mimeType: string } | null {
  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts?.length) return null;
  for (const part of parts) {
    const data = part.inlineData?.data;
    if (data) {
      return {
        base64: data,
        mimeType: part.inlineData?.mimeType ?? "image/png",
      };
    }
  }
  return null;
}

export type GeminiMultimodalPart = {
  text?: string;
  inlineData?: { mimeType: string; data: string };
};

/** Partes user para Gemini (imagem de referencia opcional + prompt). Usado em sync e batch. */
export async function buildGeminiMultimodalParts(
  prompt: string,
  referenceImagePath?: string,
): Promise<GeminiMultimodalPart[] | string> {
  if (!referenceImagePath?.trim()) return prompt;
  if (/^https?:\/\//i.test(referenceImagePath.trim())) {
    throw new Error("Gemini batch/sync: referencia Wojak deve ser caminho local (PNG em src/assets/wojak/)");
  }

  const buf = await fs.readFile(referenceImagePath);
  const ext = path.extname(referenceImagePath).toLowerCase();
  const mimeType =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
        ? "image/webp"
        : "image/png";

  return [
    { inlineData: { mimeType, data: buf.toString("base64") } },
    { text: prompt },
  ];
}

async function buildContents(
  prompt: string,
  referenceImagePath?: string,
): Promise<string | GeminiMultimodalPart[]> {
  return buildGeminiMultimodalParts(prompt, referenceImagePath);
}

export async function generateGeminiImageSync(input: {
  prompt: string;
  outPathNoExt: string;
  referenceImagePath?: string;
  model?: string;
}): Promise<{ localPath: string; mimeType: string }> {
  const ai = getGeminiClient();
  const model = input.model ?? GEMINI_IMAGE_MODEL;
  const contents = await buildContents(input.prompt, input.referenceImagePath);

  const response = await ai.models.generateContent({
    model,
    contents,
    config: {
      responseModalities: ["IMAGE"],
      imageConfig: {
        aspectRatio: GEMINI_IMAGE_ASPECT_RATIO,
        imageSize: GEMINI_IMAGE_SIZE,
      },
    },
  });

  const extracted = extractInlineImageFromResponse(response);
  if (!extracted) {
    throw new Error("Gemini: resposta sem inlineData de imagem");
  }

  const ext = extFromMime(extracted.mimeType);
  const localPath = `${input.outPathNoExt}${ext}`;
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, Buffer.from(extracted.base64, "base64"));
  return { localPath, mimeType: extracted.mimeType };
}

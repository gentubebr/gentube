import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { ELEVENLABS_API_KEY } from "../config.js";
import { stripMarkdownForSpeech } from "../utils/markdown-for-tts.js";

export interface ElevenLabsSubscriptionInfo {
  characterCount: number;
  characterLimit: number;
  characterRemaining: number;
  nextResetUnix: number | null;
  tier: string;
}

let client: ElevenLabsClient | null = null;

function getClient(): ElevenLabsClient {
  if (!ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY nao configurada no .env");
  }
  if (!client) {
    client = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });
  }
  return client;
}

export async function getSubscriptionInfo(): Promise<ElevenLabsSubscriptionInfo> {
  const elevenlabs = getClient();
  const sub = await elevenlabs.user.subscription.get();
  return {
    characterCount: sub.characterCount,
    characterLimit: sub.characterLimit,
    characterRemaining: sub.characterLimit - sub.characterCount,
    nextResetUnix: sub.nextCharacterCountResetUnix ?? null,
    tier: sub.tier,
  };
}

export type CharacterAlignmentPayload = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

function mapAlignment(
  align: { characters: string[]; characterStartTimesSeconds: number[]; characterEndTimesSeconds: number[] } | undefined,
): CharacterAlignmentPayload | null {
  if (!align?.characters?.length) return null;
  return {
    characters: align.characters,
    character_start_times_seconds: align.characterStartTimesSeconds,
    character_end_times_seconds: align.characterEndTimesSeconds,
  };
}

export async function textToSpeechMp3(input: { text: string; voiceId: string }): Promise<Buffer> {
  const elevenlabs = getClient();
  const text = stripMarkdownForSpeech(input.text);
  if (!text.trim()) {
    throw new Error("Texto de narracao vazio apos remover Markdown (verifique o bloco ou a cena).");
  }
  const audioStream = await elevenlabs.textToSpeech.convert(input.voiceId, {
    text,
    modelId: "eleven_multilingual_v2",
    outputFormat: "mp3_44100_128",
  });

  const chunks: Buffer[] = [];
  for await (const chunk of audioStream as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** ElevenLabs convertWithTimestamps — alinhamento caractere a caractere (Stoic overlay). */
export async function textToSpeechMp3WithAlignment(input: {
  text: string;
  voiceId: string;
}): Promise<{ audio: Buffer; alignment: CharacterAlignmentPayload }> {
  const elevenlabs = getClient();
  const text = stripMarkdownForSpeech(input.text);
  if (!text.trim()) {
    throw new Error("Texto de narracao vazio apos remover Markdown (verifique o bloco ou a cena).");
  }
  const response = await elevenlabs.textToSpeech.convertWithTimestamps(input.voiceId, {
    text,
    modelId: "eleven_multilingual_v2",
    outputFormat: "mp3_44100_128",
  });
  const audio = Buffer.from(response.audioBase64, "base64");
  const alignment =
    mapAlignment(response.alignment) ?? mapAlignment(response.normalizedAlignment);
  if (!alignment) {
    throw new Error("ElevenLabs nao retornou alignment (with_timestamps)");
  }
  return { audio, alignment };
}

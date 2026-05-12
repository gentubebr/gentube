import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { ELEVENLABS_API_KEY } from "../config.js";

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

export async function textToSpeechMp3(input: { text: string; voiceId: string }): Promise<Buffer> {
  const elevenlabs = getClient();
  const audioStream = await elevenlabs.textToSpeech.convert(input.voiceId, {
    text: input.text,
    modelId: "eleven_multilingual_v2",
    outputFormat: "mp3_44100_128",
  });

  const chunks: Buffer[] = [];
  for await (const chunk of audioStream as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

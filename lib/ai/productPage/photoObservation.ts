import "server-only";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { getUrl } from "aws-amplify/storage/server";
import sharp from "sharp";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { fetchWithTimeout } from "@/lib/http/fetchWithTimeout";

/** Only visible appearance belongs here; identity, material and condition need other evidence. */
export function parsePhotoObservations(raw: string): string[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return []; }
  if (!value || typeof value !== "object" || !Array.isArray((value as { observations?: unknown }).observations)) return [];
  return (value as { observations: unknown[] }).observations
    .filter((item): item is string => typeof item === "string")
    .map(item => item.trim())
    .filter(item => item.length >= 4 && item.length <= 120)
    .filter(item => !/(?:ブランド|メーカー|デザイナー|本革|無垢材|新品|傷なし|希少|正規品|年代|製造国)/.test(item))
    .slice(0, 6);
}

const observationsByHash = new Map<string, string[]>();
const pendingByHash = new Map<string, Promise<string[]>>();
const MODEL_ID = "us.amazon.nova-pro-v1:0";
const PROMPT_VERSION = "2026-09-29.1";
const MAX_CACHE_ENTRIES = 100;

function remember(hash: string, observations: string[]): void {
  observationsByHash.delete(hash);
  observationsByHash.set(hash, observations);
  if (observationsByHash.size > MAX_CACHE_ENTRIES) {
    const oldest = observationsByHash.keys().next().value;
    if (oldest) observationsByHash.delete(oldest);
  }
}

/** Fail closed: a failed observation never becomes a product claim. */
export async function observeProductPhoto(jpeg: Uint8Array): Promise<string[]> {
  if (jpeg.byteLength === 0 || jpeg.byteLength > 5_000_000) return [];
  const hash = `${MODEL_ID}|${PROMPT_VERSION}|${createHash("sha256").update(jpeg).digest("hex")}`;
  const cached = observationsByHash.get(hash);
  if (cached) return cached;
  const pending = pendingByHash.get(hash);
  if (pending) return pending;
  const work = callVision(jpeg, hash);
  pendingByHash.set(hash, work);
  try { return await work; } finally { pendingByHash.delete(hash); }
}

async function callVision(jpeg: Uint8Array, hash: string): Promise<string[]> {
  const client = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-west-2" });
  try {
    const response = await client.send(new ConverseCommand({
      modelId: MODEL_ID,
      messages: [{ role: "user", content: [
        { image: { format: "jpeg", source: { bytes: jpeg } } },
        { text: "EC紹介文の根拠用に、写真で直接見える商品の外観だけを日本語で短く観察してください。色、形、構造、配置など見える事実だけ。ブランド、材質、年代、品質、状態の良否は推測しないでください。不明なら空配列。JSONのみ: {\"observations\":[\"観察1\",\"観察2\"]}" },
      ] }],
      inferenceConfig: { temperature: 0, maxTokens: 300 },
    }), { abortSignal: AbortSignal.timeout(20_000) });
    const raw = response.output?.message?.content?.find(part => "text" in part)?.text ?? "";
    const observations = parsePhotoObservations(raw);
    remember(hash, observations);
    return observations;
  } catch (error) {
    console.warn("[photoObservation] observation unavailable", error instanceof Error ? error.name : "UnknownError");
    remember(hash, []);
    return [];
  } finally {
    client.destroy();
  }
}

/** Read only BELLO's own stored image, then resize before sending it to Vision. */
export async function observeStoredProductPhoto(storageKey: string): Promise<string[]> {
  if (!storageKey || storageKey.startsWith("e2e-fixture:")) return [];
  try {
    const { url } = await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: context => getUrl(context, { path: storageKey }),
    });
    const response = await fetchWithTimeout(url, undefined, { timeoutMs: 8_000, label: "商品写真" });
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 15_000_000) return [];
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 15_000_000) return [];
    const jpeg = await sharp(bytes).rotate().resize({ width: 960, height: 960, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
    return observeProductPhoto(jpeg);
  } catch (error) {
    console.warn("[photoObservation] stored photo unavailable", error instanceof Error ? error.name : "UnknownError");
    return [];
  }
}

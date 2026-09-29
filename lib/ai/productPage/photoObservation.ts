import "server-only";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { cookies } from "next/headers";
import { getUrl } from "aws-amplify/storage/server";
import sharp from "sharp";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { fetchWithTimeout } from "@/lib/http/fetchWithTimeout";
import { createPhotoObservationReuse } from "./photoObservationReuse";

/** Only visible appearance belongs here; identity, material and condition need other evidence. */
export function parsePhotoObservations(raw: string): string[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return []; }
  if (!value || typeof value !== "object" || !Array.isArray((value as { observations?: unknown }).observations)) return [];
  return (value as { observations: unknown[] }).observations
    .filter((item): item is string => typeof item === "string")
    .map(item => item.trim())
    .filter(item => item.length >= 4 && item.length <= 120)
    .filter(item => !/(?:ブランド|メーカー|デザイナー|本革|無垢材|木製|金属製|樹脂製|素材|新品|傷なし|希少|正規品|年代|製造国)/.test(item))
    .slice(0, 6);
}

const MODEL_ID = "us.amazon.nova-pro-v1:0";
const PROMPT_VERSION = "2026-09-29.2";
const CACHE_FIELD = "photo-observation-v1";

const reuseObservation = createPhotoObservationReuse({
  async read(cacheKey) {
    const { data, errors } = await serverDataClient.models.ExternalResearchCache.get({ cacheKey }, inventoryAuthMode);
    if (errors?.length || data?.field !== CACHE_FIELD || data.status !== "FOUND" || !data.value) return null;
    const parsed = JSON.parse(data.value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every(value => typeof value === "string")) return null;
    const safe = parsePhotoObservations(JSON.stringify({ observations: parsed }));
    return safe.length === parsed.length ? safe : null;
  },
  async write(cacheKey, observations) {
    const payload = {
      cacheKey, field: CACHE_FIELD, value: JSON.stringify(observations),
      status: "FOUND" as const, fetchedAt: new Date().toISOString(),
    };
    const { errors } = await serverDataClient.models.ExternalResearchCache.create(payload, inventoryAuthMode);
    if (errors?.length) await serverDataClient.models.ExternalResearchCache.update(payload, inventoryAuthMode);
  },
}, callVision);

/** Fail closed: a failed observation never becomes a product claim. */
export async function observeProductPhoto(jpeg: Uint8Array): Promise<string[]> {
  return reuseObservation(jpeg, MODEL_ID, PROMPT_VERSION);
}

async function callVision(jpeg: Uint8Array): Promise<string[] | null> {
  const client = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-west-2" });
  try {
    const response = await client.send(new ConverseCommand({
      modelId: MODEL_ID,
      messages: [{ role: "user", content: [
        { image: { format: "jpeg", source: { bytes: jpeg } } },
        { text: "EC紹介文の根拠用に、写真で直接見える商品の外観だけを日本語で短く観察してください。部位ごとの色と模様を優先し、背もたれ・座面・脚などの色を取り違えないでください。『背もたれは黒い』『座面には茶色の木目模様が見える』のように、1観察につき1部位の見える特徴だけを書いてください。材質を木製・金属製等と断定せず、ブランド、年代、品質、状態の良否も推測しないでください。不明なら空配列。JSONのみ: {\"observations\":[\"観察1\",\"観察2\"]}" },
      ] }],
      inferenceConfig: { temperature: 0, maxTokens: 300 },
    }), { abortSignal: AbortSignal.timeout(20_000) });
    const raw = response.output?.message?.content?.find(part => "text" in part)?.text ?? "";
    // A malformed or missing response is a failed observation, not a valid empty result.
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { observations?: unknown }).observations)) return null;
      if ((parsed as { observations: unknown[] }).observations.length > 0 && parsePhotoObservations(raw).length === 0) return null;
    } catch { return null; }
    const observations = parsePhotoObservations(raw);
    return observations;
  } catch (error) {
    console.warn("[photoObservation] observation unavailable", error instanceof Error ? error.name : "UnknownError");
    return null;
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

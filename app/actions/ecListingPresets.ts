"use server";
import { serverDataClient } from "@/lib/amplify/dataClient";
import {
  canEditInventory,
  getInventoryRole,
} from "@/lib/amplify/requireInventoryUser";
import {
  DEFAULT_EC_PRESETS,
  parseEcPreset,
  type EcPreset,
} from "@/lib/listing/ecPresets";

export async function listEcPresetsAction(): Promise<EcPreset[]> {
  if (!canEditInventory(await getInventoryRole()))
    throw Error("編集権限がありません。");
  const merged = new Map(DEFAULT_EC_PRESETS.map((p) => [p.id, p]));
  let nextToken: string | null = null;
  do {
    const response = (await serverDataClient.graphql({
      query: `query EcPresets($nextToken:String) { listEcListingPresets(limit:100,nextToken:$nextToken) { items { id name channel revision values deleted } nextToken } }`,
      variables: { nextToken },
      authMode: "userPool",
    })) as {
      errors?: unknown;
      data?: {
        listEcListingPresets: {
          items: Record<string, unknown>[];
          nextToken?: string;
        };
      };
    };
    if (response.errors || !response.data)
      throw Error("出品設定を読み込めませんでした。");
    for (const row of response.data.listEcListingPresets.items) {
      const parsed = parseEcPreset({
        ...row,
        values:
          typeof row.values === "string" ? JSON.parse(row.values) : row.values,
      });
      if (!parsed) throw Error("保存済みの出品設定を確認してください。");
      merged.set(parsed.id, parsed);
    }
    nextToken = response.data.listEcListingPresets.nextToken ?? null;
  } while (nextToken);
  return [...merged.values()].filter((p) => !p.deleted);
}
export async function saveEcPresetAction(input: unknown): Promise<EcPreset> {
  if ((await getInventoryRole()) !== "ADMIN")
    throw Error("出品設定の変更には管理者権限が必要です。");
  const p = parseEcPreset(input);
  if (!p) throw Error("設定名・価格・配送条件を確認してください。");
  const create = p.revision === 0,
    op = create ? "createEcListingPreset" : "updateEcListingPreset";
  const result = (await serverDataClient.graphql({
    query: `mutation SaveEcPreset($input:${create ? "Create" : "Update"}EcListingPresetInput!, $condition:ModelEcListingPresetConditionInput) { ${op}(input:$input,condition:$condition) { id revision } }`,
    variables: {
      input: {
        ...p,
        values: JSON.stringify(p.values),
        revision: p.revision + 1,
      },
      condition: create
        ? { revision: { attributeExists: false } }
        : { revision: { eq: p.revision } },
    },
    authMode: "userPool",
  })) as {
    errors?: unknown;
    data?: Record<string, { id: string; revision: number }>;
  };
  if (result.errors || !result.data?.[op])
    throw Error(
      "別の画面で設定が変わったか、保存できませんでした。再読み込みしてください。",
    );
  return { ...p, revision: result.data[op].revision };
}

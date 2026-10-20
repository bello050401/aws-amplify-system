import {
  DynamoDBDocumentClient,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { selectExpiredVersions, type RetentionCandidate } from "./retention";
export type VersionLifecycleRow = RetentionCandidate & { updatedAt: string };
export async function activateVersionAtomically(
  db: DynamoDBDocumentClient,
  table: string,
  key: string,
  targetId: string,
  versions: VersionLifecycleRow[],
) {
  const target = versions.find(
    (v) => v.id === targetId && v.imageStorageKey === key,
  );
  if (
    !target ||
    !["READY", "SUPERSEDED", "NEEDS_REVIEW"].includes(target.status)
  )
    throw Error(
      "対象の加工画像が変更・削除されました。画面を開き直してください。",
    );
  const now = new Date().toISOString();
  if (versions.length > 100)
    throw Error(
      "加工履歴が多いため、安全に切り替えできません。管理者へ連絡してください。",
    );
  await db.send(
    new TransactWriteCommand({
      TransactItems: [
        ...versions
          .filter((v) => !v.active && v.id !== targetId)
          .map((v) => ({
            ConditionCheck: {
              TableName: table,
              Key: { id: v.id },
              ConditionExpression: "updatedAt = :version AND active = :no",
              ExpressionAttributeValues: {
                ":version": v.updatedAt,
                ":no": false,
              },
            },
          })),
        ...versions
          .filter((v) => v.active && v.id !== targetId)
          .map((v) => ({
            Update: {
              TableName: table,
              Key: { id: v.id },
              UpdateExpression: "SET active = :no, #s = :s, updatedAt = :now",
              ConditionExpression: "updatedAt = :version AND active = :yes",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":no": false,
                ":yes": true,
                ":s": "SUPERSEDED",
                ":now": now,
                ":version": v.updatedAt,
              },
            },
          })),
        {
          Update: {
            TableName: table,
            Key: { id: targetId },
            UpdateExpression:
              "SET active = :yes, #s = :ready, updatedAt = :now",
            ConditionExpression:
              "attribute_exists(id) AND updatedAt = :version AND imageStorageKey = :key AND #s = :previous",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":yes": true,
              ":ready": "READY",
              ":now": now,
              ":version": target.updatedAt,
              ":key": key,
              ":previous": target.status,
            },
          },
        },
      ],
    }),
  );
}
/** Remove only expired, unadopted rows while retaining a proven active version. */
export async function retireExpiredVersions(
  db: DynamoDBDocumentClient,
  table: string,
  versions: VersionLifecycleRow[],
  now = new Date(),
) {
  const retired: string[] = [];
  for (const candidate of selectExpiredVersions(versions, now).expired.slice(
    0,
    50,
  )) {
    const old = versions.find((v) => v.id === candidate.id)!;
    const active = versions.find(
      (v) =>
        v.imageStorageKey === old.imageStorageKey &&
        v.active &&
        v.id !== old.id,
    )!;
    try {
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: table,
                Key: { id: active.id },
                ConditionExpression: "active = :yes AND imageStorageKey = :key",
                ExpressionAttributeValues: {
                  ":yes": true,
                  ":key": old.imageStorageKey,
                },
              },
            },
            {
              Delete: {
                TableName: table,
                Key: { id: old.id },
                ConditionExpression:
                  "active = :no AND updatedAt = :version AND #s = :status",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: {
                  ":no": false,
                  ":version": old.updatedAt,
                  ":status": old.status,
                },
              },
            },
          ],
        }),
      );
      retired.push(old.id);
    } catch (e) {
      const reasons = (e as { CancellationReasons?: { Code?: string }[] })
        .CancellationReasons;
      if (!(
        e instanceof Error &&
        e.name === "TransactionCanceledException" &&
        reasons?.some((r) => r.Code === "ConditionalCheckFailed") &&
        reasons.every(
          (r) =>
            !r.Code || r.Code === "None" || r.Code === "ConditionalCheckFailed",
        )
      ))
        throw e;
    }
  }
  return retired;
}

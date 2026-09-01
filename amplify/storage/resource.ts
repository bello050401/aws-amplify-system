import { defineStorage } from "@aws-amplify/backend";

/**
 * Object storage for the Inventory system (BELLO在庫管理システム, Phase 2).
 *
 * There is no existing Storage resource on this Amplify app — the
 * feature-page generator stores no images of its own (BASE hosts those,
 * see lib/base/*), so this bucket is new and exists solely for Inventory.
 *
 * Everything lives under the `inventory/*` prefix on purpose: if a future
 * system on this same Amplify app ever needs its own storage area, it
 * gets its own prefix (or its own bucket) rather than sharing this one,
 * so its access rules can never accidentally loosen or tighten
 * Inventory's.
 *
 * Access is Cognito User Pool groups only — there is no `guest`/
 * unauthenticated rule at all, matching the Data authorization design in
 * amplify/data/resource.ts (no public access to inventory data or
 * images). ADMIN and EDITOR can manage images; VIEWER can only view them.
 *
 * "Admins" (the pre-existing Feature-side group, unrelated to
 * "ADMIN" — see amplify/auth/resource.ts) is included in the same
 * read/write/delete grant as ADMIN/EDITOR. This is not optional
 * belt-and-braces: Storage access is IAM-enforced through the Identity
 * Pool, and a Cognito Identity Pool vends exactly ONE role per request,
 * chosen via `cognito:preferred_role` — the caller's *highest-precedence*
 * User Pool group, not "any group that grants access". "Admins" is
 * listed first in auth/resource.ts's `groups` array, so it gets
 * precedence 0 (highest) — any account in both "Admins" and "ADMIN"
 * always assumes the Admins-group role for Storage calls, never the
 * ADMIN-group one, no matter what ADMIN's own rule says. Leaving
 * "Admins" out here doesn't make that account "less privileged"; it
 * makes every Storage call from that account use a role this rule never
 * granted anything to, which is exactly the `s3:PutObject ... is not
 * authorized` failure this comment is here to prevent regressing back
 * into. (Data/GraphQL authorization is unaffected by this — Cognito User
 * Pool group-based `allow.group(...)` checks the JWT's `cognito:groups`
 * list directly, which includes every group the user is in
 * simultaneously; there is no single-role selection there.)
 */
export const storage = defineStorage({
  name: "belloInventoryStorage",
  access: (allow) => ({
    "inventory/*": [
      allow.groups(["ADMIN", "EDITOR", "Admins"]).to(["read", "write", "delete"]),
      allow.groups(["VIEWER"]).to(["read"]),
    ],
    // AI問い合わせ返信の社内ナレッジ文書(2026-09-01仕様書 §22:
    // 「ナレッジ文書はADMINのみ管理可能」)。inventory/*配下に置くと
    // EDITORにも書き込み権限が付いてしまうため、意図的に別prefixにする。
    //
    // "Admins"を併記しているのは上のコメントと同じIdentity Poolの
    // 事情による —— ADMINとAdminsの両方に所属するアカウントは常に
    // Adminsのロールでリクエストするため、ここへ書かないとその
    // アカウントだけが自分の管理画面から文書を上げられなくなる。
    // VIEWER/EDITORはここには一切現れない(読み取りも与えない):
    // AI返信が根拠として使う本文はDynamoDB側のsearchTextから読むので、
    // 原本のS3オブジェクトへ触れる必要があるのはADMINだけ。
    "knowledge/*": [allow.groups(["ADMIN", "Admins"]).to(["read", "write", "delete"])],
  }),
});

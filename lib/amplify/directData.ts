import "server-only";
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

/**
 * 2026-09-03 追加指示 §5/§6: **未認証の経路から使うデータアクセス。**
 *
 * ── なぜ必要か ──────────────────────────────────────────────────
 *
 * `serverDataClient` は `generateServerClientUsingCookies` +
 * `authMode:"userPool"` で、**ログイン中のCognitoセッションが前提**。
 * LINE Webhook はLINEプラットフォームからの未認証POSTなので、Cookieも
 * セッションも無く、AppSyncが認可で弾く。実際にStagingで確認したところ、
 * Conversation/Message は作られる(あちらはDynamoDB直接)のに
 * ReplyDraft も NotificationDelivery も0件、という状態になっていた。
 *
 * ── なぜAppSyncの認可を広げないのか ──────────────────────────────
 *
 * §6が禁止している。加えて、このリポジトリは既に答えを出している:
 * `lib/messaging/webhookStore.ts` と worker 3本(zaico-sync /
 * image-processing / pricing-scheduler)は**すべてDynamoDBを直接叩く**。
 * 未認証・バックグラウンドの経路はAppSyncを通さない、というのが既存の方針。
 * ここもそれに合わせる。
 *
 * ── なぜ「Amplifyクライアントの見た目」を真似るのか ──────────────
 *
 * 呼び出し側(在庫検索・ナレッジ・返信ルール・送料・返信案…)は10以上の
 * モジュールに散っていて、そのすべてが `serverDataClient.models.X.get/list/
 * create/update` の形で書かれている。同じ形の差し替え可能な実装を1つ作れば、
 * **呼び出し側を1行も変えずに**未認証経路を通せる。個々のモジュールへ
 * DynamoDB版を書き足すと、同じ問い合わせ処理が2実装になり必ず食い違う。
 *
 * ── 知らない操作は必ず失敗させる ────────────────────────────────
 *
 * 実装していない操作・フィルタが来たら**例外を投げる**。黙って空配列や
 * undefined を返すと、「商品が見つからなかった」「ナレッジが0件だった」と
 * 誤認したまま返信案が作られる。§6の「認証エラーをcatchして成功扱いにする」
 * 禁止と同じ考え方で、分からないものは分からないと落とす。
 */

const REGION = process.env.AWS_REGION || process.env.BEDROCK_REGION || "us-west-2";

/**
 * テーブル名は `<Model>-<apiId>-<env>`。既に設定済みの
 * CONVERSATION_TABLE_NAME から apiId と env を取り出して他のモデルへ流用する
 * ——モデルごとに環境変数を増やすと、モデルを足すたびにAmplify Consoleの
 * 設定作業が要る(そして忘れる)。
 */
function tableSuffix(): string {
  const conv = process.env.CONVERSATION_TABLE_NAME;
  if (!conv) {
    throw new Error(
      "CONVERSATION_TABLE_NAME が未設定のため、テーブル名を組み立てられません(未認証経路のデータアクセスに必要)。",
    );
  }
  const m = conv.match(/^Conversation-(.+)$/);
  if (!m) throw new Error(`CONVERSATION_TABLE_NAME の形式が想定と違います: ${conv}`);
  return m[1];
}

function tableFor(model: string): string {
  return `${model}-${tableSuffix()}`;
}

/**
 * AmplifyのGSI名。`<複数形lowerCamel>By<Field>[And<Field>]` で生成される
 * (実測: messagesByConversationId / inventoriesByCategoryId /
 *  notificationDeliveriesByDedupeKey / inventoryHistoriesByInventoryIdAndChangedAt)。
 */
function pluralize(model: string): string {
  const lower = model.charAt(0).toLowerCase() + model.slice(1);
  // Inventory→inventories, Delivery→deliveries, History→histories
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  return `${lower}s`;
}

/**
 * 主キーが `id` ではないモデル(`.identifier([...])` を宣言しているもの)。
 *
 * これを持たないと update/delete が `id` を探して失敗する。実測で
 * amplify/data/resource.ts の `.identifier(` を洗い出したもの。
 * モデルを足すときはここも見る。
 */
const CUSTOM_IDENTIFIERS: Record<string, string> = {
  BaseItemCache: "baseItemId",
  BaseProductArchive: "baseItemId",
  SalesMonthlyAggregate: "yearMonth",
  ExternalResearchCache: "cacheKey",
};

function identifierFor(model: string): string {
  return CUSTOM_IDENTIFIERS[model] ?? "id";
}

let cached: DynamoDBDocumentClient | null = null;
function ddb(): DynamoDBDocumentClient {
  if (!cached) cached = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  return cached;
}

/* ══════════════════════════════════════════════════════════════════
 * フィルタ変換
 * ══════════════════════════════════════════════════════════════════ */

interface ExprParts {
  expr: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
}

/**
 * Amplifyの filter を DynamoDB の FilterExpression へ。
 *
 * 実際に使われている形だけを実装する: eq / ne / contains /
 * attributeExists / and / or。**それ以外は投げる** —— 黙って無視すると
 * 条件が緩くなり、関係ない行まで一致してしまう(誤った商品での返信につながる)。
 */
function buildFilter(filter: unknown, ctx: { n: number }): ExprParts | null {
  if (!filter || typeof filter !== "object") return null;
  const entries = Object.entries(filter as Record<string, unknown>);
  if (entries.length === 0) return null;

  const parts: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  for (const [key, cond] of entries) {
    if (key === "and" || key === "or") {
      if (!Array.isArray(cond)) throw new Error(`filter.${key} は配列である必要があります。`);
      const subs = cond.map((c) => buildFilter(c, ctx)).filter((p): p is ExprParts => p !== null);
      if (subs.length === 0) continue;
      for (const s of subs) {
        Object.assign(names, s.names);
        Object.assign(values, s.values);
      }
      parts.push(`(${subs.map((s) => s.expr).join(key === "and" ? " AND " : " OR ")})`);
      continue;
    }

    const nameKey = `#f${ctx.n}`;
    names[nameKey] = key;
    const c = cond as Record<string, unknown>;

    if ("eq" in c) {
      const v = `:v${ctx.n}`;
      values[v] = c.eq;
      parts.push(`${nameKey} = ${v}`);
    } else if ("ne" in c) {
      const v = `:v${ctx.n}`;
      values[v] = c.ne;
      parts.push(`${nameKey} <> ${v}`);
    } else if ("contains" in c) {
      const v = `:v${ctx.n}`;
      values[v] = c.contains;
      parts.push(`contains(${nameKey}, ${v})`);
    } else if ("attributeExists" in c) {
      parts.push(c.attributeExists ? `attribute_exists(${nameKey})` : `attribute_not_exists(${nameKey})`);
    } else {
      throw new Error(
        `未対応のフィルタ条件です(${key}: ${Object.keys(c).join(",")})。lib/amplify/directData.ts に実装を足してください。`,
      );
    }
    ctx.n++;
  }

  if (parts.length === 0) return null;
  return { expr: parts.join(" AND "), names, values };
}

function encodeToken(key: Record<string, unknown> | undefined): string | null {
  return key ? Buffer.from(JSON.stringify(key), "utf8").toString("base64") : null;
}
function decodeToken(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) return undefined;
  return JSON.parse(Buffer.from(token, "base64").toString("utf8")) as Record<string, unknown>;
}

/* ══════════════════════════════════════════════════════════════════
 * モデル操作
 * ══════════════════════════════════════════════════════════════════ */

type ListResult = { data: unknown[]; errors?: { message: string }[]; nextToken?: string | null };
type ItemResult = { data: unknown | null; errors?: { message: string }[] };

function nowIso(): string {
  return new Date().toISOString();
}

async function modelGet(model: string, key: Record<string, unknown>): Promise<ItemResult> {
  const res = await ddb().send(new GetCommand({ TableName: tableFor(model), Key: key }));
  return { data: res.Item ?? null };
}

/**
 * list。**Amplifyの limit は「絞り込み後に返す件数」**だが、DynamoDBの Limit は
 * 「絞り込み前に読む件数」。そのまま渡すと、条件に合う行があるのに空で返る。
 * 目的の件数が集まるまで内部でページを繰る。
 */
async function modelList(
  model: string,
  args: { filter?: unknown; limit?: number; nextToken?: string } = {},
): Promise<ListResult> {
  const limit = args.limit ?? 100;
  const built = buildFilter(args.filter, { n: 0 });
  const out: unknown[] = [];
  let key = decodeToken(args.nextToken);
  let pages = 0;

  do {
    const res: { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> } = await ddb().send(
      new ScanCommand({
        TableName: tableFor(model),
        ExclusiveStartKey: key,
        ...(built
          ? {
              FilterExpression: built.expr,
              ...(Object.keys(built.names).length > 0 ? { ExpressionAttributeNames: built.names } : {}),
              // 空の ExpressionAttributeValues は DynamoDB が拒否する
              // (ValidationException)。attribute_not_exists だけの条件
              // ——「削除されていない行」の絞り込みがまさにこれ——では
              // 値が1つも無いので、キーごと外す。
              ...(Object.keys(built.values).length > 0 ? { ExpressionAttributeValues: built.values } : {}),
            }
          : {}),
      }),
    );
    out.push(...(res.Items ?? []));
    key = res.LastEvaluatedKey;
    pages++;
    // 際限なくスキャンしない。全件スキャンは商品名照合で実際に使われるため、
    // 上限は大きめだが無限ではない。
    if (pages >= 100) break;
  } while (key && out.length < limit);

  // **切り詰めない。** limit を超えた分を捨てて nextToken だけ先へ進めると、
  // 捨てた行が二度と読まれない —— listAllPages で全件を集める呼び出し
  // (商品名照合の全在庫読み込み等)が、黙って一部を落とした集合を
  // 「全部」として返すことになる。多めに返るのは無害。
  return { data: out, nextToken: encodeToken(key) };
}

/** GSIでの絞り込み。`list<Model>By<Field>` から索引名とキー名を導く。 */
async function modelIndexQuery(
  model: string,
  methodName: string,
  keyArgs: Record<string, unknown>,
  args: { limit?: number; nextToken?: string } = {},
): Promise<ListResult> {
  const m = methodName.match(/^list[A-Za-z0-9]*?By([A-Za-z0-9]+)$/);
  if (!m) throw new Error(`索引クエリの名前を解釈できません: ${methodName}`);
  const indexName = `${pluralize(model)}By${m[1]}`;

  // キーは引数オブジェクトの中身をそのまま使う(ハッシュキーのみ対応)。
  const keyEntries = Object.entries(keyArgs).filter(([, v]) => v !== undefined && v !== null);
  if (keyEntries.length === 0) throw new Error(`索引クエリ ${methodName} にキーが渡されていません。`);
  const [hashKey, hashValue] = keyEntries[0];

  const limit = args.limit ?? 100;
  const out: unknown[] = [];
  let key = decodeToken(args.nextToken);
  let pages = 0;

  do {
    const res: { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> } = await ddb().send(
      new QueryCommand({
        TableName: tableFor(model),
        IndexName: indexName,
        KeyConditionExpression: "#k = :v",
        ExpressionAttributeNames: { "#k": hashKey },
        ExpressionAttributeValues: { ":v": hashValue },
        ExclusiveStartKey: key,
      }),
    );
    out.push(...(res.Items ?? []));
    key = res.LastEvaluatedKey;
    pages++;
    if (pages >= 100) break;
  } while (key && out.length < limit);

  // 切り詰めない理由は modelList と同じ。
  return { data: out, nextToken: encodeToken(key) };
}

async function modelCreate(model: string, input: Record<string, unknown>): Promise<ItemResult> {
  const now = nowIso();
  const idField = identifierFor(model);
  const item: Record<string, unknown> = {
    ...input,
    // **spread の後に置く。** 先に置くと、呼び出し側が `id: undefined` を
    // 明示的に含めていた場合に spread が上書きし、キーの無い行を書こうとして失敗する。
    [idField]:
      typeof input[idField] === "string" && input[idField] ? (input[idField] as string) : randomUUID(),
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    // AppSync経由で作った行と同じ形にする。__typename が無いと、
    // 後から画面(AppSync)で読んだときに型が解決できない。
    __typename: model,
  };
  // undefined は DynamoDB が受け付けない。AppSyncは省略として扱うので同じにする。
  for (const k of Object.keys(item)) if (item[k] === undefined) delete item[k];
  await ddb().send(new PutCommand({ TableName: tableFor(model), Item: item }));
  return { data: item };
}

/**
 * update の UpdateExpression を組み立てる。
 *
 * **純粋関数として切り出してある。** ここを間違えると DynamoDB が式全体を
 * 拒否し、その経路の書き込みが1つも通らなくなる。しかも呼び出し側は
 * try/catch で「取得できなかった」に丸めていることが多く、原因が
 * 「データが無い」と区別できない形で消える —— 実際にBASE商品照合が
 * それで壊れていた(下記 updatedAt の重複)。実機でしか気づけない形に
 * しないため、式の組み立てだけを単体で固定できるようにする。
 */
export function buildUpdateExpression(rest: Record<string, unknown>, updatedAtIso: string): {
  expression: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
} {
  const sets: string[] = [];
  const removes: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  let i = 0;
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) continue;
    // updatedAt は下で必ず設定する。ここでも通すと、同じ属性に別々の
    // プレースホルダが2つ割り当たり、DynamoDB が UpdateExpression 全体を
    // 拒否する(ValidationException: Two document paths overlap)。
    //
    // **その経路の書き込みが1つも通らなくなる**。実際、BASEのOAuthトークン
    // 更新が updatedAt を明示的に渡していたため、未認証経路からのBASE商品
    // 照合が常に失敗し、取り込み済み267件以外の商品を特定できなくなっていた。
    // 失敗は lookupBaseProduct の catch に吸われ、「商品が見つからない」と
    // 区別が付かない形で消えていた。
    //
    // AppSync も updatedAt はサーバ側で付け直すので、呼び出し側の値を
    // 捨てる方が本来の挙動に近い。
    if (k === "updatedAt") continue;
    const nk = `#u${i}`;
    names[nk] = k;
    if (v === null) {
      // null は「消す」。AppSyncのupdateでnullを渡したときと同じ意味にする。
      removes.push(nk);
    } else {
      const vk = `:u${i}`;
      values[vk] = v;
      sets.push(`${nk} = ${vk}`);
    }
    i++;
  }
  names["#ua"] = "updatedAt";
  values[":ua"] = updatedAtIso;
  sets.push("#ua = :ua");

  const expression = [
    sets.length > 0 ? `SET ${sets.join(", ")}` : "",
    removes.length > 0 ? `REMOVE ${removes.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return { expression, names, values };
}

async function modelUpdate(model: string, input: Record<string, unknown>): Promise<ItemResult> {
  const idField = identifierFor(model);
  const { [idField]: id, ...rest } = input;
  if (typeof id !== "string") throw new Error(`${model}.update には ${idField} が必要です。`);

  const { expression: expr, names, values } = buildUpdateExpression(rest, nowIso());


  try {
    const res = await ddb().send(
      new UpdateCommand({
        TableName: tableFor(model),
        Key: { [idField]: id },
        UpdateExpression: expr,
        // **存在しない行を作らない。**
        //
        // DynamoDB の UpdateItem は既定で upsert なので、条件を付けないと
        // 「無い行を update したら中途半端な行ができる」。AppSync の update は
        // 存在しない行に対しては失敗するので、そちらへ挙動を合わせる。
        //
        // 合わせないと実害がある: 1行だけの設定(AIReplySettings /
        // LineNotifySettings)は「まず update、駄目なら create」で書いており、
        // update が勝手に成功すると createdAt も __typename も無い行ができて、
        // 後から画面(AppSync)で読んだときに壊れる。
        ConditionExpression: `attribute_exists(#pk)`,
        ExpressionAttributeNames: { ...names, "#pk": idField },
        ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
        ReturnValues: "ALL_NEW",
      }),
    );
    return { data: res.Attributes ?? null };
  } catch (err) {
    // 行が無かった。呼び出し側(upsert)が create へ回れるよう null を返す。
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") return { data: null };
    throw err;
  }
}

async function modelDelete(model: string, key: Record<string, unknown>): Promise<ItemResult> {
  const res = await ddb().send(
    new DeleteCommand({ TableName: tableFor(model), Key: key, ReturnValues: "ALL_OLD" }),
  );
  return { data: res.Attributes ?? null };
}

/**
 * 1モデル分の操作。`get/list/create/update/delete` と `list<Model>By<Field>` を
 * Proxy で受ける。知らないメソッドは**投げる**。
 */
function modelProxy(model: string): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "get") return (key: Record<string, unknown>) => modelGet(model, key);
        if (prop === "list") return (args?: Record<string, unknown>) => modelList(model, args ?? {});
        if (prop === "create") return (input: Record<string, unknown>) => modelCreate(model, input);
        if (prop === "update") return (input: Record<string, unknown>) => modelUpdate(model, input);
        if (prop === "delete") return (key: Record<string, unknown>) => modelDelete(model, key);
        if (typeof prop === "string" && /^list[A-Za-z0-9]*By[A-Za-z0-9]+$/.test(prop)) {
          return (keyArgs: Record<string, unknown>, args?: Record<string, unknown>) =>
            modelIndexQuery(model, prop, keyArgs, args ?? {});
        }
        // then/Symbol系は Promise 判定などで触られるので undefined を返す。
        if (prop === "then" || typeof prop !== "string") return undefined;
        throw new Error(
          `未認証経路では ${model}.${prop} は使えません(lib/amplify/directData.ts が未実装)。実装を足すか、この処理を認証済み経路へ移してください。`,
        );
      },
    },
  ) as Record<string, unknown>;
}

/** `serverDataClient` と同じ形の、DynamoDB直結クライアント。 */
export function createDirectDataClient(): { models: Record<string, unknown> } {
  const cache = new Map<string, Record<string, unknown>>();
  return {
    models: new Proxy(
      {},
      {
        get(_t, model: string) {
          if (typeof model !== "string") return undefined;
          if (!cache.has(model)) cache.set(model, modelProxy(model));
          return cache.get(model);
        },
      },
    ) as Record<string, unknown>,
  };
}

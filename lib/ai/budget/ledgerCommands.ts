import { TransactWriteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { LedgerDeps } from "./ledgerClient";
import type {
  ReserveBudgetInput,
  ReserveBudgetResult,
  SettleReservationInput,
  SettleReservationResult,
} from "./types";

/**
 * Reused atomic reservation/settlement implementation from the existing BELLO budget candidate.
 * The C gateway uses integer 1/10000 JPY units and a fixed 300 JPY cap.
 * Each provider attempt gets a unique ID. Duplicate reservations never authorize another call.
 * Monthly baseline, spent, reserved, remaining and attempted-call count are updated atomically.
 * Ambiguous provider failures retain their reservation; only measured success is settled.
 * A recorded provider overrun is not clamped or hidden. Verified pricing and token bounds are
 * enforced by commonBudget.ts before this storage layer is called.
 */

/** 単発の予約1件が持てる上限(暴走防止。業務上の月次上限は呼び出し側が渡すcapで決める)。 */
export const MAX_RESERVATION_AMOUNT = 5_000_000;
/** 月次capの絶対上限(同じく暴走防止。実際の月次予算はこれよりずっと小さい値を渡す想定)。 */
export const MAX_LEDGER_CAP = 50_000_000;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function isPositiveInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n) && n > 0;
}

function isNonNegativeInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n) && n >= 0;
}

function invalidReserve(id: unknown, message: string): ReserveBudgetResult {
  return { ok: false, reason: "invalid_input", message, id: typeof id === "string" ? id : String(id ?? "") };
}

/** null=検査を通過。それ以外は即返してよい失敗結果。 */
function validateReserveInput(input: ReserveBudgetInput): ReserveBudgetResult | null {
  const { id, month, amount, cap } = input ?? ({} as ReserveBudgetInput);
  if (typeof id !== "string" || id.trim() === "") return invalidReserve(id, "idは空でない文字列が必要");
  if (typeof month !== "string" || !MONTH_RE.test(month)) return invalidReserve(id, `monthは"YYYY-MM"形式が必要: ${JSON.stringify(month)}`);
  if (!isPositiveInteger(amount)) return invalidReserve(id, `amountは有限の正整数が必要(NaN/負数/小数/Infinityは不可): ${JSON.stringify(amount)}`);
  if (!isPositiveInteger(cap)) return invalidReserve(id, `capは有限の正整数が必要(NaN/負数/小数/Infinityは不可): ${JSON.stringify(cap)}`);
  if (amount > MAX_RESERVATION_AMOUNT) return invalidReserve(id, `amount(${amount})が単発予約の絶対上限(${MAX_RESERVATION_AMOUNT})を超えている`);
  if (cap > MAX_LEDGER_CAP) return invalidReserve(id, `cap(${cap})が絶対上限(${MAX_LEDGER_CAP})を超えている`);
  if (amount > cap) return invalidReserve(id, `amount(${amount})がcap(${cap})を超えている(初回からの超過は許可しない)`);
  return null;
}

type CancellationReasonLike = { Code?: string; Message?: string };
function cancellationReasonsOf(err: unknown): CancellationReasonLike[] | null {
  const reasons = (err as { CancellationReasons?: CancellationReasonLike[] } | null | undefined)?.CancellationReasons;
  return Array.isArray(reasons) ? reasons : null;
}

/**
 * 予約と台帳の減算を1トランザクションで確定する。
 *
 * TransactItemsの順序は固定(0=予約行のPut, 1=台帳行のUpdate)。
 * classifyReserveFailureがこの順序に依存してCancellationReasonsを読む。
 */
export async function reserveBudget(deps: LedgerDeps, input: ReserveBudgetInput): Promise<ReserveBudgetResult> {
  const invalid = validateReserveInput(input);
  if (invalid) return invalid;
  const { id, month, amount, cap } = input;
  const priorSpent = input.priorSpent ?? 0;
  if (!isNonNegativeInteger(priorSpent) || priorSpent > cap || amount > cap - priorSpent) return invalidReserve(id, "既存利用額を含めた予算不足");
  const now = deps.now();
  const reservationTable = deps.tableFor("AIBudgetReservation");
  const ledgerTable = deps.tableFor("AIBudgetLedger");

  try {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: reservationTable,
              Item: { id, month, amount, actualAmount: null, status: "RESERVED", createdAt: now, updatedAt: now },
              ConditionExpression: "attribute_not_exists(id)",
            },
          },
          {
            Update: {
              TableName: ledgerTable,
              Key: { month },
              UpdateExpression: "SET remaining = if_not_exists(remaining, :initial) - :amount, cap = if_not_exists(cap, :cap), priorSpent = if_not_exists(priorSpent, :prior), spent = if_not_exists(spent, :prior), reserved = if_not_exists(reserved, :zero) + :amount, callCount = if_not_exists(callCount, :zero) + :one, updatedAt = :now",
              ConditionExpression: "(attribute_not_exists(remaining) OR remaining >= :amount) AND (attribute_not_exists(cap) OR cap = :cap) AND (attribute_not_exists(priorSpent) OR priorSpent = :prior)",
              ExpressionAttributeValues: { ":amount": amount, ":cap": cap, ":now": now, ":initial": cap - priorSpent, ":prior": priorSpent, ":zero": 0, ":one": 1 },
            },
          },
        ],
      }),
    );
    return { ok: true, id, month, amount };
  } catch (err) {
    return classifyReserveFailure(deps, err, { id, month, amount, cap, reservationTable, ledgerTable });
  }
}

async function classifyReserveFailure(
  deps: LedgerDeps,
  err: unknown,
  ctx: { id: string; month: string; amount: number; cap: number; reservationTable: string; ledgerTable: string },
): Promise<ReserveBudgetResult> {
  const reasons = cancellationReasonsOf(err);
  if (!reasons) throw err; // 条件チェック以外の失敗(権限不足・接続断等)は握りつぶさず投げる

  const [reservationReason, ledgerReason] = reasons;

  if (reservationReason?.Code === "ConditionalCheckFailed") {
    // 同一idが既に存在する。台帳の減算が実際に成功しているかに関わらず
    // 常にok:falseを返す(呼び出し側契約。冒頭コメント参照) —
    // ここでok:trueを返すと、確定前の予約を読んで生成を許可した
    // task_7c64の不具合を再現する。
    const existing = await deps.ddb.send(new GetCommand({ TableName: ctx.reservationTable, Key: { id: ctx.id } }));
    const item = existing.Item as { month?: unknown; amount?: unknown } | undefined;
    if (item && item.month === ctx.month && item.amount === ctx.amount) {
      return {
        ok: false,
        reason: "already_reserved",
        message: "同一id・同一month・同一amountの予約が既に存在する(新しいidを発行すること。既存予約の再利用は許可しない)",
        id: ctx.id,
        month: ctx.month,
        amount: ctx.amount,
      };
    }
    return {
      ok: false,
      reason: "id_conflict",
      message: `同一idに別のmonth/amountが指定された(既存: month=${String(item?.month)}, amount=${String(item?.amount)} / 要求: month=${ctx.month}, amount=${ctx.amount})`,
      id: ctx.id,
      month: ctx.month,
      amount: ctx.amount,
    };
  }

  if (ledgerReason?.Code === "ConditionalCheckFailed") {
    const existingLedger = await deps.ddb.send(new GetCommand({ TableName: ctx.ledgerTable, Key: { month: ctx.month } }));
    const ledgerItem = existingLedger.Item as { remaining?: unknown; cap?: unknown } | undefined;
    if (ledgerItem && typeof ledgerItem.cap === "number" && ledgerItem.cap !== ctx.cap) {
      return {
        ok: false,
        reason: "insufficient_budget",
        message: `当月のcapは最初のリクエストで${ledgerItem.cap}に固定されており、以後変更できない(要求されたcap=${ctx.cap})`,
        id: ctx.id,
        month: ctx.month,
        amount: ctx.amount,
      };
    }
    return {
      ok: false,
      reason: "insufficient_budget",
      message: `当月の残り予算(${String(ledgerItem?.remaining)})がamount(${ctx.amount})に満たない`,
      id: ctx.id,
      month: ctx.month,
      amount: ctx.amount,
    };
  }

  return {
    ok: false,
    reason: "transaction_canceled",
    message: `予約トランザクションが中断された: ${reasons.map((r) => r?.Code ?? "None").join(",")}`,
    id: ctx.id,
    month: ctx.month,
    amount: ctx.amount,
  };
}

/** 予約idの現在の状態を読むだけの読み取り専用ヘルパー。予約は作らない。 */
export async function getReservationStatus(
  deps: LedgerDeps,
  id: string,
): Promise<{ found: false } | { found: true; record: Record<string, unknown> }> {
  const res = await deps.ddb.send(new GetCommand({ TableName: deps.tableFor("AIBudgetReservation"), Key: { id }, ConsistentRead: true }));
  if (!res.Item) return { found: false };
  return { found: true, record: res.Item as Record<string, unknown> };
}

/**
 * 予約を確定する。actualAmountが予約額(amount)と異なる場合、その差分だけ
 * 台帳のremainingを調整する(actualAmount < amountなら返金、
 * actualAmount > amountならさらに減算 — その結果remainingが負になっても
 * そのまま記録する。上限超過を隠さないため)。actualAmount === 0は
 * 「全額返金してCANCELLED」として扱う(生成が失敗し課金が発生しなかった
 * 場合の呼び出し方)。
 *
 * 予約行のステータス変更(RESERVED→CONFIRMED/CANCELLED)と台帳の調整は
 * reserveBudgetと同じくTransactWriteItemsで同時に確定する。
 *
 * 冪等: 既にCONFIRMED/CANCELLEDの予約に対して**同じ**actualAmountで
 * 呼び出すとok:true(no-op、再送に耐える)。**違う**actualAmountで
 * 呼び出すとok:false(already_settled_mismatch) — 実際に何が起きたか
 * 分からないまま台帳を二重に動かさない。
 *
 * TOCTOU対策: 予約行を読んでから確定トランザクションを投げるまでの間に
 * 別プロセスが同じidを先に確定させた場合、トランザクションの
 * ConditionExpression(status=RESERVED)が失敗する。その場合は状態を
 * 読み直して最初から判定をやり直す(最大3回)。
 */
export async function settleReservation(deps: LedgerDeps, input: SettleReservationInput): Promise<SettleReservationResult> {
  const { id, actualAmount } = input ?? ({} as SettleReservationInput);
  if (typeof id !== "string" || id.trim() === "") {
    return { ok: false, reason: "invalid_input", message: "idは空でない文字列が必要", id: typeof id === "string" ? id : String(id ?? "") };
  }
  if (!isNonNegativeInteger(actualAmount)) {
    return { ok: false, reason: "invalid_input", message: `actualAmountは0以上の有限整数が必要(NaN/負数/小数/Infinityは不可): ${JSON.stringify(actualAmount)}`, id };
  }

  const reservationTable = deps.tableFor("AIBudgetReservation");
  const ledgerTable = deps.tableFor("AIBudgetLedger");

  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await deps.ddb.send(new GetCommand({ TableName: reservationTable, Key: { id }, ConsistentRead: true }));
    const item = existing.Item as
      | { month?: unknown; amount?: unknown; status?: unknown; actualAmount?: unknown }
      | undefined;
    if (!item) return { ok: false, reason: "not_found", message: `予約id=${id}が存在しない`, id };

    if (item.status === "CONFIRMED" || item.status === "CANCELLED") {
      if (item.actualAmount === actualAmount && typeof item.amount === "number") {
        return { ok: true, id, actualAmount, refunded: item.amount - actualAmount };
      }
      return {
        ok: false,
        reason: "already_settled_mismatch",
        message: `既にstatus=${String(item.status)}(actualAmount=${String(item.actualAmount)})で確定済み。異なるactualAmount(${actualAmount})での再確定は拒否する`,
        id,
      };
    }

    if (item.status !== "RESERVED" || typeof item.amount !== "number" || typeof item.month !== "string") {
      return { ok: false, reason: "not_found", message: `予約id=${id}の状態が不正: ${JSON.stringify(item)}`, id };
    }

    const reservedAmount = item.amount;
    const month = item.month;
    const delta = actualAmount - reservedAmount; // 正なら追加消費、負なら返金
    const newStatus = actualAmount === 0 ? "CANCELLED" : "CONFIRMED";
    const now = deps.now();

    try {
      await deps.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: reservationTable,
                Key: { id },
                UpdateExpression: "SET #status = :newStatus, actualAmount = :actualAmount, updatedAt = :now",
                ConditionExpression: "#status = :expectedStatus",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":newStatus": newStatus,
                  ":actualAmount": actualAmount,
                  ":now": now,
                  ":expectedStatus": "RESERVED",
                },
              },
            },
            {
              Update: {
                TableName: ledgerTable,
                Key: { month },
                UpdateExpression: "SET remaining = remaining - :delta, reserved = reserved - :reserved, spent = spent + :actual, updatedAt = :now",
                ConditionExpression: "attribute_exists(remaining)",
                ExpressionAttributeValues: { ":delta": delta, ":now": now, ":reserved": reservedAmount, ":actual": actualAmount },
              },
            },
          ],
        }),
      );
      return { ok: true, id, actualAmount, refunded: reservedAmount - actualAmount };
    } catch (err) {
      const reasons = cancellationReasonsOf(err);
      if (!reasons) throw err;
      const [reservationReason] = reasons;
      if (reservationReason?.Code === "ConditionalCheckFailed") {
        // 直前のGetCommandとTransactWriteの間に別プロセスが確定させた。
        // 読み直して最初から判定をやり直す(冪等な合流)。
        continue;
      }
      return {
        ok: false,
        reason: "transaction_canceled",
        message: `確定トランザクションが中断された: ${reasons.map((r) => r?.Code ?? "None").join(",")}`,
        id,
      };
    }
  }

  return {
    ok: false,
    reason: "transaction_canceled",
    message: "確定処理が競合により3回とも完了しなかった(通常起きない頻度の同時確定)",
    id,
  };
}

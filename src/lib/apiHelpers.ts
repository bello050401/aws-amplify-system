import { NextResponse } from "next/server";
import { ZodError } from "zod";

/** APIルート共通のエラーハンドリング。GraphQLエラー等を握り潰さずクライアントへ伝える。 */
export function errorResponse(err: unknown, fallbackStatus = 400) {
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: "入力値が不正です。", details: err.flatten() },
      { status: 422 },
    );
  }
  const message = err instanceof Error ? err.message : "予期しないエラーが発生しました。";
  console.error(err);
  return NextResponse.json({ error: message }, { status: fallbackStatus });
}

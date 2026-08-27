import { prisma } from "@/lib/prisma";

type LogLevel = "INFO" | "ERROR";

interface LogParams {
  productId?: string | null;
  operation: string;
  message: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  requestId?: string | null;
}

/**
 * /logs 画面に表示するAPI操作ログを記録する。
 * 呼び出し側は絶対にアクセストークン等の機密情報を message / errorMessage に含めないこと
 * （指示書39, 40項）。
 */
async function write(level: LogLevel, params: LogParams) {
  try {
    await prisma.integrationLog.create({
      data: {
        productId: params.productId ?? null,
        operation: params.operation,
        level,
        message: params.message,
        errorCode: params.errorCode ?? null,
        errorMessage: params.errorMessage ?? null,
        requestId: params.requestId ?? null,
      },
    });
  } catch (err) {
    // ログ保存自体の失敗でメイン処理を止めない。コンソールにのみ出す。
    console.error("[IntegrationLog] failed to persist log entry", err);
  }
}

export const integrationLogger = {
  info: (params: LogParams) => write("INFO", params),
  error: (params: LogParams) => write("ERROR", params),
};

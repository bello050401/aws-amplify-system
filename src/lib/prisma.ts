import { PrismaClient } from "@prisma/client";

// Next.js の開発モードでのホットリロード時に PrismaClient が
// 何度も生成されてコネクションを使い切らないよう、globalThisにキャッシュする。
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

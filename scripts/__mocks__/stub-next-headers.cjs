// scripts/verify-listings-overview-service-boundary.ts 専用スタブ。
// lib/listing/mercari/adapter.ts が`import { cookies } from "next/headers"`
// するが、この検証は実際にMercariへ出品する経路を一切呼ばない——
// モジュール解決を通すためだけの空実装。呼ばれたら分かるようthrowする。
module.exports = {
  cookies: () => {
    throw new Error("[stub-next-headers] cookies() was called but this test never expects it to run");
  },
};

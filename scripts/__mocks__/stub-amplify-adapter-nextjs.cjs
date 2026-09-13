// scripts/verify-listings-overview-service-boundary.ts 専用スタブ。
// lib/amplify/serverUtils.ts(mercari/adapter.ts経由、publish専用)が
// runWithAmplifyServerContextで使うが、この検証は一切呼ばない。
module.exports = {
  createServerRunner: () => ({
    runWithAmplifyServerContext: () => {
      throw new Error("[stub-amplify-adapter-nextjs] runWithAmplifyServerContext was called but this test never expects it to run");
    },
  }),
};

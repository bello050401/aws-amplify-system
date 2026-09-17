#!/usr/bin/env node
// PhotoStation.Tests専用のスタブ。本物のtools/bello-photo-station/src/cli.mjsとは
// 独立に、C#側(NodeCliPipelineRunner)のサブプロセス配線 —
// 標準出力の行単位status読み取り・RESULT_JSON:解析・非ゼロ終了コード・
// トークンが環境変数で渡ること — をsharp等の外部依存なしで検証できるようにする。
if (!process.env.BELLO_PHOTO_STATION_TOKEN) {
  console.error("BELLO_PHOTO_STATION_TOKEN environment variable is required");
  process.exitCode = 1;
} else {
  console.log("編集中");
  console.log("編集完了");
  console.log("アップロード中");

  const mode = process.env.BELLO_FAKE_CLI_MODE ?? "COMPLETE";
  if (mode === "CRASH") {
    console.error("fake crash");
    process.exitCode = 1;
  } else {
    const result =
      mode === "PARTIAL"
        ? {
            status: "PARTIAL",
            batchId: "b1",
            batchCode: "PB-1",
            uploaded: [{ fileName: "a.jpg" }],
            editFailures: [],
            uploadFailures: [{ clientAssetId: "2", fileName: "b.jpg", stage: "UPLOAD", message: "network error" }],
          }
        : {
            status: "COMPLETE",
            batchId: "b1",
            batchCode: "PB-1",
            uploaded: [{ fileName: "a.jpg" }, { fileName: "b.jpg" }],
            editFailures: [],
            uploadFailures: [],
          };
    console.log(`RESULT_JSON:${JSON.stringify(result)}`);
    if (result.status !== "COMPLETE") process.exitCode = 1;
  }
}

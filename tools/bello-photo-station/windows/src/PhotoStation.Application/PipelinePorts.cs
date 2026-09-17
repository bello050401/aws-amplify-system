namespace PhotoStation.Application;

public sealed record PipelineFailure(string ClientAssetId, string FileName, string Stage, string Message);

/// <summary>
/// tools/bello-photo-station/src/cli.mjs が標準出力の最終行 (`RESULT_JSON:` 接頭辞)
/// へ書き出す結果と1:1対応する。Status は "COMPLETE" | "PARTIAL" | "FAILED" | "NO_ASSETS"。
/// </summary>
public sealed record PipelineResult(
    string Status,
    string? BatchId,
    string? BatchCode,
    IReadOnlyList<string> UploadedFileNames,
    IReadOnlyList<PipelineFailure> EditFailures,
    IReadOnlyList<PipelineFailure> UploadFailures);

public sealed record PipelineRequest(
    string SessionId,
    string SourceDir,
    string OutputRoot,
    string SettingsFile,
    string HistoryFile,
    string DeviceId,
    string ApiEndpoint,
    string? SdCardId = null);

/// <summary>
/// 設定読込→一括編集→検証環境へのアップロードまでを1セッション分実行する。
/// 実装(NodeCliPipelineRunner)はcli.mjsをサブプロセス起動するだけで、画像処理・
/// HTTP送信ロジック自体はNode側にとどめる(二重実装しない)。
/// </summary>
public interface IPhotoPipelineRunner
{
    Task<PipelineResult> RunAsync(PipelineRequest request, Action<string> onStatus, CancellationToken cancellationToken = default);
}

/// <summary>
/// 認証トークンの受け渡し口。固定値をコードに埋め込まず、環境変数などの
/// 呼出側の短期tokenソースからのみ取得する(cli.mjsのtokenProviderと同じ方針)。
/// </summary>
public interface ITokenProvider
{
    string? GetToken();
}

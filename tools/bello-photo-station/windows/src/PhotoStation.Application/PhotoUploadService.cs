using PhotoStation.Domain;

namespace PhotoStation.Application;

public sealed record PhotoUploadRequest(
    string SessionId,
    string SourceDir,
    string OutputRoot,
    string SettingsFile,
    string HistoryFile,
    string DeviceId,
    string ApiEndpoint,
    string? SdCardId = null)
{
    public PipelineRequest ToPipelineRequest() =>
        new(SessionId, SourceDir, OutputRoot, SettingsFile, HistoryFile, DeviceId, ApiEndpoint, SdCardId);
}

public sealed record UploadOutcome(ImportSessionState State, PipelineResult? Pipeline, string? Error);

/// <summary>
/// LocalSecuredになったセッションを「設定読込→一括編集→検証環境へアップロード→
/// 履歴保存」まで運ぶ。実処理(画像編集・HTTP送信)はIPhotoPipelineRunnerへ委譲し
/// (実装はcli.mjsサブプロセス呼び出し)、このクラス自身はImportSessionの状態遷移だけを
/// 責務にする。失敗時はNeedsReviewへ落として、原本(sourceフォルダ)には一切触れずに
/// 再実行できる状態を保つ。
/// </summary>
public sealed class PhotoUploadService(IStationRepository repository, IPhotoPipelineRunner runner)
{
    public async Task<UploadOutcome> UploadAsync(PhotoUploadRequest request, Action<string> onStatus, CancellationToken cancellationToken = default)
    {
        var sessionId = Guid.Parse(request.SessionId);
        var session = await repository.FindSessionAsync(sessionId, cancellationToken)
            ?? throw new InvalidOperationException("Unknown import session: " + request.SessionId);
        if (session.State != ImportSessionState.LocalSecured)
            throw new InvalidOperationException($"Session must be LocalSecured before upload, was {session.State}");

        session.TransitionTo(ImportSessionState.Rendering);
        await repository.SaveSessionAsync(session, cancellationToken);
        session.TransitionTo(ImportSessionState.Processing);
        await repository.SaveSessionAsync(session, cancellationToken);

        PipelineResult result;
        try
        {
            result = await runner.RunAsync(request.ToPipelineRequest(), onStatus, cancellationToken);
        }
        catch (Exception error)
        {
            session.TransitionTo(ImportSessionState.NeedsReview, error.Message);
            await repository.SaveSessionAsync(session, cancellationToken);
            return new UploadOutcome(session.State, null, error.Message);
        }

        if (result.Status is "FAILED" or "NO_ASSETS")
        {
            session.TransitionTo(ImportSessionState.NeedsReview, $"pipeline status {result.Status}");
            await repository.SaveSessionAsync(session, cancellationToken);
            return new UploadOutcome(session.State, result, null);
        }

        session.TransitionTo(ImportSessionState.ReadyToUpload);
        await repository.SaveSessionAsync(session, cancellationToken);
        session.TransitionTo(ImportSessionState.Uploading);
        await repository.SaveSessionAsync(session, cancellationToken);

        if (result.Status == "PARTIAL")
        {
            session.TransitionTo(ImportSessionState.NeedsReview, "一部の画像でアップロードに失敗しました。原本は保持したまま再実行できます。");
            await repository.SaveSessionAsync(session, cancellationToken);
            return new UploadOutcome(session.State, result, null);
        }

        session.TransitionTo(ImportSessionState.CloudVerifying);
        await repository.SaveSessionAsync(session, cancellationToken);
        return new UploadOutcome(session.State, result, null);
    }
}

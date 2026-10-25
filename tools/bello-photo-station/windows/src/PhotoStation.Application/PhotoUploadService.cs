using PhotoStation.Domain;
using System.Text.Json;

namespace PhotoStation.Application;

public sealed record PhotoUploadRequest(
    string SessionId,
    string SourceDir,
    string OutputRoot,
    string SettingsFile,
    string HistoryFile,
    string DeviceId,
    string ApiEndpoint,
    string? SdCardId = null,
    string Destination = "web",
    string? ExportDirectory = null)
{
    public PipelineRequest ToPipelineRequest() =>
        new(SessionId, SourceDir, OutputRoot, SettingsFile, HistoryFile, DeviceId, ApiEndpoint, SdCardId, Destination, ExportDirectory);
}

public sealed record UploadOutcome(ImportSessionState State, PipelineResult? Pipeline, string? Error);

public static class PhotoEndpointSafety
{
    // This desktop validation build may send photos only to the isolated
    // CloudFormation stack, never to an arbitrary configured API host.
    public static bool IsAllowedValidationEndpoint(string? value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && uri.Scheme == Uri.UriSchemeHttps
        && uri.Host.Equals("dq30ujzf5d.execute-api.us-west-2.amazonaws.com", StringComparison.OrdinalIgnoreCase)
        && uri.IsDefaultPort && string.IsNullOrEmpty(uri.UserInfo)
        && uri.AbsolutePath == "/" && string.IsNullOrEmpty(uri.Query) && string.IsNullOrEmpty(uri.Fragment);

    public static bool HasUsableValidationToken(string? token, DateTimeOffset now)
    {
        if (string.IsNullOrWhiteSpace(token)) return false;
        var parts = token.Split('.');
        if (parts.Length != 3) return false;
        try
        {
            var payload = parts[1].Replace('-', '+').Replace('_', '/');
            payload = payload.PadRight((payload.Length + 3) / 4 * 4, '=');
            using var document = JsonDocument.Parse(Convert.FromBase64String(payload));
            var root = document.RootElement;
            return root.TryGetProperty("exp", out var exp) && exp.TryGetInt64(out var expiry)
                && expiry > now.AddMinutes(2).ToUnixTimeSeconds()
                && root.TryGetProperty("iss", out var issuer)
                && issuer.GetString() == "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_bKfdql8QT"
                && root.TryGetProperty("aud", out var audience) && audience.GetString() == "3nm24ejtua3inrg0sdmpbn2vqs"
                && root.TryGetProperty("token_use", out var use) && use.GetString() == "id"
                && root.TryGetProperty("cognito:groups", out var groups)
                && groups.ValueKind == JsonValueKind.Array
                && groups.EnumerateArray().Any(group => group.GetString() == "PHOTO_DEVICE");
        }
        catch (Exception error) when (error is FormatException or JsonException or InvalidOperationException) { return false; }
    }
}

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
        if (request.Destination is not ("web" or "pc" or "shared")) throw new ArgumentException("保存先の種類が不正です");
        if (request.Destination != "web" && string.IsNullOrWhiteSpace(request.ExportDirectory)) throw new ArgumentException("保存先フォルダーを選択してください");
        if (session.State is not (ImportSessionState.LocalSecured or ImportSessionState.NeedsReview or ImportSessionState.LocalSaved))
            throw new InvalidOperationException($"Session must be LocalSecured or NeedsReview before upload, was {session.State}");

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

        if (result.Status == "SAVED_LOCAL" && request.Destination != "web" && !string.IsNullOrWhiteSpace(result.SavedDirectory))
        {
            session.TransitionTo(ImportSessionState.LocalSaved);
            await repository.SaveSessionAsync(session, cancellationToken);
            return new UploadOutcome(session.State, result, null);
        }
        if (result.Status is not ("COMPLETE" or "PARTIAL") || request.Destination != "web")
        {
            var reason = result.EditFailures.FirstOrDefault()?.Message
                ?? result.UploadFailures.FirstOrDefault()?.Message
                ?? $"pipeline status {result.Status}";
            session.TransitionTo(ImportSessionState.NeedsReview, reason);
            await repository.SaveSessionAsync(session, cancellationToken);
            return new UploadOutcome(session.State, result, reason);
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

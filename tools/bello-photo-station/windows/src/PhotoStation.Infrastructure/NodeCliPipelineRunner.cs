using System.Diagnostics;
using System.Text;
using System.Text.Json;
using PhotoStation.Application;

namespace PhotoStation.Infrastructure;

/// <summary>
/// PhotoUploadServiceの実処理を tools/bello-photo-station/src/cli.mjs へ委譲する。
/// 画像処理・HTTP送信ロジックはNode側にとどめ、ここでは `node` のサブプロセスを
/// 起動して標準出力を橋渡しするだけにする。標準出力の最終行(`RESULT_JSON:` 接頭辞)
/// だけを構造化結果として解析し、それ以外の行はonStatusへそのまま流す(利用者向けの
/// 進捗表示)。認証トークンは子プロセスの環境変数としてのみ渡し、引数・ログには出さない。
/// </summary>
public sealed class NodeCliPipelineRunner(string nodeExecutablePath, string cliScriptPath, ITokenProvider tokenProvider) : IPhotoPipelineRunner
{
    private const string ResultPrefix = "RESULT_JSON:";
    private const string TokenEnvironmentVariable = "BELLO_PHOTO_STATION_TOKEN";

    public async Task<PipelineResult> RunAsync(PipelineRequest request, Action<string> onStatus, CancellationToken cancellationToken = default)
    {
        var token = tokenProvider.GetToken();
        if (string.IsNullOrWhiteSpace(token))
            throw new InvalidOperationException($"{TokenEnvironmentVariable} environment variable is required");

        var startInfo = new ProcessStartInfo(nodeExecutablePath)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add(cliScriptPath);
        AddArg(startInfo, "--session-id", request.SessionId);
        AddArg(startInfo, "--source-dir", request.SourceDir);
        AddArg(startInfo, "--output-root", request.OutputRoot);
        AddArg(startInfo, "--settings-file", request.SettingsFile);
        AddArg(startInfo, "--history-file", request.HistoryFile);
        AddArg(startInfo, "--device-id", request.DeviceId);
        AddArg(startInfo, "--api-endpoint", request.ApiEndpoint);
        if (!string.IsNullOrWhiteSpace(request.SdCardId)) AddArg(startInfo, "--sd-card-id", request.SdCardId);
        startInfo.Environment[TokenEnvironmentVariable] = token;

        using var process = new Process { StartInfo = startInfo };
        PipelineResult? result = null;
        var stderr = new StringBuilder();
        process.OutputDataReceived += (_, e) =>
        {
            if (e.Data is null) return;
            if (e.Data.StartsWith(ResultPrefix, StringComparison.Ordinal)) result = ParseResult(e.Data[ResultPrefix.Length..]);
            else onStatus(e.Data);
        };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) stderr.AppendLine(e.Data); };

        if (!process.Start()) throw new InvalidOperationException("Failed to start the edit/upload pipeline process");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        await process.WaitForExitAsync(cancellationToken);

        if (result is not null) return result;
        var detail = stderr.Length > 0 ? stderr.ToString().Trim() : $"exit code {process.ExitCode}";
        throw new InvalidOperationException($"The edit/upload pipeline exited without a result ({detail})");
    }

    private static void AddArg(ProcessStartInfo startInfo, string name, string value)
    {
        startInfo.ArgumentList.Add(name);
        startInfo.ArgumentList.Add(value);
    }

    private static PipelineResult ParseResult(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        return new PipelineResult(
            root.GetProperty("status").GetString() ?? "FAILED",
            GetOptionalString(root, "batchId"),
            GetOptionalString(root, "batchCode"),
            ReadFileNames(root, "uploaded"),
            ReadFailures(root, "editFailures"),
            ReadFailures(root, "uploadFailures"));
    }

    private static string? GetOptionalString(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static IReadOnlyList<string> ReadFileNames(JsonElement root, string property)
    {
        if (!root.TryGetProperty(property, out var array) || array.ValueKind != JsonValueKind.Array) return [];
        var list = new List<string>();
        foreach (var item in array.EnumerateArray())
            if (GetOptionalString(item, "fileName") is { } fileName) list.Add(fileName);
        return list;
    }

    private static IReadOnlyList<PipelineFailure> ReadFailures(JsonElement root, string property)
    {
        if (!root.TryGetProperty(property, out var array) || array.ValueKind != JsonValueKind.Array) return [];
        var list = new List<PipelineFailure>();
        foreach (var item in array.EnumerateArray())
            list.Add(new PipelineFailure(
                GetOptionalString(item, "clientAssetId") ?? "",
                GetOptionalString(item, "fileName") ?? "",
                GetOptionalString(item, "stage") ?? "",
                GetOptionalString(item, "message") ?? ""));
        return list;
    }
}

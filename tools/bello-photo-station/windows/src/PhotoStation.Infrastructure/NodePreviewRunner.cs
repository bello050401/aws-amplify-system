using System.Diagnostics;
using System.Text;
using System.Text.Json;
using PhotoStation.Application;
using PhotoStation.Domain;

namespace PhotoStation.Infrastructure;

/// <summary>
/// 設定画面の「テスト画像1枚によるプレビュー」を tools/bello-photo-station/src/previewCli.mjs
/// へ委譲する。保存前の編集中設定をそのまま試せるよう、--settings-jsonへ直接渡す
/// (設定ファイルへは書き込まない)。
/// </summary>
public sealed class NodePreviewRunner(string nodeExecutablePath, string previewScriptPath) : IPreviewRunner
{
    private const string ResultPrefix = "RESULT_JSON:";
    private static readonly JsonSerializerOptions SerializeOptions = new(JsonSerializerDefaults.Web);

    public async Task<PreviewResult> RunAsync(string sourceImagePath, EditSettings settings, string outputDir, CancellationToken cancellationToken = default)
    {
        var startInfo = new ProcessStartInfo(nodeExecutablePath)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add(previewScriptPath);
        startInfo.ArgumentList.Add("--source");
        startInfo.ArgumentList.Add(sourceImagePath);
        startInfo.ArgumentList.Add("--output-dir");
        startInfo.ArgumentList.Add(outputDir);
        startInfo.ArgumentList.Add("--settings-json");
        startInfo.ArgumentList.Add(JsonSerializer.Serialize(settings, SerializeOptions));

        using var process = new Process { StartInfo = startInfo };
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) stdout.AppendLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) stderr.AppendLine(e.Data); };

        if (!process.Start()) throw new InvalidOperationException("Failed to start the preview process");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        await process.WaitForExitAsync(cancellationToken);

        var resultLine = stdout.ToString()
            .Split('\n')
            .Select(line => line.TrimEnd('\r'))
            .FirstOrDefault(line => line.StartsWith(ResultPrefix, StringComparison.Ordinal));
        if (resultLine is null)
        {
            var detail = stderr.Length > 0 ? stderr.ToString().Trim() : $"exit code {process.ExitCode}";
            throw new InvalidOperationException($"Preview did not produce a result ({detail})");
        }

        using var document = JsonDocument.Parse(resultLine[ResultPrefix.Length..]);
        var root = document.RootElement;
        var processed = root.GetProperty("processed");
        return new PreviewResult(
            root.GetProperty("sourcePath").GetString()!,
            processed.GetProperty("path").GetString()!,
            root.GetProperty("thumbnail").GetProperty("path").GetString()!,
            processed.GetProperty("width").GetInt32(),
            processed.GetProperty("height").GetInt32());
    }
}

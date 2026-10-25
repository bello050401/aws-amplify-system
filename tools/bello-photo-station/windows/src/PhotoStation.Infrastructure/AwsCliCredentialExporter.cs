using System.Diagnostics;
using System.Text;
using System.Text.Json;
using PhotoStation.Application;

namespace PhotoStation.Infrastructure;

/// <summary>
/// `aws configure export-credentials --profile &lt;profile&gt; --format process` を
/// サブプロセスで実行し、標準出力のJSONだけを読む。実行ファイル名と先頭引数は
/// NodeCliPipelineRunnerと同じ形でテストから差し替えられる。Cognitoの検証用
/// ユーザーパスワードはこのクラスに一切渡らない — 扱うのはAWSの短期アクセス
/// キーだけで、それも標準出力をそのまま解析するだけでログには出さない。
/// </summary>
public sealed class AwsCliCredentialExporter(string executable = "aws", IReadOnlyList<string>? argumentPrefix = null) : IAwsCredentialExporter
{
    public async Task<AwsTemporaryCredentials> ExportAsync(string profile, CancellationToken cancellationToken = default)
    {
        var startInfo = new ProcessStartInfo(executable)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in argumentPrefix ?? []) startInfo.ArgumentList.Add(arg);
        foreach (var arg in new[] { "configure", "export-credentials", "--profile", profile, "--format", "process" })
            startInfo.ArgumentList.Add(arg);

        using var process = new Process { StartInfo = startInfo };
        if (!process.Start()) throw new InvalidOperationException("Failed to start the AWS CLI credential export process");
        var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken);
        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"AWS CLI could not export credentials for profile '{profile}' (exit {process.ExitCode}): {stderr.Trim()}");

        using var document = JsonDocument.Parse(stdout);
        var root = document.RootElement;
        var accessKeyId = root.TryGetProperty("AccessKeyId", out var accessKeyIdValue) ? accessKeyIdValue.GetString() : null;
        var secretAccessKey = root.TryGetProperty("SecretAccessKey", out var secretAccessKeyValue) ? secretAccessKeyValue.GetString() : null;
        if (string.IsNullOrEmpty(accessKeyId) || string.IsNullOrEmpty(secretAccessKey))
            throw new InvalidOperationException($"AWS CLI credential export for profile '{profile}' did not return AccessKeyId/SecretAccessKey");
        var sessionToken = root.TryGetProperty("SessionToken", out var sessionTokenValue) ? sessionTokenValue.GetString() : null;
        DateTimeOffset? expiration = root.TryGetProperty("Expiration", out var expirationValue)
            && expirationValue.ValueKind == JsonValueKind.String
            && DateTimeOffset.TryParse(expirationValue.GetString(), out var parsedExpiration) ? parsedExpiration : null;
        return new AwsTemporaryCredentials(accessKeyId, secretAccessKey, sessionToken, expiration);
    }
}

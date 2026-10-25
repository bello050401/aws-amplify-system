using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace PhotoStation.Infrastructure;

public sealed class PresetWorkflowRunner(string node, string script, string root)
{
    public async Task<JsonElement> RunAsync(string command, IEnumerable<string> arguments, Action<string>? progress = null, CancellationToken cancellationToken = default)
    {
        var start = new ProcessStartInfo(node) { UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
        start.ArgumentList.Add(script); start.ArgumentList.Add(command); start.ArgumentList.Add(root);
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("比較処理を開始できませんでした");
        using var cancellation = cancellationToken.Register(() => { try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { } });
        var errorTask = process.StandardError.ReadToEndAsync(cancellationToken);
        string? result = null;
        while (await process.StandardOutput.ReadLineAsync(cancellationToken) is { } line)
        {
            if (line.StartsWith("RESULT_JSON:")) result = line[12..];
            else progress?.Invoke(line);
        }
        await process.WaitForExitAsync(cancellationToken);
        var error = await errorTask;
        if (process.ExitCode != 0 || result is null) throw new InvalidOperationException(string.IsNullOrWhiteSpace(error) ? "比較処理が完了しませんでした" : error.Trim());
        using var doc = JsonDocument.Parse(result);
        return doc.RootElement.Clone();
    }
}

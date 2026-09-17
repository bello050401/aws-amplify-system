using PhotoStation.Domain;
using PhotoStation.Infrastructure;

namespace PhotoStation.Tests;

/// <summary>
/// fixtures/fake-preview.mjs に対して実際に `node` サブプロセスを起動し、
/// NodePreviewRunnerが設定をJSONで渡し、RESULT_JSON:を正しく解析できることを
/// 検証する(本物のpreviewCli.mjs自体の画像処理はsharpに依存するため、そちらは
/// tools/bello-photo-station/test配下のNodeテストが担う)。
/// </summary>
public sealed class NodePreviewRunnerTests
{
    private static string FixtureScriptPath() => Path.Combine(AppContext.BaseDirectory, "fixtures", "fake-preview.mjs");

    [Fact]
    public async Task PassesSettingsAsJsonAndParsesTheResult()
    {
        var runner = new NodePreviewRunner("node", FixtureScriptPath());
        var settings = EditSettings.Default with { LongEdgePx = 1200, ThumbnailLongEdgePx = 240 };

        var result = await runner.RunAsync("C:/source.jpg", settings, "C:/out");

        Assert.Equal("C:/source.jpg", result.SourcePath);
        Assert.Equal(1200, result.ProcessedWidth);
        Assert.Equal(600, result.ProcessedHeight);
        Assert.Contains("preview-processed.jpg", result.ProcessedPath);
        Assert.Contains("preview-thumbnail.jpg", result.ThumbnailPath);
    }

    [Fact]
    public async Task ThrowsWithDetailWhenRequiredArgumentsAreRejected()
    {
        var runner = new NodePreviewRunner("node", FixtureScriptPath());
        // previewCli.mjs/fake-preview.mjsはどちらも --source を必須とする。
        var error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => runner.RunAsync("", EditSettings.Default, "C:/out"));
        Assert.Contains("missing required arguments", error.Message);
    }
}

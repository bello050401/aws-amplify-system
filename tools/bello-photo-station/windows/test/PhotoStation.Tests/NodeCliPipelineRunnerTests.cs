using PhotoStation.Application;
using PhotoStation.Infrastructure;

namespace PhotoStation.Tests;

/// <summary>
/// fixtures/fake-cli.mjs (sharp等の外部依存を持たないスタブ) に対して実際に
/// `node` サブプロセスを起動し、NodeCliPipelineRunnerの配線 — 標準出力の
/// RESULT_JSON:解析・status行のonStatus転送・トークンの環境変数受け渡し・
/// 非ゼロ終了時のエラー化 — を検証する。本物のsrc/cli.mjs自体の画像処理/HTTP
/// ロジックはtools/bello-photo-station/test配下のNodeテストが担う。
/// </summary>
public sealed class NodeCliPipelineRunnerTests
{
    private static string FixtureScriptPath() => Path.Combine(AppContext.BaseDirectory, "fixtures", "fake-cli.mjs");

    private static PipelineRequest Request(string sessionId = "s1") =>
        new(sessionId, "C:/source", "C:/out", "C:/settings.json", "C:/history.json", "DEVICE-1", "https://api.invalid");

    [Fact]
    public async Task ParsesResultJsonAndStreamsStatusLinesWithoutLeakingTheResultLine()
    {
        var runner = new NodeCliPipelineRunner("node", FixtureScriptPath(), new FixedTokenProvider("test-token"));
        var statusLines = new List<string>();

        var result = await runner.RunAsync(Request(), statusLines.Add);

        Assert.Equal("COMPLETE", result.Status);
        Assert.Equal("b1", result.BatchId);
        Assert.Equal("PB-1", result.BatchCode);
        Assert.Equal(new[] { "a.jpg", "b.jpg" }, result.UploadedFileNames);
        Assert.Empty(result.EditFailures);
        Assert.Empty(result.UploadFailures);
        Assert.Contains("編集中", statusLines);
        Assert.Contains("アップロード中", statusLines);
        Assert.DoesNotContain(statusLines, line => line.StartsWith("RESULT_JSON:"));
    }

    [Fact]
    public async Task SurfacesPartialFailuresEvenThoughTheProcessExitsNonZero()
    {
        Environment.SetEnvironmentVariable("BELLO_FAKE_CLI_MODE", "PARTIAL");
        try
        {
            var runner = new NodeCliPipelineRunner("node", FixtureScriptPath(), new FixedTokenProvider("test-token"));
            var result = await runner.RunAsync(Request(), _ => { });
            Assert.Equal("PARTIAL", result.Status);
            var failure = Assert.Single(result.UploadFailures);
            Assert.Equal("b.jpg", failure.FileName);
            Assert.Equal("network error", failure.Message);
        }
        finally { Environment.SetEnvironmentVariable("BELLO_FAKE_CLI_MODE", null); }
    }

    [Fact]
    public async Task ThrowsWithStderrDetailWhenTheProcessExitsWithoutAResult()
    {
        Environment.SetEnvironmentVariable("BELLO_FAKE_CLI_MODE", "CRASH");
        try
        {
            var runner = new NodeCliPipelineRunner("node", FixtureScriptPath(), new FixedTokenProvider("test-token"));
            var error = await Assert.ThrowsAsync<InvalidOperationException>(() => runner.RunAsync(Request(), _ => { }));
            Assert.Contains("fake crash", error.Message);
        }
        finally { Environment.SetEnvironmentVariable("BELLO_FAKE_CLI_MODE", null); }
    }

    [Fact]
    public async Task ThrowsBeforeSpawningAProcessWhenTheTokenIsMissing()
    {
        var runner = new NodeCliPipelineRunner("node", FixtureScriptPath(), new FixedTokenProvider(null));
        await Assert.ThrowsAsync<InvalidOperationException>(() => runner.RunAsync(Request(), _ => { }));
    }

    private sealed class FixedTokenProvider(string? token) : ITokenProvider
    {
        public string? GetToken() => token;
    }
}

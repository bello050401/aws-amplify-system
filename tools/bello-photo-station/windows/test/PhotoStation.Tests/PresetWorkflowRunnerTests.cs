using System.Text.Json;
using PhotoStation.Infrastructure;

namespace PhotoStation.Tests;
public class PresetWorkflowRunnerTests
{
    [Fact]
    public async Task JsonAndUnicodeArgumentsSurviveProcessBoundary()
    {
        var root = Path.Combine(Path.GetTempPath(), "bello-preset-runner-" + Guid.NewGuid());
        Directory.CreateDirectory(root);
        var script = Path.Combine(root, "fixture.mjs");
        await File.WriteAllTextAsync(script, "console.log('作成中');console.log('RESULT_JSON:'+JSON.stringify({args:process.argv.slice(2)}));");
        var runner = new PresetWorkflowRunner("node", script, root);
        var progress = new List<string>();
        var result = await runner.RunAsync("choose", ["白い商品", "a path with spaces", "[\"one.jpg\"]"], progress.Add);
        Assert.Equal("作成中", Assert.Single(progress));
        Assert.Equal("白い商品", result.GetProperty("args")[2].GetString());
        Assert.Equal("a path with spaces", result.GetProperty("args")[3].GetString());
    }
    [Fact]
    public async Task ProcessFailureCannotBeMistakenForSelectablePreview()
    {
        var root = Path.Combine(Path.GetTempPath(), "bello-preset-fail-" + Guid.NewGuid());
        Directory.CreateDirectory(root);
        var script = Path.Combine(root, "fixture.mjs");
        await File.WriteAllTextAsync(script, "console.error('Lightroom停止');process.exitCode=1;");
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => new PresetWorkflowRunner("node", script, root).RunAsync("preview", []));
        Assert.Contains("Lightroom停止", error.Message);
    }
}

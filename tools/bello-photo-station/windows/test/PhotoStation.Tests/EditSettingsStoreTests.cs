using PhotoStation.Domain;
using PhotoStation.Infrastructure;

namespace PhotoStation.Tests;

public sealed class EditSettingsStoreTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "bello-photo-settings-tests", Guid.NewGuid().ToString("N"));
    private string SettingsFile => Path.Combine(_root, "settings.json");
    public void Dispose() { if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true); }

    [Fact]
    public async Task UninitializedStoreReturnsDefaultSettings()
    {
        var store = new EditSettingsStore(SettingsFile);
        var state = await store.LoadAsync();
        Assert.Equal(EditSettings.Default, state.Active);
        Assert.Empty(state.Presets);
    }

    [Fact]
    public async Task SavingActiveSettingsPersistsAcrossReloadsLikeARestart()
    {
        var store = new EditSettingsStore(SettingsFile);
        await store.SetActiveAsync(EditSettings.Default with { JpegQuality = 55, Brightness = 12 });

        var reloaded = await new EditSettingsStore(SettingsFile).LoadAsync();

        Assert.Equal(55, reloaded.Active.JpegQuality);
        Assert.Equal(12, reloaded.Active.Brightness);
    }

    [Fact]
    public async Task ResetToDefaultRestoresTheInitialSafeSettings()
    {
        var store = new EditSettingsStore(SettingsFile);
        await store.SetActiveAsync(EditSettings.Default with { JpegQuality = 10 });

        var restored = await store.ResetToDefaultAsync();

        Assert.Equal(EditSettings.Default, restored);
        Assert.Equal(EditSettings.Default, (await store.LoadAsync()).Active);
    }

    [Fact]
    public async Task SavesMultipleNamedPresetsAndSwitchesBetweenThem()
    {
        var store = new EditSettingsStore(SettingsFile);
        await store.SavePresetAsync("studio", EditSettings.Default with { Brightness = 20 });
        await store.SavePresetAsync("outdoor", EditSettings.Default with { Saturation = -10 });

        var names = await store.ListPresetNamesAsync();
        Assert.Equal(new[] { "studio", "outdoor" }, names);

        var applied = await store.ApplyPresetAsync("outdoor");
        Assert.Equal(-10, applied.Saturation);
        Assert.Equal(-10, (await store.LoadAsync()).Active.Saturation);
    }

    [Fact]
    public async Task ApplyingAnUnknownPresetFails()
    {
        var store = new EditSettingsStore(SettingsFile);
        await Assert.ThrowsAsync<InvalidOperationException>(() => store.ApplyPresetAsync("does-not-exist"));
    }

    [Fact]
    public async Task WritesAreDurableViaTempFileRenameAndProduceValidJson()
    {
        var store = new EditSettingsStore(SettingsFile);
        await store.SetActiveAsync(EditSettings.Default);

        var entries = Directory.GetFiles(_root);
        Assert.Single(entries);
        Assert.EndsWith("settings.json", entries[0]);
    }

    [Fact]
    public async Task JsonShapeMatchesTheNodeSideSettingsMjsSchema()
    {
        var store = new EditSettingsStore(SettingsFile);
        await store.SetActiveAsync(EditSettings.Default with { JpegQuality = 77 });

        var text = await File.ReadAllTextAsync(SettingsFile);
        Assert.Contains("\"active\"", text);
        Assert.Contains("\"jpegQuality\": 77", text);
        Assert.Contains("\"keepAspectRatio\"", text);
        Assert.Contains("\"thumbnailLongEdgePx\"", text);
        Assert.Contains("\"colorTemperatureShift\"", text);
        Assert.Contains("\"lightroomPresetName\"", text);
    }
}

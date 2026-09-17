using System.Text.Json;
using System.Text.Json.Nodes;
using PhotoStation.Domain;

namespace PhotoStation.Infrastructure;

public sealed record SettingsState(EditSettings Active, IReadOnlyDictionary<string, EditSettings> Presets);

/// <summary>
/// 端末ごとのローカル編集設定。JSON形式は tools/bello-photo-station/src/settings.mjs の
/// SettingsStoreと1:1で揃えている({ "active": {...}, "presets": { "名前": {...} } })。
/// どちらの実装で保存したファイルも、もう片方でそのまま読み書きできる。書き込みは
/// temp書き込み→rename方式で、書き込み途中の破損を防ぐ(settings.mjsと同じ方式)。
/// </summary>
public sealed class EditSettingsStore(string filePath)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public async Task<SettingsState> LoadAsync(CancellationToken cancellationToken = default)
    {
        var raw = await ReadRawAsync(cancellationToken);
        var presets = new Dictionary<string, EditSettings>();
        if (raw.Presets is not null)
            foreach (var (name, value) in raw.Presets) presets[name] = MergeWithDefault(value);
        return new SettingsState(MergeWithDefault(raw.Active), presets);
    }

    public async Task<EditSettings> SetActiveAsync(EditSettings settings, CancellationToken cancellationToken = default)
    {
        var raw = await ReadRawAsync(cancellationToken);
        raw.Active = JsonSerializer.SerializeToNode(settings, JsonOptions);
        await WriteRawAsync(raw, cancellationToken);
        return settings;
    }

    public Task<EditSettings> ResetToDefaultAsync(CancellationToken cancellationToken = default) =>
        SetActiveAsync(EditSettings.Default, cancellationToken);

    public async Task<EditSettings> SavePresetAsync(string name, EditSettings settings, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(name)) throw new ArgumentException("Preset name is required", nameof(name));
        var raw = await ReadRawAsync(cancellationToken);
        raw.Presets ??= new JsonObject();
        raw.Presets[name] = JsonSerializer.SerializeToNode(settings, JsonOptions);
        await WriteRawAsync(raw, cancellationToken);
        return settings;
    }

    public async Task<EditSettings> ApplyPresetAsync(string name, CancellationToken cancellationToken = default)
    {
        var raw = await ReadRawAsync(cancellationToken);
        if (raw.Presets is null || !raw.Presets.TryGetPropertyValue(name, out var preset) || preset is null)
            throw new InvalidOperationException($"Preset not found: {name}");
        var settings = MergeWithDefault(preset);
        raw.Active = JsonSerializer.SerializeToNode(settings, JsonOptions);
        await WriteRawAsync(raw, cancellationToken);
        return settings;
    }

    public async Task<IReadOnlyList<string>> ListPresetNamesAsync(CancellationToken cancellationToken = default)
    {
        var raw = await ReadRawAsync(cancellationToken);
        return raw.Presets is null ? [] : raw.Presets.Select(kv => kv.Key).ToList();
    }

    private async Task<RawFile> ReadRawAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(filePath)) return new RawFile();
        await using var stream = File.OpenRead(filePath);
        return await JsonSerializer.DeserializeAsync<RawFile>(stream, JsonOptions, cancellationToken) ?? new RawFile();
    }

    private async Task WriteRawAsync(RawFile raw, CancellationToken cancellationToken)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(filePath));
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        var temp = $"{filePath}.{Environment.ProcessId}.{DateTimeOffset.UtcNow.Ticks}.tmp";
        await using (var stream = File.Create(temp))
            await JsonSerializer.SerializeAsync(stream, raw, JsonOptions, cancellationToken);
        File.Move(temp, filePath, overwrite: true);
    }

    private static EditSettings MergeWithDefault(JsonNode? raw)
    {
        var merged = JsonSerializer.SerializeToNode(EditSettings.Default, JsonOptions)!.AsObject();
        if (raw is JsonObject rawObject)
            foreach (var (key, value) in rawObject) merged[key] = value?.DeepClone();
        return merged.Deserialize<EditSettings>(JsonOptions)!;
    }

    private sealed class RawFile
    {
        public JsonNode? Active { get; set; }
        public JsonObject? Presets { get; set; }
    }
}

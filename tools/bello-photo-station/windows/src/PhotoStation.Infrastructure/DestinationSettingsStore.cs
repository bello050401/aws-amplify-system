using System.Text.Json;

namespace PhotoStation.Infrastructure;

public sealed record DestinationSettings(int SelectedIndex = 0, string PcFolder = "", string SharedFolder = "");

public sealed class DestinationSettingsStore(string file)
{
    public async Task<DestinationSettings> LoadAsync()
    {
        if (!File.Exists(file)) return new();
        var result = JsonSerializer.Deserialize<DestinationSettings>(await File.ReadAllTextAsync(file)) ?? new();
        return result with { SelectedIndex = result.SelectedIndex is >= 0 and <= 2 ? result.SelectedIndex : 0 };
    }

    public async Task SaveAsync(DestinationSettings settings)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var temporary = file + ".tmp";
        await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(settings));
        File.Move(temporary, file, overwrite: true);
    }
}

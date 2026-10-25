using System.Text.Json;

namespace PhotoStation.Application;

/// <summary>The deadline belongs to the import, never to a later edit or retry.</summary>
public static class SourceRetention
{
    public const string FileName = "source-retention.json";
    public static async Task<DateTimeOffset> EnsureAsync(string sessionRoot, DateTimeOffset importedAt, CancellationToken cancellationToken = default)
    {
        Directory.CreateDirectory(sessionRoot);
        var target = Path.Combine(sessionRoot, FileName);
        if (File.Exists(target)) return await ReadExpiryAsync(sessionRoot, cancellationToken);
        var temporary = target + "." + Guid.NewGuid().ToString("N") + ".tmp";
        await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(new {
            version = 1, importedAt = importedAt.ToUniversalTime(), expiresAt = importedAt.ToUniversalTime().AddDays(7)
        }), cancellationToken);
        File.Move(temporary, target, overwrite: false);
        return importedAt.AddDays(7);
    }

    public static async Task<DateTimeOffset> ReadExpiryAsync(string sessionRoot, CancellationToken cancellationToken = default)
    {
        using var marker = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(sessionRoot, FileName), cancellationToken));
        var data = marker.RootElement;
        if (data.GetProperty("version").GetInt32() != 1) throw new IOException("原本の保管期限を確認できません");
        var importedAt = data.GetProperty("importedAt").GetDateTimeOffset();
        var expiresAt = data.GetProperty("expiresAt").GetDateTimeOffset();
        if (expiresAt != importedAt.AddDays(7)) throw new IOException("原本の保管期限が不正です");
        return expiresAt;
    }
}

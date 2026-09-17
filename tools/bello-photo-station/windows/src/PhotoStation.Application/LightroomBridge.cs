using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PhotoStation.Application;

public sealed record LightroomRenderItem(Guid LocalAssetId, string SourcePath, string SourceSha256, string OutputDirectory);
public sealed record LightroomRenderRequest(int ProtocolVersion, Guid JobId, Guid AttemptId, long FencingToken,
    Guid SessionId, string RecipeId, string RecipeHash, IReadOnlyList<LightroomRenderItem> Items);

public static class LightroomBridgeProtocol
{
    public const int Version = 1;
    public static void Validate(LightroomRenderRequest request, string allowedRoot, int maxItems = 300)
    {
        if (request.ProtocolVersion != Version) throw new InvalidDataException("Unsupported bridge protocol version.");
        if (request.JobId == Guid.Empty || request.AttemptId == Guid.Empty || request.SessionId == Guid.Empty) throw new InvalidDataException("Bridge IDs are required.");
        if (request.FencingToken < 1) throw new InvalidDataException("Fencing token must be positive.");
        if (request.Items.Count is < 1 || request.Items.Count > 300 || request.Items.Count > maxItems) throw new InvalidDataException("Bridge item count is invalid.");
        if (!System.Text.RegularExpressions.Regex.IsMatch(request.RecipeId, "^[a-z0-9-]{1,80}$")) throw new InvalidDataException("Recipe is not allow-list compatible.");
        if (!IsSha256(request.RecipeHash)) throw new InvalidDataException("Recipe hash is invalid.");
        foreach (var item in request.Items)
        {
            if (item.LocalAssetId == Guid.Empty || !IsSha256(item.SourceSha256)) throw new InvalidDataException("Item identity is invalid.");
            EnsureUnderRoot(allowedRoot, item.SourcePath);
            EnsureUnderRoot(allowedRoot, item.OutputDirectory);
        }
    }

    public static string EnsureUnderRoot(string root, string path)
    {
        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var fullPath = Path.GetFullPath(path);
        if (!fullPath.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase) || ContainsReparsePoint(fullRoot, fullPath))
            throw new InvalidDataException("Bridge path escapes the station root.");
        return fullPath;
    }

    private static bool ContainsReparsePoint(string root, string path)
    {
        var current = Path.GetDirectoryName(path);
        while (!string.IsNullOrEmpty(current) && current.StartsWith(root, StringComparison.OrdinalIgnoreCase))
        {
            if (Directory.Exists(current) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return true;
            current = Path.GetDirectoryName(current);
        }
        return false;
    }
    private static bool IsSha256(string value) => value.Length == 64 && value.All(Uri.IsHexDigit);
}

using System.Security.Cryptography;
using PhotoStation.Application;
using PhotoStation.Domain;

namespace PhotoStation.Infrastructure;

public sealed class VerifiedFileCopier(TimeProvider? timeProvider = null) : IVerifiedFileCopier
{
    private readonly TimeProvider _time = timeProvider ?? TimeProvider.System;

    public async Task<VerifiedSource> CopyAndVerifyAsync(string sourceRoot, string relativePath,
        string sessionRoot, CancellationToken cancellationToken = default)
    {
        var source = ResolveUnderRoot(sourceRoot, relativePath);
        if (!File.Exists(source)) throw new FileNotFoundException("Source image is missing", source);
        if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Reparse-point sources are not accepted");

        var sourceId = Guid.NewGuid();
        var sourceDir = Path.Combine(Path.GetFullPath(sessionRoot), "source");
        Directory.CreateDirectory(sourceDir);
        var extension = Path.GetExtension(source).ToLowerInvariant();
        var destination = ResolveUnderRoot(sourceDir, sourceId.ToString("N") + extension);
        var partial = destination + ".partial";
        if (File.Exists(destination)) throw new IOException("Destination already exists");

        var before = new FileInfo(source);
        string sourceHash;
        await using (var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read,
                         1024 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan))
        await using (var output = new FileStream(partial, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                         1024 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan | FileOptions.WriteThrough))
        using (var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
        {
            var buffer = new byte[1024 * 1024];
            int read;
            while ((read = await input.ReadAsync(buffer, cancellationToken)) > 0)
            {
                hash.AppendData(buffer, 0, read);
                await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            }
            await output.FlushAsync(cancellationToken);
            output.Flush(flushToDisk: true);
            sourceHash = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        }

        var after = new FileInfo(source);
        if (before.Length != after.Length || before.LastWriteTimeUtc != after.LastWriteTimeUtc)
            throw new IOException("Source changed while it was being copied");
        var destinationHash = await Sha256Async(partial, cancellationToken);
        if (!string.Equals(sourceHash, destinationHash, StringComparison.Ordinal))
            throw new IOException("Copied bytes failed SHA-256 verification");
        File.Move(partial, destination);
        return new VerifiedSource(sourceId, relativePath, destination, after.Length, sourceHash, after.LastWriteTimeUtc, _time.GetUtcNow());
    }

    public static string ResolveUnderRoot(string root, string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath) || Path.IsPathRooted(relativePath))
            throw new ArgumentException("A non-empty relative path is required", nameof(relativePath));
        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var full = Path.GetFullPath(Path.Combine(fullRoot, relativePath));
        if (!full.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("Path escapes the configured root");
        return full;
    }

    private static async Task<string> Sha256Async(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
            1024 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken)).ToLowerInvariant();
    }
}

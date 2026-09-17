using System.Text.Json;
using PhotoStation.Application;

namespace PhotoStation.Infrastructure;

public sealed class LightroomBridgeWriter(string bridgeRoot, string stationRoot)
{
    public async Task<string> EnqueueAsync(LightroomRenderRequest request, CancellationToken cancellationToken = default)
    {
        LightroomBridgeProtocol.Validate(request, stationRoot);
        var requestRoot = Path.Combine(bridgeRoot, "requests");
        Directory.CreateDirectory(requestRoot);
        var finalPath = Path.Combine(requestRoot, $"{request.JobId:D}.{request.AttemptId:D}.ready.json");
        var temporaryPath = finalPath + ".partial";
        var bytes = JsonSerializer.SerializeToUtf8Bytes(request, new JsonSerializerOptions { WriteIndented = true });
        if (bytes.Length > 2 * 1024 * 1024) throw new InvalidDataException("Bridge request exceeds 2 MiB.");
        await using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 64 * 1024, FileOptions.WriteThrough))
        {
            await stream.WriteAsync(bytes, cancellationToken);
            stream.Flush(flushToDisk: true);
        }
        File.Move(temporaryPath, finalPath, overwrite: false);
        return finalPath;
    }
}

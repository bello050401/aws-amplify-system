using System.Text.Json;

namespace PhotoStation.Infrastructure;
public static class LightroomConnectionStatus
{
    public static bool IsConnected(string root, DateTimeOffset now, int minimumBridgeVersion = 0)
    {
        try
        {
            using var state = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "lightroom", "heartbeat.json")));
            var age = now.ToUnixTimeMilliseconds() - state.RootElement.GetProperty("unixMs").GetInt64();
            if (minimumBridgeVersion > 0 && (!state.RootElement.TryGetProperty("bridgeVersion", out var version)
                || version.GetInt32() < minimumBridgeVersion)) return false;
            return state.RootElement.GetProperty("protocol").GetInt32() == 2 && age is >= -2000 and < 15000;
        }
        catch { return false; }
    }
}

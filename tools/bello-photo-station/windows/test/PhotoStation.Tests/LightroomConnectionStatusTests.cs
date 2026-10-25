using PhotoStation.Infrastructure;
namespace PhotoStation.Tests;
public sealed class LightroomConnectionStatusTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "BelloHeartbeatTests", Guid.NewGuid().ToString("N"));
    [Theory]
    [InlineData(2, 1000, true)]
    [InlineData(2, 15000, false)]
    [InlineData(1, 1000, false)]
    [InlineData(2, -60000, false)]
    public void OnlyRecentSupportedHeartbeatCountsAsConnected(int protocol, long age, bool connected)
    {
        var now = DateTimeOffset.UtcNow;
        Directory.CreateDirectory(Path.Combine(root, "lightroom"));
        File.WriteAllText(Path.Combine(root, "lightroom", "heartbeat.json"),
            System.Text.Json.JsonSerializer.Serialize(new { protocol, unixMs = now.ToUnixTimeMilliseconds() - age }));
        Assert.Equal(connected, LightroomConnectionStatus.IsConnected(root, now));
    }
    [Fact]
    public void OlderLoadedPluginMustNotCountAsCurrentConnection()
    {
        var now = DateTimeOffset.UtcNow;
        Directory.CreateDirectory(Path.Combine(root, "lightroom"));
        var file = Path.Combine(root, "lightroom", "heartbeat.json");
        File.WriteAllText(file, System.Text.Json.JsonSerializer.Serialize(new { protocol = 2, unixMs = now.ToUnixTimeMilliseconds() }));
        Assert.False(LightroomConnectionStatus.IsConnected(root, now, 10));
        File.WriteAllText(file, System.Text.Json.JsonSerializer.Serialize(new { protocol = 2, bridgeVersion = 10, unixMs = now.ToUnixTimeMilliseconds() }));
        Assert.True(LightroomConnectionStatus.IsConnected(root, now, 10));
    }
    [Fact]
    public void InstalledButNotRunningAndDamagedStatusAreNotConnected()
    {
        Assert.False(LightroomConnectionStatus.IsConnected(root, DateTimeOffset.UtcNow));
        Directory.CreateDirectory(Path.Combine(root, "lightroom"));
        File.WriteAllText(Path.Combine(root, "lightroom", "heartbeat.json"), "{");
        Assert.False(LightroomConnectionStatus.IsConnected(root, DateTimeOffset.UtcNow));
    }
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }
}

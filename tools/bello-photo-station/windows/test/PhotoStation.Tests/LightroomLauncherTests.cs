using PhotoStation.Infrastructure;

namespace PhotoStation.Tests;

public class LightroomLauncherTests
{
    [Fact]
    public void AlreadyRunningDoesNotLaunchOrDiscoverAgain()
    {
        var launcher = new LightroomLauncher(() => true, () => throw new Exception(), _ => throw new Exception());
        Assert.Contains("起動しています", launcher.EnsureStarted());
    }

    [Fact]
    public void ClosedLightroomStartsExactlyInstalledExecutable()
    {
        var starts = new List<string>();
        var launcher = new LightroomLauncher(() => false, () => @"C:\Program Files\Adobe\Lightroom.exe", starts.Add);
        Assert.Contains("起動しました", launcher.EnsureStarted());
        Assert.Equal(new[] { @"C:\Program Files\Adobe\Lightroom.exe" }, starts);
    }

    [Fact]
    public void MissingAndFailedLightroomDoNotCrashPhotoStation()
    {
        Assert.Contains("見つかりません", new LightroomLauncher(() => false, () => null, _ => throw new Exception()).EnsureStarted());
        Assert.Contains("起動できません", new LightroomLauncher(() => false, () => "installed", _ => throw new Exception()).EnsureStarted());
    }

    [Fact]
    public void StartupRaceDoesNotOpenAnotherCopy()
    {
        var checks = 0;
        Assert.Contains("起動しました", new LightroomLauncher(() => ++checks > 1, () => "installed", _ => throw new Exception()).EnsureStarted());
    }
}

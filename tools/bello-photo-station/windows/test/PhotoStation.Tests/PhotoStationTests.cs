using PhotoStation.Application;
using PhotoStation.Domain;
using PhotoStation.Infrastructure;

namespace PhotoStation.Tests;

public sealed class PhotoStationTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "bello-photo-tests", Guid.NewGuid().ToString("N"));
    public void Dispose() { if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true); }

    [Fact]
    public void StateMachineRejectsSkippingLocalVerification()
    {
        var session = Session();
        Assert.Throws<InvalidOperationException>(() => session.TransitionTo(ImportSessionState.ReadyToUpload));
        session.TransitionTo(ImportSessionState.Snapshotting);
        session.TransitionTo(ImportSessionState.Copying);
        session.TransitionTo(ImportSessionState.LocalSecured);
        Assert.Equal(ImportSessionState.LocalSecured, session.State);
    }

    [Fact]
    public void NeedsReviewRequiresReason()
    {
        var session = Session(); session.TransitionTo(ImportSessionState.Snapshotting);
        Assert.Throws<ArgumentException>(() => session.TransitionTo(ImportSessionState.NeedsReview));
    }

    [Theory]
    [InlineData("../escape.jpg")]
    [InlineData("C:/escape.jpg")]
    public void CopierRejectsPathsOutsideRoot(string path) => Assert.ThrowsAny<Exception>(() => VerifiedFileCopier.ResolveUnderRoot(_root, path));

    [Fact]
    public async Task CopyUsesPartialThenVerifiesSha256()
    {
        var source = Path.Combine(_root, "card"); Directory.CreateDirectory(source);
        await File.WriteAllTextAsync(Path.Combine(source, "x.jpg"), "verified bytes");
        var result = await new VerifiedFileCopier().CopyAndVerifyAsync(source, "x.jpg", Path.Combine(_root, "session"));
        Assert.True(File.Exists(result.LocalPath)); Assert.False(File.Exists(result.LocalPath + ".partial")); Assert.Equal(64, result.Sha256.Length);
    }

    [Fact]
    public async Task ImportIsDurableAndIdempotentForSameSessionAndManifest()
    {
        var source = Path.Combine(_root, "card"); Directory.CreateDirectory(source);
        await File.WriteAllTextAsync(Path.Combine(source, "x.jpg"), "one");
        var repository = new SqliteStationRepository(Path.Combine(_root, "db", "station.sqlite")); await repository.InitializeAsync();
        var service = new ImportService(repository, new VerifiedFileCopier()); var id = Guid.NewGuid();
        var candidate = new SourceCandidate("x.jpg", 3, File.GetLastWriteTimeUtc(Path.Combine(source, "x.jpg")));
        var request = new ImportRequest(id, "staging", "STATION-1", "GEN-1", source, Path.Combine(_root, "sessions", id.ToString()), [candidate]);
        var first = await service.ImportAsync(request); var second = await service.ImportAsync(request);
        Assert.True(first.SafeToRemove); Assert.Equal(ImportSessionState.LocalSecured, second.State); Assert.Single(await repository.ListSessionsAsync());
    }

    [Fact]
    public async Task TwentyFilesBecomeOneLocallySecuredSession()
    {
        var source = Path.Combine(_root, "card"); Directory.CreateDirectory(source); var candidates = new List<SourceCandidate>();
        for (var i = 0; i < 20; i++) { var name = $"DSC{i:0000}.JPG"; var file = Path.Combine(source, name); await File.WriteAllTextAsync(file, "image-" + i); var info = new FileInfo(file); candidates.Add(new SourceCandidate(name, info.Length, info.LastWriteTimeUtc)); }
        var repository = new SqliteStationRepository(Path.Combine(_root, "db", "station.sqlite")); await repository.InitializeAsync(); var id = Guid.NewGuid();
        var result = await new ImportService(repository, new VerifiedFileCopier()).ImportAsync(new ImportRequest(id, "staging", "STATION-1", "GEN-1", source, Path.Combine(_root, "sessions", id.ToString()), candidates));
        Assert.Equal(20, result.VerifiedCount); Assert.True(result.SafeToRemove);
    }

    private static ImportSession Session() => new(Guid.NewGuid(), "staging", "STATION-1", "GEN-1", "manifest", DateTimeOffset.UtcNow);
}

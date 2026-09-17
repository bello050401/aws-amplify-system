using PhotoStation.Application;
using PhotoStation.Domain;
using PhotoStation.Infrastructure;

namespace PhotoStation.Tests;

public sealed class PhotoUploadServiceTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "bello-photo-upload-tests", Guid.NewGuid().ToString("N"));
    public void Dispose() { if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true); }

    private async Task<(SqliteStationRepository Repository, ImportSession Session)> LocalSecuredSessionAsync(string dbName = "station.sqlite")
    {
        var repository = new SqliteStationRepository(Path.Combine(_root, "db", dbName));
        await repository.InitializeAsync();
        var session = new ImportSession(Guid.NewGuid(), "staging", "STATION-1", "GEN-1", "manifest", DateTimeOffset.UtcNow);
        await repository.SaveSessionAsync(session);
        session.TransitionTo(ImportSessionState.Snapshotting); await repository.SaveSessionAsync(session);
        session.TransitionTo(ImportSessionState.Copying); await repository.SaveSessionAsync(session);
        session.TransitionTo(ImportSessionState.LocalSecured); await repository.SaveSessionAsync(session);
        return (repository, session);
    }

    private static PhotoUploadRequest Request(ImportSession session) =>
        new(session.Id.ToString("D"), "C:/source", "C:/out", "C:/settings.json", "C:/history.json", "DEVICE-1", "https://api.invalid");

    [Fact]
    public async Task CompleteResultMovesSessionToCloudVerifying()
    {
        var (repository, session) = await LocalSecuredSessionAsync();
        var service = new PhotoUploadService(repository, new FakeRunner(new PipelineResult("COMPLETE", "b1", "PB-1", ["a.jpg"], [], [])));

        var outcome = await service.UploadAsync(Request(session), _ => { });

        Assert.Equal(ImportSessionState.CloudVerifying, outcome.State);
        var reloaded = await repository.FindSessionAsync(session.Id);
        Assert.Equal(ImportSessionState.CloudVerifying, reloaded!.State);
    }

    [Fact]
    public async Task PartialResultMovesSessionToNeedsReviewSoItCanBeRetried()
    {
        var (repository, session) = await LocalSecuredSessionAsync("station-partial.sqlite");
        var runner = new FakeRunner(new PipelineResult("PARTIAL", "b1", "PB-1", ["a.jpg"], [], [new PipelineFailure("2", "b.jpg", "UPLOAD", "network error")]));
        var service = new PhotoUploadService(repository, runner);

        var outcome = await service.UploadAsync(Request(session), _ => { });

        Assert.Equal(ImportSessionState.NeedsReview, outcome.State);
        Assert.NotNull(outcome.Pipeline);
    }

    [Fact]
    public async Task FailedResultMovesSessionToNeedsReview()
    {
        var (repository, session) = await LocalSecuredSessionAsync("station-failed.sqlite");
        var service = new PhotoUploadService(repository, new FakeRunner(new PipelineResult("FAILED", null, null, [], [new PipelineFailure("1", "a.jpg", "EDIT", "boom")], [])));

        var outcome = await service.UploadAsync(Request(session), _ => { });

        Assert.Equal(ImportSessionState.NeedsReview, outcome.State);
    }

    [Fact]
    public async Task PipelineExceptionMovesSessionToNeedsReviewAndSurfacesTheMessage()
    {
        var (repository, session) = await LocalSecuredSessionAsync("station-throw.sqlite");
        var service = new PhotoUploadService(repository, new ThrowingRunner("boom"));

        var outcome = await service.UploadAsync(Request(session), _ => { });

        Assert.Equal(ImportSessionState.NeedsReview, outcome.State);
        Assert.Equal("boom", outcome.Error);
        Assert.Null(outcome.Pipeline);
    }

    [Fact]
    public async Task NeedsReviewSessionCanBeRetried()
    {
        var (repository, session) = await LocalSecuredSessionAsync("station-retry.sqlite");
        session.TransitionTo(ImportSessionState.Rendering); await repository.SaveSessionAsync(session);
        session.TransitionTo(ImportSessionState.NeedsReview, "first attempt failed"); await repository.SaveSessionAsync(session);
        var service = new PhotoUploadService(repository, new FakeRunner(new PipelineResult("COMPLETE", "b2", "PB-2", ["a.jpg"], [], [])));

        var outcome = await service.UploadAsync(Request(session), _ => { });

        Assert.Equal(ImportSessionState.CloudVerifying, outcome.State);
        var reloaded = await repository.FindSessionAsync(session.Id);
        Assert.Equal(ImportSessionState.CloudVerifying, reloaded!.State);
    }

    [Fact]
    public async Task RejectsSessionsThatAreNotYetLocalSecured()
    {
        var repository = new SqliteStationRepository(Path.Combine(_root, "db", "station-notready.sqlite"));
        await repository.InitializeAsync();
        var session = new ImportSession(Guid.NewGuid(), "staging", "STATION-1", "GEN-1", "manifest", DateTimeOffset.UtcNow);
        await repository.SaveSessionAsync(session);
        var service = new PhotoUploadService(repository, new FakeRunner(new PipelineResult("COMPLETE", null, null, [], [], [])));

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.UploadAsync(Request(session), _ => { }));
    }

    private sealed class FakeRunner(PipelineResult result) : IPhotoPipelineRunner
    {
        public Task<PipelineResult> RunAsync(PipelineRequest request, Action<string> onStatus, CancellationToken cancellationToken = default) => Task.FromResult(result);
    }

    private sealed class ThrowingRunner(string message) : IPhotoPipelineRunner
    {
        public Task<PipelineResult> RunAsync(PipelineRequest request, Action<string> onStatus, CancellationToken cancellationToken = default) => throw new InvalidOperationException(message);
    }
}

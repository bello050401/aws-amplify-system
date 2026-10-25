using PhotoStation.Application;
using PhotoStation.Domain;
using PhotoStation.Infrastructure;

namespace PhotoStation.Tests;

public sealed class PhotoUploadServiceTests : IDisposable
{
    [Theory]
    [InlineData("https://dq30ujzf5d.execute-api.us-west-2.amazonaws.com", true)]
    [InlineData("https://dq30ujzf5d.execute-api.us-west-2.amazonaws.com/", true)]
    [InlineData("http://dq30ujzf5d.execute-api.us-west-2.amazonaws.com/", false)]
    [InlineData("https://production.example.com/", false)]
    [InlineData("https://dq30ujzf5d.execute-api.us-west-2.amazonaws.com.evil.test/", false)]
    [InlineData("https://dq30ujzf5d.execute-api.us-west-2.amazonaws.com/path", false)]
    public void DesktopValidationEndpointIsAllowlisted(string endpoint, bool expected) =>
        Assert.Equal(expected, PhotoEndpointSafety.IsAllowedValidationEndpoint(endpoint));

    [Fact]
    public void ValidationTokenMustBeForDedicatedPoolAndStillUsable()
    {
        var now = DateTimeOffset.Parse("2026-09-23T00:00:00Z");
        static string Token(string issuer, string group, long expiry)
        {
            var json = System.Text.Json.JsonSerializer.Serialize(new Dictionary<string, object> {
                ["iss"] = issuer, ["cognito:groups"] = new[] { group }, ["exp"] = expiry,
                ["aud"] = "3nm24ejtua3inrg0sdmpbn2vqs", ["token_use"] = "id",
            });
            return "header." + Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(json))
                .TrimEnd('=').Replace('+', '-').Replace('/', '_') + ".signature";
        }
        const string pool = "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_bKfdql8QT";
        Assert.True(PhotoEndpointSafety.HasUsableValidationToken(Token(pool, "PHOTO_DEVICE", now.AddHours(1).ToUnixTimeSeconds()), now));
        Assert.False(PhotoEndpointSafety.HasUsableValidationToken(Token(pool, "PHOTO_DEVICE", now.AddMinutes(1).ToUnixTimeSeconds()), now));
        Assert.False(PhotoEndpointSafety.HasUsableValidationToken(Token(pool, "ADMIN", now.AddHours(1).ToUnixTimeSeconds()), now));
        Assert.False(PhotoEndpointSafety.HasUsableValidationToken(Token("https://cognito-idp.us-west-2.amazonaws.com/another", "PHOTO_DEVICE", now.AddHours(1).ToUnixTimeSeconds()), now));
        Assert.False(PhotoEndpointSafety.HasUsableValidationToken("invalid", now));
    }

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

    [Fact]
    public async Task LocalSaveHasDistinctStateAndCanLaterSaveToWeb()
    {
        var (repository, session) = await LocalSecuredSessionAsync("local-save.sqlite");
        var service = new PhotoUploadService(repository, new FakeRunner(new PipelineResult("SAVED_LOCAL", null, null, [], [], [], "C:/Photos/BELLO-test")));
        var outcome = await service.UploadAsync(Request(session) with { Destination = "pc", ExportDirectory = "C:/Photos" }, _ => { });
        Assert.Equal(ImportSessionState.LocalSaved, outcome.State);
        Assert.Equal(ImportSessionState.LocalSaved, (await repository.FindSessionAsync(session.Id))!.State);
        var web = new PhotoUploadService(repository, new FakeRunner(new PipelineResult("COMPLETE", "b1", "PB-1", ["a.jpg"], [], [])));
        Assert.Equal(ImportSessionState.CloudVerifying, (await web.UploadAsync(Request(session), _ => { })).State);
    }

    [Theory]
    [InlineData("SAVED_LOCAL", "web")]
    [InlineData("COMPLETE", "shared")]
    [InlineData("UNKNOWN", "web")]
    public async Task MismatchedOrUnknownCompletionCannotBeReportedAsSuccess(string status, string destination)
    {
        var (repository, session) = await LocalSecuredSessionAsync();
        var service = new PhotoUploadService(repository, new FakeRunner(new PipelineResult(status, null, null, [], [], [], "C:/Photos")));
        Assert.Equal(ImportSessionState.NeedsReview, (await service.UploadAsync(Request(session) with { Destination = destination, ExportDirectory = "C:/Photos" }, _ => { })).State);
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

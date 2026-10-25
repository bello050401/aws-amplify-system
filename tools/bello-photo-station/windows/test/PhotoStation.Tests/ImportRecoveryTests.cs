using PhotoStation.Application;
using PhotoStation.Domain;
using PhotoStation.Infrastructure;

namespace PhotoStation.Tests;

public sealed class ImportRecoveryTests
{
    [Fact]
    public async Task ReusedCameraFilenameWithSameSizeAndTimestampStillImportsDifferentContent()
    {
        var root = Path.Combine(Path.GetTempPath(), "bello-card-reused", Guid.NewGuid().ToString("N"));
        var card = Path.Combine(root, "card"); Directory.CreateDirectory(card);
        var repository = new SqliteStationRepository(Path.Combine(root, "station.sqlite")); await repository.InitializeAsync();
        var file = Path.Combine(card, "DSC0001.JPG");
        var modified = new DateTime(2026, 10, 19, 1, 0, 0, DateTimeKind.Utc);
        var manifests = new List<string>();
        foreach (var contents in new[] { "AAAA", "BBBB" })
        {
            await File.WriteAllTextAsync(file, contents); File.SetLastWriteTimeUtc(file, modified);
            var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(contents))).ToLowerInvariant();
            SourceCandidate candidate = new("DSC0001.JPG", 4, modified, hash);
            manifests.Add(ImportService.ManifestHash([candidate]));
            var id = Guid.NewGuid();
            var request = new ImportRequest(id, "staging", "TEST", "same-card", card, Path.Combine(root, "sessions", id.ToString("D")), [candidate]);
            Assert.Equal(1, (await new ImportService(repository, new VerifiedFileCopier()).ImportAsync(request)).VerifiedCount);
            Assert.Equal(contents, await File.ReadAllTextAsync(Assert.Single(Directory.GetFiles(Path.Combine(request.SessionRoot, "source")))));
            Assert.Equal(0, (await new ImportService(repository, new VerifiedFileCopier()).ImportAsync(request)).VerifiedCount);
        }
        Assert.NotEqual(manifests[0], manifests[1]);
        Assert.Equal(2, (await repository.ListSessionsAsync()).Count);
    }

    [Theory]
    [InlineData(ImportSessionState.Rendering)]
    [InlineData(ImportSessionState.Processing)]
    [InlineData(ImportSessionState.ReadyToUpload)]
    [InlineData(ImportSessionState.Uploading)]
    public async Task StartupRecoveryAllowsInterruptedProcessingToBeSavedAgain(ImportSessionState interruptedState)
    {
        var root = Path.Combine(Path.GetTempPath(), "bello-processing-restart", Guid.NewGuid().ToString("N"));
        var database = Path.Combine(root, "station.sqlite");
        var repository = new SqliteStationRepository(database); await repository.InitializeAsync();
        var session = new ImportSession(Guid.NewGuid(), "staging", "TEST", "CARD-A", "manifest", DateTimeOffset.UtcNow, interruptedState);
        await repository.SaveSessionAsync(session);
        var completed = new ImportSession(Guid.NewGuid(), "staging", "TEST", "CARD-B", "other", DateTimeOffset.UtcNow, ImportSessionState.LocalSaved);
        await repository.SaveSessionAsync(completed);
        var source = Path.Combine(root, "source.jpg"); await File.WriteAllTextAsync(source, "original photo");
        repository = new SqliteStationRepository(database); await repository.InitializeAsync();
        Assert.Equal(1, await SessionRecovery.RecoverProcessingAsync(repository));
        Assert.Equal(0, await SessionRecovery.RecoverProcessingAsync(repository));
        Assert.Equal(ImportSessionState.LocalSaved, (await repository.FindSessionAsync(completed.Id))!.State);
        var request = new PhotoUploadRequest(session.Id.ToString("D"), root, root, "settings", "history", "TEST", "", Destination: "pc", ExportDirectory: root);
        var result = await new PhotoUploadService(repository, new LocalResultRunner(root)).UploadAsync(request, _ => {});
        Assert.Equal(ImportSessionState.LocalSaved, result.State);
        // Reopen again, then save the same product a second time.
        repository = new SqliteStationRepository(database); await repository.InitializeAsync();
        Assert.Equal(ImportSessionState.LocalSaved, (await new PhotoUploadService(repository, new LocalResultRunner(root)).UploadAsync(request, _ => {})).State);
        Assert.Equal("original photo", await File.ReadAllTextAsync(source));
        Assert.Equal(2, (await repository.ListSessionsAsync()).Count);
    }

    private sealed class LocalResultRunner(string directory) : IPhotoPipelineRunner
    {
        public Task<PipelineResult> RunAsync(PipelineRequest request, Action<string> onStatus, CancellationToken cancellationToken = default)
            => Task.FromResult(new PipelineResult("SAVED_LOCAL", null, null, [], [], [], directory));
    }

    [Fact]
    public async Task ThreeSameCapacityCardsKeepSeparateProductsAcrossReopenAndReinsertion()
    {
        var root = Path.Combine(Path.GetTempPath(), "bello-card-rotation", Guid.NewGuid().ToString("N"));
        var database = Path.Combine(root, "station.sqlite");
        var repository = new SqliteStationRepository(database); await repository.InitializeAsync();
        var requests = new List<ImportRequest>();
        var modified = new DateTime(2026, 10, 19, 1, 0, 0, DateTimeKind.Utc);
        for (uint i = 1; i <= 3; i++)
        {
            var card = Path.Combine(root, "card-" + i); Directory.CreateDirectory(card);
            var file = Path.Combine(card, "DSC0001.JPG");
            await File.WriteAllTextAsync(file, "photo-card-" + i); File.SetLastWriteTimeUtc(file, modified);
            var info = new FileInfo(file); var id = Guid.NewGuid();
            var request = new ImportRequest(id, "staging", "TEST", CardIdentity.FromVolume(i, 128000000000, "exFAT"), card,
                Path.Combine(root, "sessions", id.ToString("D")), [new("DSC0001.JPG", info.Length, modified)]);
            requests.Add(request);
            Assert.Equal(1, (await new ImportService(repository, new VerifiedFileCopier()).ImportAsync(request)).VerifiedCount);
        }
        Assert.Equal(3, requests.Select(x => x.CardGenerationId).Distinct().Count());
        repository = new SqliteStationRepository(database); await repository.InitializeAsync();
        foreach (var request in requests)
        {
            Assert.Equal(0, (await new ImportService(repository, new VerifiedFileCopier()).ImportAsync(request)).VerifiedCount);
            var local = Assert.Single(Directory.GetFiles(Path.Combine(request.SessionRoot, "source")));
            Assert.Equal(await File.ReadAllTextAsync(Path.Combine(request.SourceRoot, "DSC0001.JPG")), await File.ReadAllTextAsync(local));
        }
        Assert.Equal(3, (await repository.ListSessionsAsync()).Count);
    }

    [Fact]
    public async Task LegacyCardHistorySuppliesHashesToDistinguishSameNameSizeAndTime()
    {
        var root = Path.Combine(Path.GetTempPath(), "bello-card-legacy", Guid.NewGuid().ToString("N"));
        var card = Path.Combine(root, "card"); Directory.CreateDirectory(card);
        var file = Path.Combine(card, "DSC0001.JPG"); await File.WriteAllTextAsync(file, "AAAA");
        var info = new FileInfo(file); var candidate = new SourceCandidate("DSC0001.JPG", info.Length, info.LastWriteTimeUtc);
        var repository = new SqliteStationRepository(Path.Combine(root, "station.sqlite")); await repository.InitializeAsync();
        var id = Guid.NewGuid();
        await new ImportService(repository, new VerifiedFileCopier()).ImportAsync(new(id, "staging", "TEST", "old-capacity-id", card,
            Path.Combine(root, "sessions", id.ToString("D")), [candidate]));
        var known = await repository.LoadKnownSourceHashesAsync("new-volume-id", "old-capacity-id");
        var original = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("AAAA"))).ToLowerInvariant();
        var otherCard = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("BBBB"))).ToLowerInvariant();
        Assert.Contains(original, known[candidate]);
        Assert.DoesNotContain(otherCard, known[candidate]);
        Assert.Empty(await repository.LoadKnownSourceHashesAsync("new-volume-id", "unrelated-legacy-id"));
    }

    [Fact]
    public async Task InterruptedCardCopyResumesTheSameProductAfterRepositoryReopen()
    {
        var root = Path.Combine(Path.GetTempPath(), "bello-import-recovery", Guid.NewGuid().ToString("N"));
        var card = Path.Combine(root, "card"); Directory.CreateDirectory(card);
        var candidates = new List<SourceCandidate>();
        foreach (var name in new[] { "front.jpg", "side.jpg", "detail.jpg" })
        {
            var file = Path.Combine(card, name); await File.WriteAllTextAsync(file, name + " original bytes");
            var info = new FileInfo(file); candidates.Add(new(name, info.Length, info.LastWriteTimeUtc));
        }
        var database = Path.Combine(root, "station.sqlite");
        var repository = new SqliteStationRepository(database); await repository.InitializeAsync();
        var sessionId = Guid.NewGuid(); var sessionRoot = Path.Combine(root, "sessions", sessionId.ToString("D"));
        var request = new ImportRequest(sessionId, "staging", "TEST", "CARD-A", card, sessionRoot, candidates);
        await Assert.ThrowsAsync<IOException>(() => new ImportService(repository, new DisconnectOnSecondCopy()).ImportAsync(request));
        Assert.Equal(ImportSessionState.Copying, (await repository.FindSessionAsync(sessionId))!.State);
        Assert.Single(Directory.GetFiles(Path.Combine(sessionRoot, "source"), "*.jpg"));

        // Fresh repository/service instances model a process restart; files and SQLite persist.
        repository = new SqliteStationRepository(database); await repository.InitializeAsync();
        var recovery = new ImportService(repository, new VerifiedFileCopier());
        var restoredRequest = await recovery.FindInterruptedAsync("CARD-A", root, card);
        Assert.NotNull(restoredRequest);
        Assert.Equal(3, restoredRequest.Candidates.Count);
        Assert.Null(await recovery.FindInterruptedAsync("CARD-B", root, card));
        var result = await recovery.ImportAsync(restoredRequest);
        Assert.True(result.SafeToRemove);
        Assert.Equal(ImportSessionState.LocalSecured, (await repository.FindSessionAsync(sessionId))!.State);
        Assert.Single(await repository.ListSessionsAsync());
        Assert.Equal(3, Directory.GetFiles(Path.Combine(sessionRoot, "source"), "*.jpg").Length);
        foreach (var candidate in candidates) Assert.True(await repository.IsSourceKnownAsync("CARD-A", candidate));
        Assert.Equal(0, (await new ImportService(repository, new VerifiedFileCopier()).ImportAsync(request)).VerifiedCount);
        Assert.Null(await recovery.FindInterruptedAsync("CARD-A", root, card));
    }

    [Fact]
    public async Task PublishedCopyBeforeDatabaseCommitIsReusedWithoutDuplicateImages()
    {
        var root = Path.Combine(Path.GetTempPath(), "bello-import-recovery", Guid.NewGuid().ToString("N"));
        var card = Path.Combine(root, "card"); Directory.CreateDirectory(card);
        await File.WriteAllTextAsync(Path.Combine(card, "one.jpg"), "original image");
        var session = Path.Combine(root, "session");
        var first = await new VerifiedFileCopier().CopyAndVerifyAsync(card, "one.jpg", session);
        var second = await new VerifiedFileCopier().CopyAndVerifyAsync(card, "one.jpg", session);
        Assert.Equal(first.LocalPath, second.LocalPath);
        Assert.Equal(first.Sha256, second.Sha256);
        Assert.Single(Directory.GetFiles(Path.Combine(session, "source")));
        await File.WriteAllTextAsync(Path.Combine(card, "one.jpg"), "changed image!");
        await Assert.ThrowsAsync<IOException>(() => new VerifiedFileCopier().CopyAndVerifyAsync(card, "one.jpg", session));
        Assert.Equal("original image", await File.ReadAllTextAsync(first.LocalPath));
    }

    [Fact]
    public async Task PartialCopyLeftByProcessTerminationCanBeReplacedAndVerified()
    {
        var root = Path.Combine(Path.GetTempPath(), "bello-import-recovery", Guid.NewGuid().ToString("N"));
        var card = Path.Combine(root, "card"); Directory.CreateDirectory(card);
        await File.WriteAllTextAsync(Path.Combine(card, "one.jpg"), "complete original image");
        var session = Path.Combine(root, "session");
        var first = await new VerifiedFileCopier().CopyAndVerifyAsync(card, "one.jpg", session);
        // Only this test's private output is changed; the card remains read-only.
        File.Move(first.LocalPath, first.LocalPath + ".partial");
        await File.WriteAllTextAsync(first.LocalPath + ".partial", "incomplete");
        var resumed = await new VerifiedFileCopier().CopyAndVerifyAsync(card, "one.jpg", session);
        Assert.Equal(first.Sha256, resumed.Sha256);
        Assert.False(File.Exists(first.LocalPath + ".partial"));
        Assert.Single(Directory.GetFiles(Path.Combine(session, "source")));
    }

    private sealed class DisconnectOnSecondCopy : IVerifiedFileCopier
    {
        private int _calls;
        public Task<VerifiedSource> CopyAndVerifyAsync(string sourceRoot, string relativePath, string sessionRoot, CancellationToken cancellationToken = default)
        {
            if (++_calls == 2) throw new IOException("Simulated SD removal");
            return new VerifiedFileCopier().CopyAndVerifyAsync(sourceRoot, relativePath, sessionRoot, cancellationToken);
        }
    }
}

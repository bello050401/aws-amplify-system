using System.Text.Json;
using PhotoStation.Application;
using PhotoStation.Infrastructure;
using PhotoStation.Domain;

namespace PhotoStation.Tests;

public class SourceRetentionTests
{
    [Fact]
    public async Task RealImportCreatesDeadlineBeforeEditingAndLeavesCardUnchanged()
    {
        var root = Path.Combine(Path.GetTempPath(), "bello-import-deadline-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var card = Path.Combine(root,"card"); Directory.CreateDirectory(card);
        var file = Path.Combine(card,"DSC0001.JPG"); await File.WriteAllBytesAsync(file,[1,2,3,4,5]);
        var info = new FileInfo(file); var id = Guid.NewGuid();
        var repo = new SqliteStationRepository(Path.Combine(root,"station.sqlite")); await repo.InitializeAsync();
        var sessionRoot = Path.Combine(root,"sessions",id.ToString("D"));
        var request = new ImportRequest(id,"staging","TEST","SD-A",card,sessionRoot,[new SourceCandidate(info.Name,info.Length,info.LastWriteTimeUtc)]);
        var importer = new ImportService(repo,new VerifiedFileCopier());
        Assert.Equal(1,(await importer.ImportAsync(request)).VerifiedCount);
        var session = (await repo.FindSessionAsync(id))!;
        Assert.Equal(session.CreatedAtUtc.AddDays(7),await SourceRetention.ReadExpiryAsync(sessionRoot));
        Assert.False(File.Exists(Path.Combine(sessionRoot,"retention.json"))); // not edited yet
        Assert.Equal(0,(await importer.ImportAsync(request)).VerifiedCount);
        Assert.Equal(new byte[]{1,2,3,4,5},await File.ReadAllBytesAsync(file));
        Assert.Equal(await File.ReadAllBytesAsync(file),await File.ReadAllBytesAsync(Assert.Single(Directory.GetFiles(Path.Combine(sessionRoot,"source")))));
    }

    [Fact]
    public async Task ImportDeadlineSurvivesRetriesAndRedo()
    {
        var root = Path.Combine(Path.GetTempPath(), "bello-retention-" + Guid.NewGuid().ToString("N"));
        try {
            var imported = DateTimeOffset.Parse("2026-10-01T00:00:00Z");
            Assert.Equal(imported.AddDays(7), await SourceRetention.EnsureAsync(root, imported));
            Assert.Equal(imported.AddDays(7), await SourceRetention.EnsureAsync(root, imported.AddDays(5)));
            var redo = Path.Combine(root, "redo"); Directory.CreateDirectory(redo);
            File.Copy(Path.Combine(root, SourceRetention.FileName), Path.Combine(redo, SourceRetention.FileName));
            Assert.Equal(imported.AddDays(7), await SourceRetention.EnsureAsync(redo, imported.AddDays(6)));
            await File.WriteAllTextAsync(Path.Combine(root, SourceRetention.FileName), "{\"version\":1,\"importedAt\":\"2026-10-01T00:00:00Z\",\"expiresAt\":\"2027-01-01T00:00:00Z\"}");
            await Assert.ThrowsAsync<IOException>(() => SourceRetention.ReadExpiryAsync(root));
        } finally { Directory.Delete(root, recursive:true); }
    }
}

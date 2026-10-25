using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PhotoStation.Domain;

namespace PhotoStation.Application;

public sealed record ImportRequest(Guid SessionId, string Environment, string StationId,
    string CardGenerationId, string SourceRoot, string SessionRoot, IReadOnlyList<SourceCandidate> Candidates);

public sealed record ImportResult(Guid SessionId, ImportSessionState State, int VerifiedCount, bool SafeToRemove);
public sealed record ImportSnapshot(int Version, Guid SessionId, string Environment, string StationId,
    string CardGenerationId, IReadOnlyList<SourceCandidate> Candidates);

public sealed class ImportService(IStationRepository repository, IVerifiedFileCopier copier, TimeProvider? timeProvider = null)
{
    private readonly TimeProvider _time = timeProvider ?? TimeProvider.System;
    private static readonly HashSet<string> AllowedExtensions = new(StringComparer.OrdinalIgnoreCase)
        { ".arw", ".jpg", ".jpeg" };

    public async Task<ImportResult> ImportAsync(ImportRequest request, CancellationToken cancellationToken = default)
    {
        if (request.Candidates.Count == 0) throw new ArgumentException("Empty imports must not create a batch");
        if (request.Candidates.Any(x => !AllowedExtensions.Contains(Path.GetExtension(x.RelativePath))))
            throw new ArgumentException("The snapshot contains an unsupported file type");

        if (request.Candidates.Select(x => x.RelativePath.Replace('\\', '/')).Distinct(StringComparer.OrdinalIgnoreCase).Count() != request.Candidates.Count)
            throw new ArgumentException("The same photo was selected twice");
        // Identity belongs to the complete selection, not the shrinking set of
        // files still to copy after an interrupted card transfer.
        var manifestHash = ManifestHash(request.Candidates);
        var session = await repository.FindSessionAsync(request.SessionId, cancellationToken);
        if (session is not null && (session.ManifestHash != manifestHash || session.CardGenerationId != request.CardGenerationId))
            throw new InvalidOperationException("The same session id was reused with a different manifest");
        var pending = new List<SourceCandidate>();
        foreach (var candidate in request.Candidates)
            if (!await repository.IsSourceKnownAsync(request.CardGenerationId, candidate, cancellationToken)) pending.Add(candidate);
        if (session is null && pending.Count == 0) return new ImportResult(request.SessionId, ImportSessionState.LocalSecured, 0, true);
        if (session is not null && session.State is not (ImportSessionState.Detected or ImportSessionState.Snapshotting or ImportSessionState.Copying))
            return new ImportResult(session.Id, session.State, 0, session.State != ImportSessionState.Cancelled);

        Directory.CreateDirectory(request.SessionRoot);
        var snapshotFile = Path.Combine(request.SessionRoot, "import-manifest.json");
        var snapshot = new ImportSnapshot(1, request.SessionId, request.Environment, request.StationId, request.CardGenerationId, request.Candidates);
        await File.WriteAllTextAsync(snapshotFile + ".tmp", JsonSerializer.Serialize(snapshot), cancellationToken);
        File.Move(snapshotFile + ".tmp", snapshotFile, overwrite: true);
        if (session is null)
        {
            session = new ImportSession(request.SessionId, request.Environment, request.StationId,
                request.CardGenerationId, manifestHash, _time.GetUtcNow());
            await repository.SaveSessionAsync(session, cancellationToken);
        }

        await SourceRetention.EnsureAsync(request.SessionRoot, session.CreatedAtUtc, cancellationToken);
        if (session.State == ImportSessionState.Detected) {
            session.TransitionTo(ImportSessionState.Snapshotting);
            await repository.SaveSessionAsync(session, cancellationToken);
        }

        if (session.State == ImportSessionState.Snapshotting)
        {
            session.TransitionTo(ImportSessionState.Copying);
            await repository.SaveSessionAsync(session, cancellationToken);
        }

        var verified = 0;
        foreach (var candidate in pending.OrderBy(x => x.RelativePath, StringComparer.OrdinalIgnoreCase))
        {
            var file = new FileInfo(Path.Combine(request.SourceRoot, candidate.RelativePath));
            if (!file.Exists || file.Length != candidate.Size || new DateTimeOffset(file.LastWriteTimeUtc) != candidate.ModifiedAtUtc)
                throw new IOException("選択後にSDの写真が変更されたか、カードが外れました。元のカードを入れて再実行してください。");
            var copy = await copier.CopyAndVerifyAsync(request.SourceRoot, candidate.RelativePath,
                request.SessionRoot, cancellationToken);
            if (candidate.Sha256 is not null && !string.Equals(copy.Sha256, candidate.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new IOException("選択した写真とコピーした内容が違います。元のSDカードを確認してください。");
            await repository.AddVerifiedSourceAsync(session.Id, copy, cancellationToken);
            verified++;
        }
        session.TransitionTo(ImportSessionState.LocalSecured);
        await repository.SaveSessionAsync(session, cancellationToken);
        return new ImportResult(session.Id, session.State, verified, SafeToRemove: true);
    }

    public async Task<ImportRequest?> FindInterruptedAsync(string cardGenerationId, string stationRoot, string cardRoot,
        CancellationToken cancellationToken = default)
    {
        var session = (await repository.ListSessionsAsync(cancellationToken)).Where(x => x.CardGenerationId == cardGenerationId
            && x.State is ImportSessionState.Detected or ImportSessionState.Snapshotting or ImportSessionState.Copying)
            .OrderBy(x => x.CreatedAtUtc).FirstOrDefault();
        if (session is null) return null;
        var root = Path.Combine(stationRoot, "sessions", session.Id.ToString("D"));
        var file = Path.Combine(root, "import-manifest.json");
        if (!File.Exists(file)) throw new IOException("以前の取込が中断されています。写真の選択記録がないため、自動で別の商品に分けず保留しました。");
        var snapshot = JsonSerializer.Deserialize<ImportSnapshot>(await File.ReadAllTextAsync(file, cancellationToken));
        if (snapshot is null || snapshot.Version != 1 || snapshot.SessionId != session.Id
            || snapshot.CardGenerationId != cardGenerationId || snapshot.Candidates.Count == 0
            || ManifestHash(snapshot.Candidates) != session.ManifestHash)
            throw new IOException("中断した取込の写真一覧を確認できません。原本を残して保留しました。");
        return new ImportRequest(session.Id, session.Environment, session.StationId, cardGenerationId, cardRoot, root, snapshot.Candidates);
    }

    public static string ManifestHash(IEnumerable<SourceCandidate> candidates)
    {
        var normalized = string.Join("\n", candidates
            .OrderBy(x => x.RelativePath, StringComparer.OrdinalIgnoreCase)
            .Select(x => $"{x.RelativePath.Replace('\\', '/')}\0{x.Size}\0{x.ModifiedAtUtc:O}" + (x.Sha256 is null ? "" : "\0" + x.Sha256.ToLowerInvariant())));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized))).ToLowerInvariant();
    }
}

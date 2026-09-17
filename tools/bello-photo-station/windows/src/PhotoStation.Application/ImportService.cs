using System.Security.Cryptography;
using System.Text;
using PhotoStation.Domain;

namespace PhotoStation.Application;

public sealed record ImportRequest(Guid SessionId, string Environment, string StationId,
    string CardGenerationId, string SourceRoot, string SessionRoot, IReadOnlyList<SourceCandidate> Candidates);

public sealed record ImportResult(Guid SessionId, ImportSessionState State, int VerifiedCount, bool SafeToRemove);

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

        var pending = new List<SourceCandidate>();
        foreach (var candidate in request.Candidates)
            if (!await repository.IsSourceKnownAsync(request.CardGenerationId, candidate, cancellationToken)) pending.Add(candidate);
        if (pending.Count == 0) return new ImportResult(request.SessionId, ImportSessionState.LocalSecured, 0, true);
        var manifestHash = ManifestHash(pending);
        var session = await repository.FindSessionAsync(request.SessionId, cancellationToken);
        if (session is not null)
        {
            if (!string.Equals(session.ManifestHash, manifestHash, StringComparison.Ordinal))
                throw new InvalidOperationException("The same session id was reused with a different manifest");
            if (session.State >= ImportSessionState.LocalSecured)
                return new ImportResult(session.Id, session.State, pending.Count, true);
        }
        else
        {
            session = new ImportSession(request.SessionId, request.Environment, request.StationId,
                request.CardGenerationId, manifestHash, _time.GetUtcNow());
            await repository.SaveSessionAsync(session, cancellationToken);
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
            var copy = await copier.CopyAndVerifyAsync(request.SourceRoot, candidate.RelativePath,
                request.SessionRoot, cancellationToken);
            await repository.AddVerifiedSourceAsync(session.Id, copy, cancellationToken);
            verified++;
        }
        session.TransitionTo(ImportSessionState.LocalSecured);
        await repository.SaveSessionAsync(session, cancellationToken);
        return new ImportResult(session.Id, session.State, verified, SafeToRemove: true);
    }

    public static string ManifestHash(IEnumerable<SourceCandidate> candidates)
    {
        var normalized = string.Join("\n", candidates
            .OrderBy(x => x.RelativePath, StringComparer.OrdinalIgnoreCase)
            .Select(x => $"{x.RelativePath.Replace('\\', '/')}\0{x.Size}\0{x.ModifiedAtUtc:O}"));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized))).ToLowerInvariant();
    }
}

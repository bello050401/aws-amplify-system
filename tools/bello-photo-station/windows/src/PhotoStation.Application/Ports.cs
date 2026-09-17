using PhotoStation.Domain;

namespace PhotoStation.Application;

public interface IStationRepository
{
    Task InitializeAsync(CancellationToken cancellationToken = default);
    Task<ImportSession?> FindSessionAsync(Guid id, CancellationToken cancellationToken = default);
    Task SaveSessionAsync(ImportSession session, CancellationToken cancellationToken = default);
    Task AddVerifiedSourceAsync(Guid sessionId, VerifiedSource source, CancellationToken cancellationToken = default);
    Task<bool> IsSourceKnownAsync(string cardGenerationId, SourceCandidate candidate, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<ImportSession>> ListSessionsAsync(CancellationToken cancellationToken = default);
}

public interface IVerifiedFileCopier
{
    Task<VerifiedSource> CopyAndVerifyAsync(string sourceRoot, string relativePath, string sessionRoot,
        CancellationToken cancellationToken = default);
}

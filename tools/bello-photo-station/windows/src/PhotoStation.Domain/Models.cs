namespace PhotoStation.Domain;

public enum ImportSessionState
{
    Detected,
    Snapshotting,
    Copying,
    LocalSecured,
    Rendering,
    Processing,
    ReadyToUpload,
    Uploading,
    CloudVerifying,
    CloudReadyUnlinked,
    Linked,
    NeedsReview,
    Cancelled
}

public sealed record SourceCandidate(string RelativePath, long Size, DateTimeOffset ModifiedAtUtc);

public sealed record VerifiedSource(
    Guid SourceId,
    string RelativePath,
    string LocalPath,
    long Size,
    string Sha256,
    DateTimeOffset SourceModifiedAtUtc,
    DateTimeOffset VerifiedAtUtc);

public sealed class ImportSession
{
    private static readonly IReadOnlyDictionary<ImportSessionState, ImportSessionState[]> Allowed =
        new Dictionary<ImportSessionState, ImportSessionState[]>
        {
            [ImportSessionState.Detected] = [ImportSessionState.Snapshotting, ImportSessionState.Cancelled],
            [ImportSessionState.Snapshotting] = [ImportSessionState.Copying, ImportSessionState.NeedsReview, ImportSessionState.Cancelled],
            [ImportSessionState.Copying] = [ImportSessionState.LocalSecured, ImportSessionState.NeedsReview, ImportSessionState.Cancelled],
            [ImportSessionState.LocalSecured] = [ImportSessionState.Rendering, ImportSessionState.ReadyToUpload],
            [ImportSessionState.Rendering] = [ImportSessionState.Processing, ImportSessionState.NeedsReview],
            [ImportSessionState.Processing] = [ImportSessionState.ReadyToUpload, ImportSessionState.NeedsReview],
            [ImportSessionState.ReadyToUpload] = [ImportSessionState.Uploading],
            [ImportSessionState.Uploading] = [ImportSessionState.CloudVerifying, ImportSessionState.NeedsReview],
            [ImportSessionState.CloudVerifying] = [ImportSessionState.CloudReadyUnlinked, ImportSessionState.NeedsReview],
            [ImportSessionState.CloudReadyUnlinked] = [ImportSessionState.Linked],
            [ImportSessionState.Linked] = [],
            [ImportSessionState.NeedsReview] = [ImportSessionState.Copying, ImportSessionState.Rendering, ImportSessionState.Processing, ImportSessionState.Uploading, ImportSessionState.Cancelled],
            [ImportSessionState.Cancelled] = []
        };

    public Guid Id { get; }
    public string Environment { get; }
    public string StationId { get; }
    public string CardGenerationId { get; }
    public string ManifestHash { get; }
    public DateTimeOffset CreatedAtUtc { get; }
    public ImportSessionState State { get; private set; }
    public string? HoldReason { get; private set; }

    public ImportSession(Guid id, string environment, string stationId, string cardGenerationId,
        string manifestHash, DateTimeOffset createdAtUtc, ImportSessionState state = ImportSessionState.Detected,
        string? holdReason = null)
    {
        if (id == Guid.Empty) throw new ArgumentException("Session id is required", nameof(id));
        if (environment is not ("staging" or "production")) throw new ArgumentException("Environment must be staging or production");
        Id = id;
        Environment = environment;
        StationId = Require(stationId, nameof(stationId));
        CardGenerationId = Require(cardGenerationId, nameof(cardGenerationId));
        ManifestHash = Require(manifestHash, nameof(manifestHash));
        CreatedAtUtc = createdAtUtc;
        State = state;
        HoldReason = holdReason;
    }

    public void TransitionTo(ImportSessionState next, string? reason = null)
    {
        if (!Allowed.TryGetValue(State, out var nextStates) || !nextStates.Contains(next))
            throw new InvalidOperationException($"Invalid session transition: {State} -> {next}");
        if (next == ImportSessionState.NeedsReview && string.IsNullOrWhiteSpace(reason))
            throw new ArgumentException("NeedsReview requires a reason", nameof(reason));
        State = next;
        HoldReason = next == ImportSessionState.NeedsReview ? reason : null;
    }

    private static string Require(string value, string name) =>
        string.IsNullOrWhiteSpace(value) ? throw new ArgumentException($"{name} is required", name) : value;
}

using PhotoStation.Domain;

namespace PhotoStation.Application;

public static class SessionRecovery
{
    // Called only after the desktop's single-instance guard is held.
    // Copying sessions retain their manifest and resume when their card returns.
    public static async Task<int> RecoverProcessingAsync(IStationRepository repository, CancellationToken cancellationToken = default)
    {
        var recovered = 0;
        foreach (var session in await repository.ListSessionsAsync(cancellationToken))
        {
            if (session.State is not (ImportSessionState.Rendering or ImportSessionState.Processing
                or ImportSessionState.ReadyToUpload or ImportSessionState.Uploading)) continue;
            session.TransitionTo(ImportSessionState.NeedsReview, "前回の処理が中断されました。原本から再実行できます。");
            await repository.SaveSessionAsync(session, cancellationToken);
            recovered++;
        }
        return recovered;
    }
}

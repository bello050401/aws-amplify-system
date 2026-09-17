using Microsoft.Data.Sqlite;
using PhotoStation.Application;
using PhotoStation.Domain;

namespace PhotoStation.Infrastructure;

public sealed class SqliteStationRepository(string databasePath) : IStationRepository
{
    private readonly string _connectionString = new SqliteConnectionStringBuilder
    {
        DataSource = Path.GetFullPath(databasePath),
        Mode = SqliteOpenMode.ReadWriteCreate,
        Cache = SqliteCacheMode.Shared,
        Pooling = false
    }.ToString();

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(databasePath))!);
        await using var connection = await OpenAsync(cancellationToken);
        await ExecuteAsync(connection, "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;", cancellationToken);
        await ExecuteAsync(connection, """
            CREATE TABLE IF NOT EXISTS import_sessions(
              id TEXT PRIMARY KEY, environment TEXT NOT NULL, station_id TEXT NOT NULL,
              card_generation_id TEXT NOT NULL, manifest_hash TEXT NOT NULL,
              state TEXT NOT NULL, hold_reason TEXT NULL, created_at_utc TEXT NOT NULL,
              updated_at_utc TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS source_files(
              source_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES import_sessions(id),
              relative_path TEXT NOT NULL, local_path TEXT NOT NULL, size INTEGER NOT NULL,
              sha256 TEXT NOT NULL, source_mtime_utc TEXT NOT NULL, verified_at_utc TEXT NOT NULL,
              UNIQUE(session_id, relative_path)
            );
            CREATE TABLE IF NOT EXISTS audit_events(
              id INTEGER PRIMARY KEY AUTOINCREMENT, at_utc TEXT NOT NULL, event_code TEXT NOT NULL,
              session_id TEXT NULL, detail TEXT NOT NULL
            );
            """, cancellationToken);
        try { await ExecuteAsync(connection, "ALTER TABLE source_files ADD COLUMN source_mtime_utc TEXT NOT NULL DEFAULT '';", cancellationToken); }
        catch (SqliteException error) when (error.SqliteErrorCode == 1) { /* additive migration already applied */ }
    }

    public async Task<ImportSession?> FindSessionAsync(Guid id, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT * FROM import_sessions WHERE id=$id";
        command.Parameters.AddWithValue("$id", id.ToString("D"));
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? Hydrate(reader) : null;
    }

    public async Task SaveSessionAsync(ImportSession session, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.Transaction = (SqliteTransaction)transaction;
        command.CommandText = """
            INSERT INTO import_sessions(id,environment,station_id,card_generation_id,manifest_hash,state,hold_reason,created_at_utc,updated_at_utc)
            VALUES($id,$environment,$station,$generation,$manifest,$state,$reason,$created,$updated)
            ON CONFLICT(id) DO UPDATE SET state=excluded.state,hold_reason=excluded.hold_reason,updated_at_utc=excluded.updated_at_utc
            WHERE import_sessions.environment=excluded.environment AND import_sessions.station_id=excluded.station_id
              AND import_sessions.card_generation_id=excluded.card_generation_id AND import_sessions.manifest_hash=excluded.manifest_hash;
            """;
        command.Parameters.AddWithValue("$id", session.Id.ToString("D"));
        command.Parameters.AddWithValue("$environment", session.Environment);
        command.Parameters.AddWithValue("$station", session.StationId);
        command.Parameters.AddWithValue("$generation", session.CardGenerationId);
        command.Parameters.AddWithValue("$manifest", session.ManifestHash);
        command.Parameters.AddWithValue("$state", session.State.ToString());
        command.Parameters.AddWithValue("$reason", (object?)session.HoldReason ?? DBNull.Value);
        command.Parameters.AddWithValue("$created", session.CreatedAtUtc.ToString("O"));
        command.Parameters.AddWithValue("$updated", DateTimeOffset.UtcNow.ToString("O"));
        var changed = await command.ExecuteNonQueryAsync(cancellationToken);
        if (changed != 1) throw new InvalidOperationException("Session id conflicts with immutable session identity");
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task AddVerifiedSourceAsync(Guid sessionId, VerifiedSource source, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO source_files(source_id,session_id,relative_path,local_path,size,sha256,source_mtime_utc,verified_at_utc)
            VALUES($source,$session,$relative,$local,$size,$sha,$mtime,$verified)
            ON CONFLICT(session_id,relative_path) DO UPDATE SET
              local_path=excluded.local_path,size=excluded.size,sha256=excluded.sha256,verified_at_utc=excluded.verified_at_utc
            WHERE source_files.sha256=excluded.sha256 AND source_files.size=excluded.size;
            """;
        command.Parameters.AddWithValue("$source", source.SourceId.ToString("D"));
        command.Parameters.AddWithValue("$session", sessionId.ToString("D"));
        command.Parameters.AddWithValue("$relative", source.RelativePath);
        command.Parameters.AddWithValue("$local", source.LocalPath);
        command.Parameters.AddWithValue("$size", source.Size);
        command.Parameters.AddWithValue("$sha", source.Sha256);
        command.Parameters.AddWithValue("$mtime", source.SourceModifiedAtUtc.ToString("O"));
        command.Parameters.AddWithValue("$verified", source.VerifiedAtUtc.ToString("O"));
        var changed = await command.ExecuteNonQueryAsync(cancellationToken);
        if (changed != 1) throw new InvalidOperationException("Source path conflicts with different content");
    }

    public async Task<bool> IsSourceKnownAsync(string cardGenerationId, SourceCandidate candidate, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT 1 FROM source_files f JOIN import_sessions s ON s.id=f.session_id
            WHERE s.card_generation_id=$generation AND f.relative_path=$relative
              AND f.size=$size AND f.source_mtime_utc=$mtime LIMIT 1
            """;
        command.Parameters.AddWithValue("$generation", cardGenerationId);
        command.Parameters.AddWithValue("$relative", candidate.RelativePath);
        command.Parameters.AddWithValue("$size", candidate.Size);
        command.Parameters.AddWithValue("$mtime", candidate.ModifiedAtUtc.ToString("O"));
        return await command.ExecuteScalarAsync(cancellationToken) is not null;
    }

    public async Task<IReadOnlyList<ImportSession>> ListSessionsAsync(CancellationToken cancellationToken = default)
    {
        var list = new List<ImportSession>();
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT * FROM import_sessions ORDER BY created_at_utc DESC LIMIT 200";
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken)) list.Add(Hydrate(reader));
        return list;
    }

    private async Task<SqliteConnection> OpenAsync(CancellationToken cancellationToken)
    {
        var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;";
        await command.ExecuteNonQueryAsync(cancellationToken);
        return connection;
    }

    private static async Task ExecuteAsync(SqliteConnection connection, string sql, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static ImportSession Hydrate(SqliteDataReader reader) => new(
        Guid.Parse(reader.GetString(reader.GetOrdinal("id"))),
        reader.GetString(reader.GetOrdinal("environment")),
        reader.GetString(reader.GetOrdinal("station_id")),
        reader.GetString(reader.GetOrdinal("card_generation_id")),
        reader.GetString(reader.GetOrdinal("manifest_hash")),
        DateTimeOffset.Parse(reader.GetString(reader.GetOrdinal("created_at_utc"))),
        Enum.Parse<ImportSessionState>(reader.GetString(reader.GetOrdinal("state"))),
        reader.IsDBNull(reader.GetOrdinal("hold_reason")) ? null : reader.GetString(reader.GetOrdinal("hold_reason")));
}

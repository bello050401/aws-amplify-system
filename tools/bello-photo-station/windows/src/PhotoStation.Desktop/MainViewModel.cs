using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Windows.Input;
using PhotoStation.Application;
using PhotoStation.Domain;
using PhotoStation.Infrastructure;

namespace PhotoStation.Desktop;
public sealed class MainViewModel : INotifyPropertyChanged
{
    private readonly string _root;
    private readonly string? _nodeScriptsDir = Environment.GetEnvironmentVariable("BELLO_PHOTO_STATION_NODE_DIR")
        ?? (Directory.Exists(Path.Combine(AppContext.BaseDirectory, "pipeline")) ? Path.Combine(AppContext.BaseDirectory, "pipeline") : null);
    private readonly string? _apiEndpoint = Environment.GetEnvironmentVariable("BELLO_PHOTO_STATION_API_ENDPOINT");
    private readonly string _nodeExecutable = Environment.GetEnvironmentVariable("BELLO_PHOTO_STATION_NODE_EXE")
        ?? (File.Exists(Path.Combine(AppContext.BaseDirectory, "node.exe")) ? Path.Combine(AppContext.BaseDirectory, "node.exe") : "node");
    private readonly SqliteStationRepository _repository;
    private readonly ImportService _importer;
    private DriveInfo? _drive;
    private string _detectedDriveText = "SDカードを検出しています…", _statusText = "準備中";
    private bool _busy;
    private DestinationSettings _destination = new();
    private readonly DestinationSettingsStore _destinationStore;
    public string[] DestinationNames { get; } = ["BELLO WEB 自社システム", "使用中のPC", "社内共有フォルダー"];
    private string _connectionStatus = "WEBへ保存する場合は、写真用アカウントでログインしてください。";
    public string ConnectionStatus { get => _connectionStatus; private set => Set(ref _connectionStatus, value); }
    public bool CanChangeDestination => !_busy;
    public bool IsFolderDestination => DestinationIndex != 0;
    public int DestinationIndex
    {
        get => _destination.SelectedIndex;
        set { _destination = _destination with { SelectedIndex = value is >= 0 and <= 2 ? value : 0 }; NotifyDestination(); }
    }
    public string DestinationFolder
    {
        get => DestinationIndex == 2 ? _destination.SharedFolder : _destination.PcFolder;
        set { _destination = DestinationIndex == 2 ? _destination with { SharedFolder = value } : _destination with { PcFolder = value }; NotifyDestination(); }
    }
    public string DestinationHelp => DestinationIndex switch {
        0 => "既存のAPIでBELLO WEBの画像登録へ保存します。初回は写真用アカウントでログインします。",
        1 => "このPCの保存先を選んでください。ログイン不要で、インターネット接続なしでも保存できます。",
        _ => "共有フォルダーのパスを入力、または選択してください。社外では社内VPNなどで共有先へ接続してください。" };
    private void NotifyDestination() { foreach (var name in new[] { nameof(DestinationIndex), nameof(DestinationFolder), nameof(DestinationHelp), nameof(IsFolderDestination) }) PropertyChanged?.Invoke(this, new(name)); }
    public Func<string, Task<bool>>? SelectPresetAsync { get; set; }
    public Func<Task<bool>>? EnsureLightroomReadyAsync { get; set; }
    public Func<IReadOnlyList<FileInfo>, Task<IReadOnlyList<FileInfo>?>>? SelectProductImagesAsync { get; set; }
    private ImportSession? _selectedSession;
    public ImportSession? SelectedSession { get => _selectedSession; set { Set(ref _selectedSession, value); RaiseCommands(); } }
    private readonly System.Windows.Threading.DispatcherTimer _cardTimer = new() { Interval = TimeSpan.FromSeconds(5) };
    private readonly System.Windows.Threading.DispatcherTimer _retentionTimer = new() { Interval = TimeSpan.FromMinutes(30) };
    private bool _cleaningSources;
    private string? _presentCard;
    public bool IsBusy => _busy;
    public ObservableCollection<ImportSession> Sessions { get; } = [];
    public string DetectedDriveText { get => _detectedDriveText; private set => Set(ref _detectedDriveText, value); }
    public string StatusText { get => _statusText; private set => Set(ref _statusText, value); }
    public string RecipeSummary => "タッチで位置を調整 → 完了 → Lightroomで現像 ・ 正方形／3:2を統一 ・ 余白を追加せず保存";
    public string AppHeading => App.IsTestMode ? "BELLO Photo Station r12 テスト用" : "BELLO Photo Station r12";
    private string _lightroomStatus = "Lightroom Classic を確認しています…";
    public string LightroomStatus { get => _lightroomStatus; set => Set(ref _lightroomStatus, value); }
    public string ProcessingAvailabilityText => _nodeScriptsDir is null
        ? "画像処理に必要なファイルが見つかりません。インストーラーから再インストールしてください。"
        : "「位置を調整して保存」で写真の位置と仕上がりを選びます。「完了・現像へ」を押すと、Lightroom Classicで現像して保存します。";
    public ICommand RefreshCommand { get; }
    public ICommand ImportCommand { get; }
    public ICommand UploadCommand { get; }
    public ICommand RedoCommand { get; }
    public ICommand LoginCommand { get; }
    public ICommand OpenOriginalsCommand { get; }
    public string OriginalRetentionHelp => "WEB保存では、取り込み直後に編集前写真をクラウドへ保存し、保存から7日間保管します。Webの画像登録から確認できます。期限後は自動削除します。SDカード内の写真は変更しません。";
    public EditSettingsStore SettingsStore { get; }
    public string PreviewOutputDir => Path.Combine(_root, "preview");
    public MainViewModel()
    {
        _root = Environment.GetEnvironmentVariable("BELLO_PHOTO_STATION_ROOT") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BELLO", "PhotoStation", "staging");
        _destinationStore = new DestinationSettingsStore(Path.Combine(_root, "destination.json"));
        _repository = new SqliteStationRepository(Path.Combine(_root, "db", "station.sqlite"));
        _importer = new ImportService(_repository, new VerifiedFileCopier());
        SettingsStore = new EditSettingsStore(Path.Combine(_root, "settings.json"));
        RefreshCommand = new AsyncCommand(RefreshAsync, () => !_busy);
        ImportCommand = new AsyncCommand(ImportAsync, () => !_busy && _drive is not null);
        UploadCommand = new AsyncCommand(UploadAsync, () => !_busy && _nodeScriptsDir is not null && (SelectedSession is { } selected ? IsUploadCandidate(selected) : Sessions.Any(IsUploadCandidate)));
        RedoCommand = new AsyncCommand(RedoAsync, () => !_busy && _nodeScriptsDir is not null && SelectedSession is { Environment: "staging", State: ImportSessionState.CloudVerifying });
        LoginCommand = new AsyncCommand(LoginAsync, () => !_busy && _nodeScriptsDir is not null);
        OpenOriginalsCommand = new AsyncCommand(OpenOriginalsAsync, () => !_busy && SelectedSession is not null);
        _cardTimer.Tick += async (_, _) => await DetectInsertionAsync();
        _retentionTimer.Tick += async (_, _) => await CleanupExpiredSourcesAsync();
    }

    public IPreviewRunner? CreatePreviewRunner() =>
        _nodeScriptsDir is null ? null : new NodePreviewRunner(_nodeExecutable, NodeScriptPath("previewCli.mjs"));
    public PresetWorkflowRunner? CreatePresetRunner() => _nodeScriptsDir is null ? null : new(_nodeExecutable, NodeScriptPath("presetCli.mjs"), _root);
    public async Task InitializeAsync() {
        try {
            var firstTestLaunch = App.IsTestMode && !File.Exists(Path.Combine(_root, "destination.json"));
            _destination = await _destinationStore.LoadAsync();
            if (firstTestLaunch) {
                var folder = Path.GetFullPath(Path.Combine(_root, "..", "保存写真"));
                Directory.CreateDirectory(folder);
                _destination = new DestinationSettings(0, folder);
            }
            NotifyDestination();
        }
        catch { StatusText = "保存先の設定を読み込めませんでした。保存先を選び直してください。"; }
        await _repository.InitializeAsync();
        // The single-instance guard ensures no other pipeline owns these states.
        // A power loss or interrupted network save can safely resume on launch.
        await SessionRecovery.RecoverProcessingAsync(_repository);
        await RefreshAsync();
        await CleanupExpiredSourcesAsync();
        _retentionTimer.Start(); _cardTimer.Start(); await DetectInsertionAsync();
    }
    public async Task SaveDestinationAsync() => await _destinationStore.SaveAsync(_destination);
    private async Task<bool> EnsureWebConnectionAsync()
    {
        if (!PhotoEndpointSafety.IsAllowedValidationEndpoint(_apiEndpoint))
            throw new InvalidOperationException("自社システムの接続設定を読み込めません。フォルダー全体を展開して起動してください。");
        if (!await ValidationSession.TryRestoreAsync() && new ValidationLoginWindow { Owner = System.Windows.Application.Current.MainWindow }.ShowDialog() != true)
        {
            ConnectionStatus = "WEBに未接続です。［WEBにログイン］から再度ログインできます。";
            return false;
        }
        _ = ValidationSession.DeviceId();
        ConnectionStatus = "自社システムに接続済みです。写真をWEBへ保存できます。";
        return true;
    }
    private async Task LoginAsync()
    {
        _busy = true; RaiseCommands();
        try
        {
            DestinationIndex = 0;
            await SaveDestinationAsync();
            if (await EnsureWebConnectionAsync()) StatusText = "自社システムへの接続を確認しました。SDカードの写真を取り込んでください。";
        }
        catch (Exception error) { ConnectionStatus = error.Message; StatusText = "WEBへ接続できませんでした。写真は保持しています。"; }
        finally { _busy = false; RaiseCommands(); }
    }
    public void MarkSignedOut() => ConnectionStatus = "ログアウトしました。［WEBにログイン］から接続してください。";
    public string StationRoot => _root;
    public void StopDetection() { _cardTimer.Stop(); _retentionTimer.Stop(); }
    private async Task DetectInsertionAsync()
    {
        if (_busy) return;
        try
        {
            var configured = Environment.GetEnvironmentVariable("BELLO_PHOTO_CARD_ROOT");
            var drive = DriveInfo.GetDrives().FirstOrDefault(x => x.IsReady && (string.IsNullOrWhiteSpace(configured)
                ? x.DriveType == DriveType.Removable : string.Equals(x.RootDirectory.FullName, Path.GetPathRoot(configured), StringComparison.OrdinalIgnoreCase)));
            if (drive is null) {
                if (_presentCard is not null || _drive is not null) {
                    _presentCard = null; _drive = null;
                    DetectedDriveText = "SDカードが取り外されました";
                    RaiseCommands();
                }
                return;
            }
            var identity = drive.Name + CardIdentity.Read(drive);
            if (_presentCard == identity) return;
            _presentCard = identity; _drive = drive;
            DetectedDriveText = $"{drive.Name}：カードを検出しました";
            await ImportAsync();
        }
        catch (Exception error) { StatusText = "カードの自動取込を保留しました：" + error.Message; }
    }
    private async Task LoadSessionsAsync()
    {
        var selected = SelectedSession?.Id;
        Sessions.Clear();
        foreach (var session in await _repository.ListSessionsAsync()) Sessions.Add(session);
        SelectedSession = Sessions.FirstOrDefault(s => s.Id == selected) ?? Sessions.FirstOrDefault(IsUploadCandidate);
    }
    private async Task RefreshAsync()
    {
        var configuredRoot = Environment.GetEnvironmentVariable("BELLO_PHOTO_CARD_ROOT");
        _drive = !string.IsNullOrWhiteSpace(configuredRoot)
            ? DriveInfo.GetDrives().FirstOrDefault(x => x.IsReady && string.Equals(x.RootDirectory.FullName, Path.GetPathRoot(configuredRoot), StringComparison.OrdinalIgnoreCase))
            : DriveInfo.GetDrives().FirstOrDefault(x => x.IsReady && x.DriveType == DriveType.Removable);
        DetectedDriveText = _drive is null ? "リムーバブルSDカードは見つかりません" : $"{_drive.Name}  {(_drive.VolumeLabel.Length == 0 ? "（ラベルなし）" : _drive.VolumeLabel)}  空き {ToGiB(_drive.AvailableFreeSpace):F1} GiB";
        await LoadSessionsAsync();
        StatusText = _drive is null ? "カードを挿すと再検出できます" : "カードは読み取り専用の取込元として認識されています";
        RaiseCommands();
    }
    private async Task ImportAsync()
    {
        if (_drive is null) return; _busy = true; RaiseCommands();
        Guid? importedSession = null;
        try
        {
            var cardRoot = Environment.GetEnvironmentVariable("BELLO_PHOTO_CARD_ROOT") ?? _drive.RootDirectory.FullName;
            var generation = CardIdentity.Read(_drive);
            var interrupted = await _importer.FindInterruptedAsync(generation, _root, cardRoot)
                ?? await _importer.FindInterruptedAsync(CardIdentity.Legacy(_drive), _root, cardRoot);
            if (interrupted is not null)
            {
                StatusText = "前回中断した1商品分の写真を続きから取り込んでいます…";
                var resumed = await _importer.ImportAsync(interrupted);
                if (resumed.SafeToRemove) importedSession = resumed.SessionId;
                StatusText = "中断した商品のコピーと照合が完了しました。SDを取り外せます";
                await LoadSessionsAsync();
            }
            else
            {
            var dcim = Path.Combine(cardRoot, "DCIM");
            if (!Directory.Exists(dcim)) throw new DirectoryNotFoundException("SDカードにDCIMフォルダーがありません");
            var files = Directory.EnumerateFiles(dcim, "*", SearchOption.AllDirectories).Where(x => new[] { ".arw", ".jpg", ".jpeg" }.Contains(Path.GetExtension(x), StringComparer.OrdinalIgnoreCase)).Select(x => new FileInfo(x)).ToArray();
            if (files.Length == 0) { StatusText = "新しい画像候補はありません"; return; }
            // After importing one product, offer only photos that were not
            // already copied and verified. The user can return to the same SD
            // card and choose the next product without finding it among old
            // images or accidentally creating a duplicate batch.
            var remaining = new List<FileInfo>();
            var known = await _repository.LoadKnownSourceHashesAsync(generation, CardIdentity.Legacy(_drive));
            foreach (var file in files) {
                var source = new SourceCandidate(Path.GetRelativePath(cardRoot, file.FullName), file.Length, file.LastWriteTimeUtc);
                // Older versions identified cards only by capacity/label. A
                // hash match keeps those imports deduplicated without confusing
                // another same-size card with the same camera filenames.
                if (known.TryGetValue(source, out var hashes)) {
                    await using var input = file.OpenRead();
                    var hash = Convert.ToHexString(await SHA256.HashDataAsync(input)).ToLowerInvariant();
                    if (hashes.Contains(hash)) continue;
                }
                remaining.Add(file);
            }
            if (remaining.Count == 0) { StatusText = "このSDカードの写真はすべて取込済みです"; return; }
            if (SelectProductImagesAsync is null) { StatusText = "商品単位の写真選択画面を起動できないため取込を保留しました"; return; }
            var chosen = await SelectProductImagesAsync(remaining);
            if (chosen is null || chosen.Count == 0) { StatusText = "取込を保留しました。SDカードの写真は変更していません。"; return; }
            var allowed = remaining.Select(x => x.FullName).ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (chosen.Any(x => !allowed.Contains(x.FullName))) throw new InvalidOperationException("選択した写真がSDカードの候補にありません");
            if (CardIdentity.Read(new DriveInfo(cardRoot)) != generation)
                throw new IOException("写真の選択中にSDカードが交換されました。元のカードを入れてやり直してください。");
            var candidates = new List<SourceCandidate>();
            foreach (var file in chosen) {
                await using var input = file.OpenRead();
                var hash = Convert.ToHexString(await SHA256.HashDataAsync(input)).ToLowerInvariant();
                candidates.Add(new(Path.GetRelativePath(cardRoot, file.FullName), file.Length, file.LastWriteTimeUtc, hash));
            }
            var sessionId = StableSessionId(generation, ImportService.ManifestHash(candidates)); StatusText = $"{candidates.Count}件をSSDへコピーして照合しています…";
            var result = await _importer.ImportAsync(new ImportRequest(sessionId, "staging", Environment.GetEnvironmentVariable("BELLO_PHOTO_STATION_ID") ?? "UNREGISTERED-STATION", generation, cardRoot, Path.Combine(_root, "sessions", sessionId.ToString("D")), candidates));
            if (result.VerifiedCount > 0 && result.SafeToRemove) importedSession = sessionId;
            StatusText = result.SafeToRemove
                ? result.VerifiedCount > 0
                    ? $"コピーと照合完了（{result.VerifiedCount}件）：SDを取り外せます"
                    : $"新しい画像はありません（{candidates.Count}件は取込済み）：SDを取り外せます"
                : "取込を保留しています";
            // 履歴だけを更新する。RefreshAsyncはカード検出文言を設定するため、
            // ここで呼ぶと利用者が必要とする完了結果が直後に消えてしまう。
            await LoadSessionsAsync();
            }
        }
        catch (Exception error) { StatusText = "取込を完了できませんでした：" + error.Message; }
        finally { _busy = false; RaiseCommands(); }
        if (importedSession is { } id && _nodeScriptsDir is not null)
        {
            SelectedSession = Sessions.FirstOrDefault(s => s.Id == id);
            await UploadAsync();
        }
    }
    private async Task UploadAsync()
    {
        if (_nodeScriptsDir is null) return;
        var target = SelectedSession ?? Sessions.FirstOrDefault(IsUploadCandidate);
        if (target is null) return;
        _busy = true; RaiseCommands();
        try
        {
            var destination = DestinationIndex switch { 1 => "pc", 2 => "shared", _ => "web" };
            var folder = destination == "web" ? null : DestinationFolder.Trim();
            if (destination != "web" && (string.IsNullOrWhiteSpace(folder) || !Path.IsPathFullyQualified(folder) || !Directory.Exists(folder)))
            { StatusText = "保存先のフォルダーが見つかりません。フォルダーの選択・共有先への接続を確認してください。"; return; }
            await SaveDestinationAsync();
            if (destination == "web" && !await EnsureWebConnectionAsync())
            { StatusText = "BELLO WEBのログインをキャンセルしました。取込済み写真から再開できます。"; return; }
            if(destination == "web") {
                var rawRoot=Path.Combine(_root,"sessions",target.Id.ToString("D"));
                var rawRunner=new NodeCliPipelineRunner(_nodeExecutable,NodeScriptPath("cli.mjs"),new EnvironmentTokenProvider(),archiveOnly:true);
                var rawRequest=new PhotoUploadRequest(target.Id.ToString("D"),Path.Combine(rawRoot,"source"),rawRoot,Path.Combine(_root,"settings.json"),Path.Combine(_root,"history.json"),ValidationSession.DeviceId(),_apiEndpoint ?? "");
                var rawResult=await rawRunner.RunAsync(rawRequest.ToPipelineRequest(),message=>StatusText=message);
                if(rawResult.Status!="ORIGINALS_ARCHIVED")throw new IOException("編集前写真の一時保管が未完了です。再実行してください。");
            }
            // Do not start the edit/upload pipeline while the renderer is offline.
            // Imported originals and session state remain untouched on failure.
            if (EnsureLightroomReadyAsync is null || !await EnsureLightroomReadyAsync())
            {
                StatusText = "Lightroomに未接続のため、保存処理は開始していません。写真は保持されています。［Lightroomを接続］で接続してから再実行してください。";
                return;
            }
            if (SelectPresetAsync is null || !await SelectPresetAsync(target.Id.ToString("D")))
            { StatusText = "途中の位置を保存しました。取込履歴から再開できます。"; return; }
            var runner = new NodeCliPipelineRunner(_nodeExecutable, NodeScriptPath("cli.mjs"), new EnvironmentTokenProvider());
            var service = new PhotoUploadService(_repository, runner);
            var sessionRoot = Path.Combine(_root, "sessions", target.Id.ToString("D"));
            var request = new PhotoUploadRequest(
                target.Id.ToString("D"),
                Path.Combine(sessionRoot, "source"),
                sessionRoot,
                Path.Combine(_root, "settings.json"),
                Path.Combine(_root, "history.json"),
                destination == "web" ? ValidationSession.DeviceId() : Environment.MachineName,
                _apiEndpoint ?? "",
                Destination: destination, ExportDirectory: folder);
            var outcome = await service.UploadAsync(request, stage => StatusText = stage);
            StatusText = DescribeUploadOutcome(outcome);
            await LoadSessionsAsync();
        }
        catch (Exception error) { StatusText = "写真の保存を完了できませんでした：" + error.Message; }
        finally { _busy = false; RaiseCommands(); }
    }
    private static string DescribeUploadOutcome(UploadOutcome outcome) => outcome.State switch
    {
        ImportSessionState.LocalSaved => "写真の保存と照合が完了しました。保存先：" + outcome.Pipeline?.SavedDirectory,
        ImportSessionState.CloudVerifying => "BELLO WEBへの保存が完了しました。画像登録画面から商品との紐付けを行えます。SDカードを取り外せます。",
        ImportSessionState.NeedsReview => "写真の保存に失敗しました。原本を保持しているので再実行できます：" + (outcome.Error ?? outcome.Pipeline?.UploadFailures.FirstOrDefault()?.Message ?? "詳細は処理履歴を確認してください"),
        _ => "保存処理が終了しました：" + outcome.State,
    };
    private async Task RedoAsync()
    {
        var previous = SelectedSession;
        if (previous is not { Environment: "staging", State: ImportSessionState.CloudVerifying }) return;
        _busy = true; RaiseCommands();
        try
        {
            var originalRoot = Path.Combine(_root, "sessions", previous.Id.ToString("D"));
            var expiresAt = await SourceRetention.EnsureAsync(originalRoot, previous.CreatedAtUtc);
            if (DateTimeOffset.UtcNow >= expiresAt) throw new InvalidOperationException("再編集用の原本は取込から7日間の期限を過ぎています");
            var sourceDir = Path.Combine(originalRoot, "source");
            var sources = Directory.GetFiles(sourceDir, "*", SearchOption.TopDirectoryOnly)
                .Where(file => new[] { ".jpg", ".jpeg", ".arw" }.Contains(Path.GetExtension(file), StringComparer.OrdinalIgnoreCase)).ToArray();
            if (sources.Length == 0) throw new InvalidOperationException("再編集用の原本がありません");
            var newId = Guid.NewGuid();
            var newRoot = Path.Combine(_root, "sessions", newId.ToString("D"));
            var newSourceDir = Path.Combine(newRoot, "source");
            Directory.CreateDirectory(newSourceDir);
            foreach (var file in sources)
            {
                var destination = Path.Combine(newSourceDir, Path.GetFileName(file));
                File.Copy(file, destination, overwrite: false);
                await using var sourceStream = File.OpenRead(file);
                var expected = await SHA256.HashDataAsync(sourceStream);
                await using var destinationStream = File.OpenRead(destination);
                var actual = await SHA256.HashDataAsync(destinationStream);
                if (!expected.AsSpan().SequenceEqual(actual)) throw new IOException("再編集用の原本コピーを照合できません");
            }
            foreach (var name in new[] { "framing-overrides.json", "selections.json", "touch-framing.json", "touch-framing-draft.json", SourceRetention.FileName })
            {
                var from = Path.Combine(originalRoot, name);
                if (File.Exists(from)) File.Copy(from, Path.Combine(newRoot, name), overwrite: false);
            }
            var oldChoice = Path.Combine(originalRoot, "framing-choice.json");
            if (File.Exists(oldChoice))
            {
                using var choice = JsonDocument.Parse(await File.ReadAllTextAsync(oldChoice));
                var topFileName = choice.RootElement.GetProperty("topFileName").GetString();
                await File.WriteAllTextAsync(Path.Combine(newRoot, "framing-choice.json"),
                    JsonSerializer.Serialize(new { topFileName }));
            }
            await File.WriteAllTextAsync(Path.Combine(newRoot, "redo-of.json"),
                JsonSerializer.Serialize(new { originalSessionId = previous.Id, createdAt = DateTimeOffset.UtcNow }));
            var successor = new ImportSession(newId, "staging", previous.StationId, previous.CardGenerationId,
                previous.ManifestHash, DateTimeOffset.UtcNow, ImportSessionState.LocalSecured);
            await _repository.SaveSessionAsync(successor);
            await LoadSessionsAsync();
            SelectedSession = Sessions.FirstOrDefault(s => s.Id == newId);
            StatusText = $"元画像{sources.Length}枚を再編集用に照合しました。仕上がりを選んで処理します。";
        }
        catch (Exception error) { StatusText = "再編集を開始できませんでした：" + error.Message; }
        finally { _busy = false; RaiseCommands(); }
        if (SelectedSession is { } selected && selected.Id != previous.Id && IsUploadCandidate(selected))
        {
            await UploadAsync();
            if (SelectedSession?.State == ImportSessionState.CloudVerifying)
                StatusText += " 新しい検証バッチを確認してから紐付けてください。旧バッチは履歴として残ります。";
        }
    }
    private Task OpenOriginalsAsync()
    {
        if (SelectedSession is not { } session) return Task.CompletedTask;
        var folder = Path.Combine(_root, "sessions", session.Id.ToString("D"), "source");
        if (!Directory.Exists(folder)) { StatusText = "一時保管の元画像はありません。7日間の保管期限を過ぎた画像は自動整理されます。"; return Task.CompletedTask; }
        Process.Start(new ProcessStartInfo(folder) { UseShellExecute = true });
        return Task.CompletedTask;
    }
    private void RaiseCommands() { PropertyChanged?.Invoke(this, new(nameof(CanChangeDestination))); (RefreshCommand as AsyncCommand)?.RaiseCanExecuteChanged(); (ImportCommand as AsyncCommand)?.RaiseCanExecuteChanged(); (UploadCommand as AsyncCommand)?.RaiseCanExecuteChanged(); (RedoCommand as AsyncCommand)?.RaiseCanExecuteChanged(); (LoginCommand as AsyncCommand)?.RaiseCanExecuteChanged(); (OpenOriginalsCommand as AsyncCommand)?.RaiseCanExecuteChanged(); }
    private static bool IsUploadCandidate(ImportSession session) =>
        session.State is ImportSessionState.LocalSecured or ImportSessionState.NeedsReview or ImportSessionState.LocalSaved;
    private async Task CleanupExpiredSourcesAsync()
    {
        if (_busy || _cleaningSources || _nodeScriptsDir is null || !File.Exists(NodeScriptPath("retentionCli.mjs"))) return;
        _cleaningSources = true;
        _busy = true; RaiseCommands();
        // Only sessions whose upload finished can lose their temporary RAW
        // copy. A review/retry or upload in progress is never on this list.
        try
        {
            var sessions = (await _repository.ListSessionsAsync()).Where(session => session.State is
                (ImportSessionState.CloudVerifying or ImportSessionState.CloudReadyUnlinked or ImportSessionState.Linked or ImportSessionState.LocalSaved)).ToArray();
            foreach (var session in sessions)
                await SourceRetention.EnsureAsync(Path.Combine(_root, "sessions", session.Id.ToString("D")), session.CreatedAtUtc);
            var eligible = sessions.Select(session => session.Id.ToString("D")).ToArray();
            async Task<JsonDocument> RunAsync(string mode, string[] ids)
            {
                var start = new ProcessStartInfo(_nodeExecutable) { RedirectStandardOutput = true,
                    RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
                start.ArgumentList.Add(NodeScriptPath("retentionCli.mjs"));
                start.ArgumentList.Add(_root);
                start.ArgumentList.Add(JsonSerializer.Serialize(ids));
                start.ArgumentList.Add(mode);
                using var process = Process.Start(start) ?? throw new InvalidOperationException("整理処理を開始できません");
                var stdout = await process.StandardOutput.ReadToEndAsync();
                var stderr = await process.StandardError.ReadToEndAsync();
                await process.WaitForExitAsync();
                if (process.ExitCode != 0) throw new InvalidOperationException(stderr.Trim());
                var line = stdout.Split('\n').FirstOrDefault(value => value.StartsWith("RESULT_JSON:", StringComparison.Ordinal))
                    ?? throw new InvalidOperationException("整理処理の結果を読めません");
                return JsonDocument.Parse(line["RESULT_JSON:".Length..]);
            }
            using var inspected = await RunAsync("inspect", eligible);
            var approved = inspected.RootElement.GetProperty("expired").EnumerateArray()
                .Select(value => value.GetString())
                .Where(id => id is not null && eligible.Contains(id, StringComparer.OrdinalIgnoreCase))
                .Select(id => id!).ToArray();
            using var executed = await RunAsync("execute", approved);
            var removed = executed.RootElement.GetProperty("removed").GetArrayLength();
            var bridgeRemoved = executed.RootElement.GetProperty("lightroom").GetProperty("removed").GetArrayLength();
            if (removed > 0 || bridgeRemoved > 0) StatusText = $"取込から7日を過ぎた原本・一時プレビューを整理しました（{approved.Length}件／Lightroom一時画像{bridgeRemoved}枚）";
        }
        catch (Exception error) { StatusText = "期限切れ原本の整理を保留しました：" + error.Message; }
        finally { _cleaningSources = false; _busy = false; RaiseCommands(); }
    }
    private string NodeScriptPath(string fileName)
    {
        if (_nodeScriptsDir is null) throw new InvalidOperationException("BELLO_PHOTO_STATION_NODE_DIR is not configured");
        var direct = Path.Combine(_nodeScriptsDir, fileName);
        return File.Exists(direct) ? direct : Path.Combine(_nodeScriptsDir, "src", fileName);
    }
    private static double ToGiB(long bytes) => bytes / 1024d / 1024d / 1024d;
    private static Guid StableSessionId(string generation, string manifest)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(generation + "\0" + manifest));
        return new Guid(bytes.AsSpan(0, 16));
    }
    private void Set<T>(ref T field, T value, [CallerMemberName] string? name = null) { field = value; PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name)); }
    public event PropertyChangedEventHandler? PropertyChanged;
}
internal sealed class AsyncCommand(Func<Task> execute, Func<bool> canExecute) : ICommand
{
    public bool CanExecute(object? parameter) => canExecute();
    public async void Execute(object? parameter) => await execute();
    public event EventHandler? CanExecuteChanged;
    public void RaiseCanExecuteChanged() => CanExecuteChanged?.Invoke(this, EventArgs.Empty);
}

using System.Collections.ObjectModel;
using System.ComponentModel;
using System.IO;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Input;
using PhotoStation.Application;
using PhotoStation.Domain;
using PhotoStation.Infrastructure;

namespace PhotoStation.Desktop;
public sealed class MainViewModel : INotifyPropertyChanged
{
    private readonly string _root;
    private readonly SqliteStationRepository _repository;
    private readonly ImportService _importer;
    private DriveInfo? _drive;
    private string _detectedDriveText = "SDカードを検出しています…", _statusText = "準備中";
    private bool _busy;
    public ObservableCollection<ImportSession> Sessions { get; } = [];
    public string DetectedDriveText { get => _detectedDriveText; private set => Set(ref _detectedDriveText, value); }
    public string StatusText { get => _statusText; private set => Set(ref _statusText, value); }
    public ICommand RefreshCommand { get; }
    public ICommand ImportCommand { get; }
    public MainViewModel()
    {
        _root = Environment.GetEnvironmentVariable("BELLO_PHOTO_STATION_ROOT") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BELLO", "PhotoStation", "staging");
        _repository = new SqliteStationRepository(Path.Combine(_root, "db", "station.sqlite"));
        _importer = new ImportService(_repository, new VerifiedFileCopier());
        RefreshCommand = new AsyncCommand(RefreshAsync, () => !_busy);
        ImportCommand = new AsyncCommand(ImportAsync, () => !_busy && _drive is not null);
    }
    public async Task InitializeAsync() { await _repository.InitializeAsync(); await RefreshAsync(); }
    private async Task RefreshAsync()
    {
        var configuredRoot = Environment.GetEnvironmentVariable("BELLO_PHOTO_CARD_ROOT");
        _drive = !string.IsNullOrWhiteSpace(configuredRoot)
            ? DriveInfo.GetDrives().FirstOrDefault(x => x.IsReady && string.Equals(x.RootDirectory.FullName, Path.GetPathRoot(configuredRoot), StringComparison.OrdinalIgnoreCase))
            : DriveInfo.GetDrives().FirstOrDefault(x => x.IsReady && x.DriveType == DriveType.Removable);
        DetectedDriveText = _drive is null ? "リムーバブルSDカードは見つかりません" : $"{_drive.Name}  {(_drive.VolumeLabel.Length == 0 ? "（ラベルなし）" : _drive.VolumeLabel)}  空き {ToGiB(_drive.AvailableFreeSpace):F1} GiB";
        Sessions.Clear(); foreach (var session in await _repository.ListSessionsAsync()) Sessions.Add(session);
        StatusText = _drive is null ? "カードを挿すと再検出できます" : "カードは読み取り専用の取込元として認識されています";
        RaiseCommands();
    }
    private async Task ImportAsync()
    {
        if (_drive is null) return; _busy = true; RaiseCommands();
        try
        {
            var dcim = Path.Combine(_drive.RootDirectory.FullName, "DCIM");
            if (!Directory.Exists(dcim)) throw new DirectoryNotFoundException("SDカードにDCIMフォルダーがありません");
            var files = Directory.EnumerateFiles(dcim, "*", SearchOption.AllDirectories).Where(x => new[] { ".arw", ".jpg", ".jpeg" }.Contains(Path.GetExtension(x), StringComparer.OrdinalIgnoreCase)).Select(x => new FileInfo(x)).ToArray();
            if (files.Length == 0) { StatusText = "新しい画像候補はありません"; return; }
            var candidates = files.Select(x => new SourceCandidate(Path.GetRelativePath(_drive.RootDirectory.FullName, x.FullName), x.Length, x.LastWriteTimeUtc)).ToArray();
            var generation = CardGeneration(_drive);
            var sessionId = StableSessionId(generation, ImportService.ManifestHash(candidates)); StatusText = $"{candidates.Length}件をSSDへコピーして照合しています…";
            var result = await _importer.ImportAsync(new ImportRequest(sessionId, "staging", Environment.GetEnvironmentVariable("BELLO_PHOTO_STATION_ID") ?? "UNREGISTERED-STATION", generation, _drive.RootDirectory.FullName, Path.Combine(_root, "sessions", sessionId.ToString("D")), candidates));
            StatusText = result.SafeToRemove ? $"コピーと照合完了（{result.VerifiedCount}件）：SDを取り外せます" : "取込を保留しています";
            await RefreshAsync();
        }
        catch (Exception error) { StatusText = "取込を完了できませんでした：" + error.Message; }
        finally { _busy = false; RaiseCommands(); }
    }
    private void RaiseCommands() { (RefreshCommand as AsyncCommand)?.RaiseCanExecuteChanged(); (ImportCommand as AsyncCommand)?.RaiseCanExecuteChanged(); }
    private static double ToGiB(long bytes) => bytes / 1024d / 1024d / 1024d;
    private static string CardGeneration(DriveInfo drive) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{drive.VolumeLabel}\0{drive.TotalSize}\0{drive.DriveFormat}"))).ToLowerInvariant();
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

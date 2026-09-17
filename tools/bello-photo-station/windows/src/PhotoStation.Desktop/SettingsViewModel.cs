using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows.Input;
using System.Windows.Media.Imaging;
using PhotoStation.Application;
using PhotoStation.Domain;
using PhotoStation.Infrastructure;

namespace PhotoStation.Desktop;

/// <summary>
/// 「編集設定」画面。EditSettingsStoreの読み書きとIPreviewRunnerによる
/// テスト画像プレビューだけを配線する — 実際の設定の永続化ロジックはInfrastructure層、
/// 画像処理はNode側(previewCli.mjs)にとどめる。
/// </summary>
public sealed class SettingsViewModel : INotifyPropertyChanged
{
    private readonly EditSettingsStore _store;
    private readonly IPreviewRunner? _previewRunner;
    private readonly string _previewOutputDir;

    private bool _keepAspectRatio = true, _autoCrop, _autoRotate = true, _stripMetadata = true;
    private string _cropMethod = "none", _colorSpace = "srgb", _outputFormat = "jpeg";
    private int _longEdgePx = 3000, _jpegQuality = 90, _thumbnailLongEdgePx = 480, _thumbnailJpegQuality = 80;
    private double _brightness, _contrast, _colorTemperatureShift, _saturation, _sharpness;
    private string? _lightroomPresetName;

    private string _currentSettingsSummary = "";
    private string? _testImagePath;
    private string? _previewStatus;
    private BitmapImage? _beforeImage;
    private BitmapImage? _afterImage;
    private string _newPresetName = "";
    private string? _selectedPresetName;
    private bool _busy;

    public SettingsViewModel(EditSettingsStore store, IPreviewRunner? previewRunner, string previewOutputDir)
    {
        _store = store;
        _previewRunner = previewRunner;
        _previewOutputDir = previewOutputDir;
        PreviewStatus = previewRunner is null ? "プレビューにはNode.js連携(BELLO_PHOTO_STATION_NODE_DIR)の設定が必要です。" : null;

        SaveCommand = new AsyncCommand(SaveAsync, () => !_busy);
        ResetToDefaultCommand = new AsyncCommand(ResetToDefaultAsync, () => !_busy);
        SavePresetCommand = new AsyncCommand(SavePresetAsync, () => !_busy && !string.IsNullOrWhiteSpace(NewPresetName));
        ApplyPresetCommand = new AsyncCommand(ApplyPresetAsync, () => !_busy && !string.IsNullOrWhiteSpace(SelectedPresetName));
        RunPreviewCommand = new AsyncCommand(RunPreviewAsync, () => !_busy && _previewRunner is not null && !string.IsNullOrWhiteSpace(TestImagePath));
    }

    public ObservableCollection<string> PresetNames { get; } = [];
    public string[] CropMethods { get; } = ["none", "cover"];

    public ICommand SaveCommand { get; }
    public ICommand ResetToDefaultCommand { get; }
    public ICommand SavePresetCommand { get; }
    public ICommand ApplyPresetCommand { get; }
    public ICommand RunPreviewCommand { get; }

    public bool KeepAspectRatio { get => _keepAspectRatio; set => Set(ref _keepAspectRatio, value); }
    public bool AutoCrop { get => _autoCrop; set => Set(ref _autoCrop, value); }

    public string CropMethod
    {
        get => _cropMethod;
        set { Set(ref _cropMethod, value); AutoCrop = value != "none"; }
    }

    public bool AutoRotate { get => _autoRotate; set => Set(ref _autoRotate, value); }
    public string ColorSpace { get => _colorSpace; set => Set(ref _colorSpace, value); }
    public string OutputFormat { get => _outputFormat; set => Set(ref _outputFormat, value); }
    public int LongEdgePx { get => _longEdgePx; set => Set(ref _longEdgePx, value); }
    public int JpegQuality { get => _jpegQuality; set => Set(ref _jpegQuality, value); }
    public int ThumbnailLongEdgePx { get => _thumbnailLongEdgePx; set => Set(ref _thumbnailLongEdgePx, value); }
    public int ThumbnailJpegQuality { get => _thumbnailJpegQuality; set => Set(ref _thumbnailJpegQuality, value); }
    public bool StripMetadata { get => _stripMetadata; set => Set(ref _stripMetadata, value); }
    public double Brightness { get => _brightness; set => Set(ref _brightness, value); }
    public double Contrast { get => _contrast; set => Set(ref _contrast, value); }
    public double ColorTemperatureShift { get => _colorTemperatureShift; set => Set(ref _colorTemperatureShift, value); }
    public double Saturation { get => _saturation; set => Set(ref _saturation, value); }
    public double Sharpness { get => _sharpness; set => Set(ref _sharpness, value); }
    public string? LightroomPresetName { get => _lightroomPresetName; set => Set(ref _lightroomPresetName, value); }

    public string CurrentSettingsSummary { get => _currentSettingsSummary; private set => Set(ref _currentSettingsSummary, value); }

    public string? TestImagePath
    {
        get => _testImagePath;
        set { Set(ref _testImagePath, value); RaiseCommands(); }
    }

    public string? PreviewStatus { get => _previewStatus; private set => Set(ref _previewStatus, value); }
    public BitmapImage? BeforeImage { get => _beforeImage; private set => Set(ref _beforeImage, value); }
    public BitmapImage? AfterImage { get => _afterImage; private set => Set(ref _afterImage, value); }

    public string NewPresetName
    {
        get => _newPresetName;
        set { Set(ref _newPresetName, value); RaiseCommands(); }
    }

    public string? SelectedPresetName
    {
        get => _selectedPresetName;
        set { Set(ref _selectedPresetName, value); RaiseCommands(); }
    }

    public async Task InitializeAsync()
    {
        var state = await _store.LoadAsync();
        Apply(state.Active);
        PresetNames.Clear();
        foreach (var name in state.Presets.Keys) PresetNames.Add(name);
    }

    private EditSettings ToSettings() => new(
        KeepAspectRatio, AutoCrop, CropMethod, AutoRotate, ColorSpace, OutputFormat,
        LongEdgePx, JpegQuality, ThumbnailLongEdgePx, ThumbnailJpegQuality, StripMetadata,
        Brightness, Contrast, ColorTemperatureShift, Saturation, Sharpness, LightroomPresetName);

    private void Apply(EditSettings settings)
    {
        KeepAspectRatio = settings.KeepAspectRatio;
        CropMethod = settings.CropMethod;
        AutoCrop = settings.AutoCrop;
        AutoRotate = settings.AutoRotate;
        ColorSpace = settings.ColorSpace;
        OutputFormat = settings.OutputFormat;
        LongEdgePx = settings.LongEdgePx;
        JpegQuality = settings.JpegQuality;
        ThumbnailLongEdgePx = settings.ThumbnailLongEdgePx;
        ThumbnailJpegQuality = settings.ThumbnailJpegQuality;
        StripMetadata = settings.StripMetadata;
        Brightness = settings.Brightness;
        Contrast = settings.Contrast;
        ColorTemperatureShift = settings.ColorTemperatureShift;
        Saturation = settings.Saturation;
        Sharpness = settings.Sharpness;
        LightroomPresetName = settings.LightroomPresetName;
        CurrentSettingsSummary = Describe(settings);
    }

    private static string Describe(EditSettings s) =>
        $"現在使用中：長辺{s.LongEdgePx}px ・ 品質{s.JpegQuality} ・ サムネイル{s.ThumbnailLongEdgePx}px/品質{s.ThumbnailJpegQuality} ・ " +
        $"{(s.AutoCrop ? "トリミングあり" : "自動トリミングなし")} ・ {(s.StripMetadata ? "GPS等のメタデータを削除" : "メタデータを保持")}" +
        (string.IsNullOrWhiteSpace(s.LightroomPresetName) ? "" : $" ・ Lightroom: {s.LightroomPresetName}");

    private async Task SaveAsync() => await RunBusyAsync(async () => Apply(await _store.SetActiveAsync(ToSettings())));

    private async Task ResetToDefaultAsync() => await RunBusyAsync(async () => Apply(await _store.ResetToDefaultAsync()));

    private Task SavePresetAsync() => RunBusyAsync(async () =>
    {
        var name = NewPresetName;
        await _store.SavePresetAsync(name, ToSettings());
        if (!PresetNames.Contains(name)) PresetNames.Add(name);
        NewPresetName = "";
    });

    private Task ApplyPresetAsync()
    {
        if (SelectedPresetName is null) return Task.CompletedTask;
        var name = SelectedPresetName;
        return RunBusyAsync(async () => Apply(await _store.ApplyPresetAsync(name)));
    }

    private Task RunPreviewAsync()
    {
        if (_previewRunner is null || TestImagePath is null) return Task.CompletedTask;
        var sourcePath = TestImagePath;
        return RunBusyAsync(async () =>
        {
            PreviewStatus = "プレビューを生成しています…";
            try
            {
                var result = await _previewRunner.RunAsync(sourcePath, ToSettings(), _previewOutputDir);
                BeforeImage = LoadNoCache(result.SourcePath);
                AfterImage = LoadNoCache(result.ProcessedPath);
                PreviewStatus = $"適用後：{result.ProcessedWidth}x{result.ProcessedHeight}px";
            }
            catch (Exception error)
            {
                PreviewStatus = "プレビューを生成できませんでした：" + error.Message;
            }
        });
    }

    private async Task RunBusyAsync(Func<Task> action)
    {
        _busy = true; RaiseCommands();
        try { await action(); }
        finally { _busy = false; RaiseCommands(); }
    }

    private static BitmapImage LoadNoCache(string path)
    {
        var image = new BitmapImage();
        image.BeginInit();
        image.CacheOption = BitmapCacheOption.OnLoad;
        image.CreateOptions = BitmapCreateOptions.IgnoreImageCache;
        image.UriSource = new Uri(path, UriKind.Absolute);
        image.EndInit();
        image.Freeze();
        return image;
    }

    private void RaiseCommands()
    {
        (SaveCommand as AsyncCommand)?.RaiseCanExecuteChanged();
        (ResetToDefaultCommand as AsyncCommand)?.RaiseCanExecuteChanged();
        (SavePresetCommand as AsyncCommand)?.RaiseCanExecuteChanged();
        (ApplyPresetCommand as AsyncCommand)?.RaiseCanExecuteChanged();
        (RunPreviewCommand as AsyncCommand)?.RaiseCanExecuteChanged();
    }

    private void Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        field = value; PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    }

    public event PropertyChangedEventHandler? PropertyChanged;
}

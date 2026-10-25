using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media.Imaging;
using System.Windows.Data;
using System.Globalization;
using System.ComponentModel;
using PhotoStation.Infrastructure;

namespace PhotoStation.Desktop;

public partial class PresetComparisonWindow : Window
{
    private readonly PresetWorkflowRunner _runner;
    private readonly string _session;
    private readonly CancellationTokenSource _cancel = new();
    private readonly Dictionary<string, BitmapImage> _comparisonImages = new();
    private readonly SemaphoreSlim _thumbnailLimit = new(2);
    private BitmapImage? _originalImage;
    private string? _originalPath;
    private bool _busy;
    private string? _topName;
    private sealed class SourceItem(string name, string path) : INotifyPropertyChanged
    {
        public string Name { get; } = name;
        public string Path { get; } = path;
        private string _topLabel = "";
        private BitmapImage? _thumbnail;
        public string TopLabel { get => _topLabel; set { _topLabel = value; PropertyChanged?.Invoke(this, new(nameof(TopLabel))); } }
        public BitmapImage? Thumbnail { get => _thumbnail; set { _thumbnail = value; PropertyChanged?.Invoke(this, new(nameof(Thumbnail))); } }
        public event PropertyChangedEventHandler? PropertyChanged;
    }
    private sealed record ComparisonOption(string Name, string? Id);

    public PresetComparisonWindow(PresetWorkflowRunner runner, string session)
    {
        InitializeComponent(); _runner = runner; _session = session;
        if (App.IsTouchMode)
        {
            MinWidth = 800; MinHeight = 480; WindowState = WindowState.Maximized;
            FontSize = 16; PresetManagement.IsExpanded = false;
        }
        Loaded += async (_, _) => await ExecuteAsync(RefreshAsync);
        Closed += (_, _) => _cancel.Cancel();
    }

    private async Task ExecuteAsync(Func<Task> action)
    {
        if (_busy) return;
        _busy = true; UpdateButtons();
        try { await action(); }
        catch (OperationCanceledException) { }
        catch (Exception error) { Status.Text = error.Message; }
        finally { _busy = false; UpdateButtons(); }
    }

    private Task<JsonElement> Run(string command, params string[] args) =>
        _runner.RunAsync(command, args, text => Dispatcher.InvokeAsync(() => Status.Text = text), _cancel.Token);

    private async Task RefreshAsync()
    {
        var data = await Run("list", _session);
        var sources = data.GetProperty("sources").EnumerateArray().Select(s =>
            new SourceItem(s.GetProperty("fileName").GetString()!, s.GetProperty("sourcePath").GetString()!)).ToArray();
        var savedTop = data.TryGetProperty("framingChoice", out var choice) && choice.ValueKind == JsonValueKind.Object
            ? choice.GetProperty("topFileName").GetString() : null;
        _topName = sources.Any(s => s.Name == _topName) ? _topName
            : sources.Any(s => s.Name == savedTop) ? savedTop : sources.FirstOrDefault()?.Name;
        SetSourceItems(sources);

        var presetItems = data.GetProperty("presets").EnumerateArray()
            .Select(p => new ComparisonOption(p.GetProperty("name").GetString()!, p.GetProperty("id").GetString()!)).ToArray();
        var savedDefault = data.TryGetProperty("defaultPresetId", out var defaultId) && defaultId.ValueKind == JsonValueKind.String
            ? defaultId.GetString() : null;
        var priorLeft = (LeftChoice.SelectedItem as ComparisonOption)?.Id;
        var priorRight = (RightChoice.SelectedItem as ComparisonOption)?.Id;
        var options = new[] { new ComparisonOption("補正前", null) }
            .Concat(presetItems).ToArray();
        LeftChoice.ItemsSource = options;
        RightChoice.ItemsSource = presetItems;
        LeftChoice.SelectedItem = options.FirstOrDefault(o => o.Id == priorLeft) ?? options[0];
        RightChoice.SelectedItem = presetItems.FirstOrDefault(o => o.Id == priorRight)
            ?? presetItems.FirstOrDefault(o => o.Id == savedDefault) ?? presetItems.FirstOrDefault();
        _comparisonImages.Clear();
        UpdateImages();
        PresetCount.Text = $"登録済み {presetItems.Length} 種類";
        var errors = data.GetProperty("errors").EnumerateArray().Select(e => e.GetProperty("fileName").GetString() + "：" + e.GetProperty("message").GetString());
        Status.Text = presetItems.Length == 0 ? "XMPプリセットを取り込んでください。Lightroomにも同じXMPを読み込む必要があります。"
            : "標準プリセットを全写真に使用します。比較画像の生成は任意です。";
        if (errors.Any()) Status.Text += "\n" + string.Join("\n", errors);
    }

    private void SetSourceItems(SourceItem[] sources)
    {
        foreach (var source in sources) source.TopLabel = source.Name == _topName ? "★ トップ画像" : "";
        if (!ReferenceEquals(Sources.ItemsSource, sources)) Sources.ItemsSource = sources;
        Sources.SelectedItem = Sources.Items.Cast<SourceItem>().FirstOrDefault(s => s.Name == _topName);
        TopStatus.Text = _topName is null ? "写真がありません" : $"トップ画像：{_topName}";
        foreach (var source in sources.Where(s => s.Thumbnail is null)) _ = LoadThumbnailAsync(source);
        UpdateImages();
    }

    private async Task LoadThumbnailAsync(SourceItem source)
    {
        await _thumbnailLimit.WaitAsync();
        try
        {
            var image = await Task.Run(() => LoadImage(source.Path, 180));
            if (IsLoaded) source.Thumbnail = image;
        }
        catch { /* RAW without a Windows decoder has no local thumbnail. */ }
        finally { _thumbnailLimit.Release(); }
    }

    private void Source_DoubleClick(object sender, MouseButtonEventArgs e)
    {
        SetSelectedTop();
    }

    private void MakeTop_Click(object sender, RoutedEventArgs e) => SetSelectedTop();

    private void SetSelectedTop()
    {
        if (_busy) return;
        if (Sources.SelectedItem is not SourceItem source) return;
        _topName = source.Name;
        _originalImage = null; _originalPath = null;
        _comparisonImages.Clear();
        SetSourceItems(Sources.Items.Cast<SourceItem>().ToArray());
        Status.Text = "トップ画像を変更しました。比較画像が必要なら再生成してください。";
    }

    private async void Add_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new Microsoft.Win32.OpenFileDialog { Filter = "Lightroomプリセット (*.xmp)|*.xmp", Multiselect = true };
        if (dialog.ShowDialog(this) != true) return;
        await ExecuteAsync(async () => {
            foreach (var file in dialog.FileNames) await Run("import", file);
            await RefreshAsync();
            Status.Text += "\n取り込んだXMPと同じファイルをLightroomにも読み込んでください。";
        });
    }
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await ExecuteAsync(RefreshAsync);

    private async void SetDefault_Click(object sender, RoutedEventArgs e)
    {
        if (RightChoice.SelectedItem is not ComparisonOption { Id: not null } preset) return;
        await ExecuteAsync(async () => {
            await Run("set-default", _session, preset.Id);
            Status.Text = $"『{preset.Name}』を今後の商品の標準プリセットにしました。";
        });
    }

    private async void Delete_Click(object sender, RoutedEventArgs e)
    {
        if (RightChoice.SelectedItem is not ComparisonOption { Id: not null } preset) return;
        if (MessageBox.Show(this, $"『{preset.Name}』をPhoto Stationから削除しますか？\n使用中の未完了商品は別のプリセットを選び直す必要があります。", "プリセットの削除", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
        await ExecuteAsync(async () => { await Run("delete-preset", _session, preset.Id); await RefreshAsync(); });
    }

    private async void Preview_Click(object sender, RoutedEventArgs e)
    {
        var top = Sources.Items.Cast<SourceItem>().FirstOrDefault(s => s.Name == _topName);
        if (top is null) return;
        var ids = new[] { (LeftChoice.SelectedItem as ComparisonOption)?.Id, (RightChoice.SelectedItem as ComparisonOption)?.Id }
            .Where(id => id is not null).Distinct().ToArray();
        await ExecuteAsync(async () => {
            var result = await Run("preview-pair", _session, top.Path, JsonSerializer.Serialize(ids));
            foreach (var card in result.GetProperty("cards").EnumerateArray())
            {
                if (!card.TryGetProperty("path", out var path)) continue;
                var preset = card.GetProperty("preset");
                var id = preset.ValueKind == JsonValueKind.Null ? "" : preset.GetProperty("id").GetString()!;
                _comparisonImages[id] = LoadImage(path.GetString()!, 1600);
            }
            UpdateImages();
            Status.Text = "左右の選択欄で仕上がりを切り替えられます。別のプリセットに変えたら再び『比較画像を生成』を押してください。";
        });
    }

    private void ComparisonChoice_Changed(object sender, SelectionChangedEventArgs e) { UpdateImages(); UpdateButtons(); }
    private void UpdateImages()
    {
        if (LeftImage is null || RightImage is null) return;
        var top = Sources?.Items.Cast<SourceItem>().FirstOrDefault(s => s.Name == _topName);
        var left = (LeftChoice.SelectedItem as ComparisonOption)?.Id ?? "";
        var right = (RightChoice.SelectedItem as ComparisonOption)?.Id ?? "";
        if (top is not null && (left == "" || right == "") && _originalPath != top.Path)
        {
            _originalPath = top.Path;
            _originalImage = null;
            _ = LoadOriginalAsync(top.Path);
        }
        LeftImage.Source = _comparisonImages.GetValueOrDefault(left) ?? (left == "" ? _originalImage : null);
        RightImage.Source = _comparisonImages.GetValueOrDefault(right) ?? (right == "" ? _originalImage : null);
    }

    private async Task LoadOriginalAsync(string file)
    {
        try
        {
            var image = await Task.Run(() => LoadImage(file, 1200));
            if (IsLoaded && _originalPath == file) { _originalImage = image; UpdateImages(); }
        }
        catch { /* RAW preview requires Lightroom. */ }
    }

    private void Zoom_Click(object sender, MouseButtonEventArgs e)
    {
        if ((!App.IsTouchMode && e.ClickCount < 2) || sender is not Image { Source: BitmapSource bitmap }) return;
        var zoom = new Window { Owner = this, Title = "写真を拡大", Width = 1200, Height = 850,
            WindowState = App.IsTouchMode ? WindowState.Maximized : WindowState.Normal };
        var layout = new DockPanel();
        var close = new Button { Content = "写真に戻る", Padding = new Thickness(16, 10, 16, 10) };
        close.Click += (_, _) => zoom.Close(); DockPanel.SetDock(close, Dock.Bottom); layout.Children.Add(close);
        layout.Children.Add(new ScrollViewer { PanningMode = PanningMode.Both,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            Content = new Image { Source = bitmap, Stretch = System.Windows.Media.Stretch.None } });
        zoom.Content = layout; zoom.ShowDialog();
    }

    private void UpdateButtons()
    {
        if (FinishButton is null) return;
        AddButton.IsEnabled = RefreshButton.IsEnabled = Sources.IsEnabled = LeftChoice.IsEnabled = RightChoice.IsEnabled = !_busy;
        MakeTopButton.IsEnabled = !_busy && _topName is not null;
        var selected = RightChoice.SelectedItem is ComparisonOption { Id: not null };
        SetDefaultButton.IsEnabled = DeleteButton.IsEnabled = !_busy && selected;
        ManualFramingButton.IsEnabled = PreviewButton.IsEnabled = FramingPreviewButton.IsEnabled = FinishButton.IsEnabled = !_busy && _topName is not null && selected;
    }

    private async void ManualFraming_Click(object sender, RoutedEventArgs e)
    {
        if (_topName is null || RightChoice.SelectedItem is not ComparisonOption { Id: not null } preset) return;
        await ExecuteAsync(async () => {
            await Run("choose-product", _session, preset.Id);
            await Run("top", _session, _topName);
            new FramingOverrideWindow(_runner, _session) { Owner = this }.ShowDialog();
        });
    }

    private async void Finish_Click(object sender, RoutedEventArgs e)
    {
        if (_topName is null || RightChoice.SelectedItem is not ComparisonOption { Id: not null } preset) return;
        await ExecuteAsync(async () => {
            await Run("choose-product", _session, preset.Id);
            await Run("top", _session, _topName);
            // The pipeline selects square first, then 3:2 for the entire
            // product. It stops before upload if any subject is uncertain.
            DialogResult = true;
        });
    }

    private async void FramingPreview_Click(object sender, RoutedEventArgs e)
    {
        if (_topName is null || RightChoice.SelectedItem is not ComparisonOption { Id: not null } preset) return;
        await ExecuteAsync(async () => {
            await Run("choose-product", _session, preset.Id);
            await Run("top", _session, _topName);
            var result = await Run("framing-preview", _session);
            if (result.GetProperty("status").GetString() != "READY")
            { Status.Text = result.TryGetProperty("reason", out var reason) ? reason.GetString() : "構図を確認してください。"; return; }
            ShowFramingPreview(result);
        });
    }

    private bool? ShowFramingPreview(JsonElement result)
    {
        var ratio = result.GetProperty("aspectRatio").GetDouble() == 1 ? "正方形" : "3:2";
        var layout = new DockPanel { Margin = new Thickness(16) };
        var header = new TextBlock { Text = $"全写真を{ratio}で統一します。商品や脚が切れていないか確認してください。",
            FontSize = 17, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 12) };
        DockPanel.SetDock(header, Dock.Top); layout.Children.Add(header);
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 12, 0, 0) };
        DockPanel.SetDock(buttons, Dock.Bottom); layout.Children.Add(buttons);
        var review = new Window { Owner = this, Title = "商品画像の構図確認", Width = 1100, Height = 780,
            MinWidth = 700, MinHeight = 500, Content = layout };
        if (App.IsTouchMode) review.WindowState = WindowState.Maximized;
        var accept = new Button { Content = "確認して閉じる", Padding = new Thickness(14, 8, 14, 8) };
        accept.Click += (_, _) => review.DialogResult = true;
        var later = new Button { Content = "後で確認", Padding = new Thickness(14, 8, 14, 8), Margin = new Thickness(8, 0, 0, 0) };
        later.Click += (_, _) => review.DialogResult = false;
        buttons.Children.Add(accept); buttons.Children.Add(later);
        var cards = new WrapPanel();
        foreach (var item in result.GetProperty("previews").EnumerateArray())
        {
            var file = item.GetProperty("path").GetString()!;
            var previewImage = new Image { Width = 315, Height = 315, Stretch = System.Windows.Media.Stretch.Uniform };
            _ = Task.Run(() => LoadImage(file, 700)).ContinueWith(task => {
                if (task.IsCompletedSuccessfully)
                    review.Dispatcher.InvokeAsync(() => previewImage.Source = task.Result);
            });
            cards.Children.Add(new StackPanel { Width = 330, Margin = new Thickness(8), Children = {
                previewImage,
                new TextBlock { Text = item.GetProperty("fileName").GetString()!, FontWeight = FontWeights.Bold },
                new TextBlock { Text = $"水平補正 {item.GetProperty("angle").GetDouble():F1}°" }
            } });
        }
        layout.Children.Add(new ScrollViewer { Content = cards, PanningMode = PanningMode.VerticalOnly, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        return review.ShowDialog();
    }

    private void Later_Click(object sender, RoutedEventArgs e) { DialogResult = false; }
    private static BitmapImage LoadImage(string file, int decodeWidth = 0)
    {
        var image = new BitmapImage(); image.BeginInit(); image.CacheOption = BitmapCacheOption.OnLoad;
        if (decodeWidth > 0) image.DecodePixelWidth = decodeWidth;
        image.UriSource = new Uri(Path.GetFullPath(file)); image.EndInit(); image.Freeze(); return image;
    }
}

public sealed class SourceThumbnailConverter : IValueConverter
{
    public object? Convert(object value, Type targetType, object parameter, CultureInfo culture)
    {
        if (value is not string file) return null;
        try
        {
            var image = new BitmapImage(); image.BeginInit();
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.DecodePixelWidth = 180;
            image.UriSource = new Uri(Path.GetFullPath(file));
            image.EndInit(); image.Freeze(); return image;
        }
        catch { return null; }
    }
    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => throw new NotSupportedException();
}

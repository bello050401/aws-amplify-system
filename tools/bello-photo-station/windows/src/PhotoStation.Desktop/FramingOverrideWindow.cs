using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using PhotoStation.Infrastructure;

namespace PhotoStation.Desktop;

/// <summary>Manual fallback when studio background/subject detection is uncertain.</summary>
public sealed class FramingOverrideWindow : Window
{
    private sealed class Item
    {
        public required string Name { get; init; }
        public required string Path { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public double Angle { get; set; }
        public Box? SubjectBox { get; set; }
        public override string ToString() => Name;
    }
    private sealed record Box(int left, int top, int width, int height);
    private readonly PresetWorkflowRunner _runner;
    private readonly string _session;
    private readonly ListBox _files = new() { Width = 240 };
    private readonly Canvas _canvas = new() { Width = 650, Height = 470, Background = Brushes.DarkSlateGray };
    private readonly Image _image = new() { Stretch = Stretch.Fill, IsHitTestVisible = false };
    private readonly Rectangle _outline = new() { Stroke = Brushes.OrangeRed, StrokeThickness = 3, IsHitTestVisible = false };
    private readonly Slider _angle = new() { Minimum = -5, Maximum = 5, Value = 0, Width = 260,
        TickFrequency = 0.1, IsSnapToTickEnabled = false, SmallChange = 0.1, LargeChange = 1 };
    private readonly TextBlock _angleLabel = new() { Width = 50, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _status = new() { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0) };
    private readonly CheckBox _detail = new() { Content = "質感・部分の拡大写真（全体を収めず、撮影した構図を保つ）", Margin = new Thickness(0, 8, 0, 8) };
    private Item? _current;
    private Box? _box;
    private Point? _start;
    private double _scale, _offsetX, _offsetY;

    public FramingOverrideWindow(PresetWorkflowRunner runner, string session)
    {
        _runner = runner; _session = session;
        Title = "商品と水平の確認"; Width = 1050; Height = 700; MinWidth = 900; MinHeight = 620;
        if (App.IsTouchMode) { MinHeight = 480; WindowState = WindowState.Maximized; FontSize = 16; }
        var layout = new Grid { Margin = new Thickness(16) };
        layout.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(250) });
        layout.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var left = new DockPanel();
        var fileHeading = new TextBlock { Text = "写真を選択", FontWeight = FontWeights.Bold };
        DockPanel.SetDock(fileHeading, Dock.Top); left.Children.Add(fileHeading);
        left.Children.Add(_files);
        Grid.SetColumn(left, 0); layout.Children.Add(left);
        var right = new StackPanel();
        right.Children.Add(new TextBlock { Text = "全体写真は商品を囲みます。拡大写真は下のチェックを選び、見せたい箇所を残します。", TextWrapping = TextWrapping.Wrap });
        right.Children.Add(_detail);
        _canvas.Children.Add(_image); _canvas.Children.Add(_outline);
        right.Children.Add(_canvas);
        var angleRow = new WrapPanel { Margin = new Thickness(0, 10, 0, 0) };
        angleRow.Children.Add(new TextBlock { Text = "水平を見ながらドラッグ", VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 10, 0) });
        angleRow.Children.Add(_angle);
        angleRow.Children.Add(_angleLabel);
        _angle.ValueChanged += (_, _) => {
            _angleLabel.Text = $"{_angle.Value:+0.0;-0.0;0.0}°";
            if (_current is not null)
            {
                _image.RenderTransformOrigin = new Point(0.5, 0.5);
                _image.RenderTransform = new RotateTransform(_angle.Value - _current.Angle);
                _status.Text = "角度を保存して見直すと、正確な商品枠も再表示します。";
            }
        };
        right.Children.Add(angleRow);
        var buttons = new WrapPanel { Margin = new Thickness(0, 12, 0, 0) };
        var save = new Button { Content = "この写真を保存", Padding = new Thickness(12, 7, 12, 7) };
        save.Click += async (_, _) => await SaveAsync(); buttons.Children.Add(save);
        var refresh = new Button { Content = "角度を反映して見直す", Padding = new Thickness(12, 7, 12, 7), Margin = new Thickness(8, 0, 0, 0) };
        refresh.Click += async (_, _) => { await SaveAsync(); await LoadAsync(_current?.Name); }; buttons.Children.Add(refresh);
        var retry = new Button { Content = "全写真の構図を再計算", Padding = new Thickness(12, 7, 12, 7), Margin = new Thickness(8, 0, 0, 0) };
        retry.Click += (_, _) => DialogResult = true; buttons.Children.Add(retry);
        right.Children.Add(buttons); right.Children.Add(_status);
        var rightScroll = new ScrollViewer { Content = right, VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto };
        // Leave touch-to-mouse promotion on the canvas intact for drawing a box.
        // Scrollbars provide access to the controls below the image at high DPI.
        Grid.SetColumn(rightScroll, 1); layout.Children.Add(rightScroll);
        Content = layout;
        _files.SelectionChanged += async (_, _) => await SelectCurrentAsync();
        _canvas.MouseLeftButtonDown += StartBox;
        _canvas.MouseMove += MoveBox;
        _canvas.MouseLeftButtonUp += EndBox;
        Loaded += async (_, _) => await LoadAsync();
    }

    private async Task LoadAsync(string? selectedName = null)
    {
        try
        {
            _status.Text = "写真と現在の構図を読み込んでいます…";
            var result = await _runner.RunAsync("list", [_session]);
            var items = result.GetProperty("sources").EnumerateArray().Select(value =>
                new Item { Name = value.GetProperty("fileName").GetString()!, Path = value.GetProperty("sourcePath").GetString()! }).ToArray();
            _files.ItemsSource = items;
            _files.SelectedItem = items.FirstOrDefault(item => item.Name == selectedName) ?? items.FirstOrDefault();
        }
        catch (Exception error) { _status.Text = "写真を読み込めませんでした：" + error.Message; }
    }

    private async Task SelectCurrentAsync()
    {
        var selected = _files.SelectedItem as Item;
        _current = selected; _box = selected?.SubjectBox;
        _outline.Visibility = Visibility.Collapsed;
        if (selected is null) return;
        try
        {
        _status.Text = selected.Name + " の構図を読み込んでいます…";
        var result = await _runner.RunAsync("framing-inspect", [_session, selected.Name]);
        if (_files.SelectedItem != selected) return;
        var value = result.GetProperty("items")[0];
        _detail.IsChecked = value.TryGetProperty("framingMode",out var mode) && mode.GetString()=="detail";
        selected.Path = value.GetProperty("path").GetString()!;
        selected.Width = value.GetProperty("width").GetInt32(); selected.Height = value.GetProperty("height").GetInt32();
        selected.Angle = value.GetProperty("angle").GetDouble();
        selected.SubjectBox = value.TryGetProperty("subjectBox", out var raw) && raw.ValueKind == JsonValueKind.Object
            ? new Box(raw.GetProperty("left").GetInt32(), raw.GetProperty("top").GetInt32(), raw.GetProperty("width").GetInt32(), raw.GetProperty("height").GetInt32()) : null;
        _box = selected.SubjectBox;
        var image = await Task.Run(() => {
            var bitmap = new BitmapImage(); bitmap.BeginInit(); bitmap.CacheOption = BitmapCacheOption.OnLoad;
            bitmap.CreateOptions = BitmapCreateOptions.IgnoreImageCache; bitmap.DecodePixelWidth = 1000;
            bitmap.UriSource = new Uri(System.IO.Path.GetFullPath(selected.Path)); bitmap.EndInit(); bitmap.Freeze(); return bitmap;
        });
        if (_files.SelectedItem != selected) return;
        _image.Source = image;
        _image.RenderTransform = Transform.Identity;
        _scale = Math.Min(_canvas.Width / selected.Width, _canvas.Height / selected.Height);
        var width = selected.Width * _scale; var height = selected.Height * _scale;
        _offsetX = (_canvas.Width - width) / 2; _offsetY = (_canvas.Height - height) / 2;
        _image.Width = width; _image.Height = height;
        Canvas.SetLeft(_image, _offsetX); Canvas.SetTop(_image, _offsetY);
        _angle.Value = selected.Angle;
        DrawBox();
        _status.Text = "枠をドラッグして商品全体を囲み、水平角はスライダーで調整できます。";
        }
        catch (Exception error) { _status.Text = "写真を読み込めませんでした：" + error.Message; }
    }
    private Point ToImage(Point point) => _current is null ? new Point() : new Point(
        Math.Clamp((point.X - _offsetX) / _scale, 0, _current.Width),
        Math.Clamp((point.Y - _offsetY) / _scale, 0, _current.Height));
    private void StartBox(object sender, MouseButtonEventArgs e)
    {
        if (_current is null) return;
        if (Math.Abs(_angle.Value - _current.Angle) > 0.01)
        { _status.Text = "角度を保存して見直してから商品枠を調整してください。"; return; }
        _start = ToImage(e.GetPosition(_canvas)); _canvas.CaptureMouse();
    }
    private void MoveBox(object sender, MouseEventArgs e)
    {
        if (_start is null || _current is null) return;
        var end = ToImage(e.GetPosition(_canvas));
        _box = new Box((int)Math.Min(_start.Value.X, end.X), (int)Math.Min(_start.Value.Y, end.Y),
            (int)Math.Abs(end.X - _start.Value.X), (int)Math.Abs(end.Y - _start.Value.Y));
        DrawBox();
    }
    private void EndBox(object sender, MouseButtonEventArgs e)
    {
        if (_start is null) return;
        MoveBox(sender, e); _start = null; _canvas.ReleaseMouseCapture();
    }
    private void DrawBox()
    {
        if (_box is null || _box.width <= 0 || _box.height <= 0) { _outline.Visibility = Visibility.Collapsed; return; }
        _outline.Visibility = Visibility.Visible;
        Canvas.SetLeft(_outline, _offsetX + _box.left * _scale);
        Canvas.SetTop(_outline, _offsetY + _box.top * _scale);
        _outline.Width = _box.width * _scale; _outline.Height = _box.height * _scale;
    }
    private async Task SaveAsync()
    {
        if (_current is null || (_detail.IsChecked!=true && (_box is null || _box.width < 5 || _box.height < 5)))
        { _status.Text = "商品全体を枠で囲んでください。"; return; }
        var angle = Math.Round(_angle.Value, 2);
        try
        {
            await _runner.RunAsync("framing-override", [_session, _current.Name, angle.ToString(CultureInfo.InvariantCulture), JsonSerializer.Serialize(_detail.IsChecked==true?null:_box), _detail.IsChecked==true?"detail":"whole"]);
            _current.SubjectBox = _box; _current.Angle = angle;
            _status.Text = _current.Name + " の商品範囲と水平角を保存しました。";
        }
        catch (Exception error) { _status.Text = "保存できませんでした：" + error.Message; }
    }
}

using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace PhotoStation.Desktop;

/// <summary>One import session is one product. The selection is explicit so a
/// camera card containing several products cannot become a single photo batch.</summary>
public sealed class ProductImageSelectionWindow : Window
{
    private readonly ListBox _photos = new() { SelectionMode = SelectionMode.Multiple };
    private readonly TextBlock _count = new();
    private IReadOnlyList<FileInfo>? _chosen;

    public ProductImageSelectionWindow(IReadOnlyList<FileInfo> files)
    {
        Title = "今回取り込む1商品の写真";
        Width = 1100; Height = 780; MinWidth = 700; MinHeight = 500;
        if (App.IsTouchMode) { WindowState = WindowState.Maximized; FontSize = 16; }
        var layout = new DockPanel { Margin = new Thickness(16) };
        Content = layout;
        var introduction = new TextBlock {
            Text = "同じ商品に属する写真をクリックして選択します。もう一度クリックすると解除できます。別の商品は次の取込で選びます。SDカードの写真は変更されません。",
            TextWrapping = TextWrapping.Wrap, FontSize = 15, Margin = new Thickness(0, 0, 0, 12) };
        DockPanel.SetDock(introduction, Dock.Top); layout.Children.Add(introduction);
        var actions = new WrapPanel { HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 12, 0, 0) };
        DockPanel.SetDock(actions, Dock.Bottom); layout.Children.Add(actions);
        actions.Children.Add(_count);
        var import = new Button { Content = "選択した1商品を取り込む", IsEnabled = false, Padding = new Thickness(12, 7, 12, 7), Margin = new Thickness(16, 0, 0, 0) };
        import.Click += (_, _) => { _chosen = _photos.SelectedItems.Cast<FileInfo>().ToArray(); DialogResult = true; };
        var cancel = new Button { Content = "後で選ぶ", Padding = new Thickness(12, 7, 12, 7), Margin = new Thickness(8, 0, 0, 0) };
        cancel.Click += (_, _) => DialogResult = false;
        actions.Children.Add(import); actions.Children.Add(cancel);
        _photos.SelectionChanged += (_, _) => { _count.Text = $"{_photos.SelectedItems.Count}枚を選択"; import.IsEnabled = _photos.SelectedItems.Count > 0; };
        // Show three sizeable cards per row so the full product can be
        // checked at a glance. Decode only screen-sized thumbnails below.
        _photos.SetValue(ScrollViewer.HorizontalScrollBarVisibilityProperty, ScrollBarVisibility.Disabled);
        var panel = new FrameworkElementFactory(typeof(WrapPanel));
        panel.SetValue(WrapPanel.ItemWidthProperty, 338d);
        _photos.ItemsPanel = new ItemsPanelTemplate(panel);
        _photos.ItemTemplate = BuildTemplate();
        _photos.ItemContainerStyle = BuildSelectionStyle();
        _photos.ItemsSource = files.OrderBy(f => f.LastWriteTimeUtc).ThenBy(f => f.FullName).ToArray();
        layout.Children.Add(_photos);
    }

    public IReadOnlyList<FileInfo>? Choose() => ShowDialog() == true ? _chosen : null;

    private static Style BuildSelectionStyle()
    {
        // Rely on explicit Border/Background setters rather than the theme's
        // default highlight so selection is obvious regardless of Windows theme.
        var style = new Style(typeof(ListBoxItem));
        style.Setters.Add(new Setter(FrameworkElement.MarginProperty, new Thickness(2)));
        style.Setters.Add(new Setter(Control.BorderThicknessProperty, new Thickness(4)));
        style.Setters.Add(new Setter(Control.BorderBrushProperty, Brushes.Transparent));
        style.Setters.Add(new Setter(Panel.BackgroundProperty, Brushes.Transparent));
        var selected = new Trigger { Property = ListBoxItem.IsSelectedProperty, Value = true };
        selected.Setters.Add(new Setter(Control.BorderBrushProperty, Brushes.DodgerBlue));
        selected.Setters.Add(new Setter(Panel.BackgroundProperty, new SolidColorBrush(Color.FromArgb(40, 30, 144, 255))));
        style.Triggers.Add(selected);
        return style;
    }

    private static DataTemplate BuildTemplate()
    {
        var template = new DataTemplate(typeof(FileInfo));
        var stack = new FrameworkElementFactory(typeof(StackPanel));
        stack.SetValue(FrameworkElement.WidthProperty, 318d);
        stack.SetValue(FrameworkElement.MarginProperty, new Thickness(4));
        var image = new FrameworkElementFactory(typeof(Image));
        image.SetValue(FrameworkElement.HeightProperty, 210d);
        image.SetValue(Image.StretchProperty, Stretch.Uniform);
        // IsAsync so decoding many candidates never blocks the UI thread while
        // the window first lays out; each thumbnail appears as it decodes.
        image.SetBinding(Image.SourceProperty, new System.Windows.Data.Binding("FullName") { Converter = new ThumbnailConverter(), IsAsync = true });
        stack.AppendChild(image);
        var label = new FrameworkElementFactory(typeof(TextBlock));
        label.SetBinding(TextBlock.TextProperty, new System.Windows.Data.Binding("Name"));
        label.SetValue(TextBlock.TextTrimmingProperty, TextTrimming.CharacterEllipsis);
        stack.AppendChild(label);
        template.VisualTree = stack;
        return template;
    }

    private sealed class ThumbnailConverter : System.Windows.Data.IValueConverter
    {
        public object? Convert(object value, Type targetType, object parameter, System.Globalization.CultureInfo culture)
        {
            var path = value as string;
            if (path is null) return null;
            try {
                var bitmap = new BitmapImage(); bitmap.BeginInit(); bitmap.UriSource = new Uri(path);
                bitmap.DecodePixelWidth = 360; bitmap.CacheOption = BitmapCacheOption.OnLoad;
                bitmap.EndInit(); bitmap.Freeze(); return bitmap;
            } catch { return null; }
        }
        public object ConvertBack(object value, Type targetType, object parameter, System.Globalization.CultureInfo culture) => throw new NotSupportedException();
    }
}

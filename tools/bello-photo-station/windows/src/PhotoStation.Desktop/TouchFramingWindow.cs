using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using PhotoStation.Infrastructure;

namespace PhotoStation.Desktop;

/// <summary>Only display transforms run during gestures. Originals are never changed here.</summary>
public sealed class TouchFramingWindow : Window
{
    public sealed record Position(string FileName, string SourceHash, int Width, int Height,
        double CenterX = .5, double CenterY = .5, double Zoom = 1);
    public sealed record Saved(int Version, bool Completed, string TopFileName, double AspectRatio, Dictionary<string, Position> Items);
    private sealed record Preview(BitmapImage Image, string Hash, int Width, int Height);
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true };
    private readonly PresetWorkflowRunner _runner;
    private readonly string _session, _directory;
    private readonly Grid _space = new() { Background = new SolidColorBrush(Color.FromRgb(30,35,43)), Margin = new Thickness(0,8,0,8) };
    private readonly Canvas _frame = new() { ClipToBounds = true, Background = Brushes.Black, IsManipulationEnabled = true };
    private readonly Image _image = new() { Stretch = Stretch.Fill, IsHitTestVisible = false };
    private readonly ScaleTransform _scale = new();
    private readonly TranslateTransform _translate = new();
    private readonly TextBlock _heading = new() { FontSize = 21, FontWeight = FontWeights.Bold };
    private readonly TextBlock _message = new() { FontSize = 14, TextWrapping = TextWrapping.Wrap };
    private readonly Button _previous = Button("戻る"), _next = Button("次へ"), _finish = Button("完了・現像へ"), _top = Button("この写真をトップにする");
    private readonly Button _square = Button("正方形 1:1"), _wide = Button("横長 3:2");
    private readonly Slider _zoom = new() { Minimum = 1, Maximum = 4, Value = 1, Width = 140, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(10,0,10,0) };
    private readonly ComboBox _preset = new() { MinHeight=44,MinWidth=220,FontSize=16,Margin=new Thickness(6) };
    public string? SelectedPresetId => (_preset.SelectedItem as ComboBoxItem)?.Tag as string;
    private readonly Dictionary<string, Position> _positions = new();
    private readonly Dictionary<string, Task<Preview>> _cache = new();
    private readonly SemaphoreSlim _decodeLimit = new(2);
    private string[] _names = [];
    private int _index;
    private string _topName = "";
    private double _ratio = 1;
    private bool _busy, _loading, _updating, _allowClose;
    private Preview? _current;
    private Point? _mouse;
    private static Button Button(string text) => new() { Content = text, MinHeight = 50, Padding = new Thickness(18,8,18,8), Margin = new Thickness(4), FontSize = 17 };

    public TouchFramingWindow(PresetWorkflowRunner runner, string session, string stationRoot)
    {
        _runner = runner; _session = session; _directory = Path.Combine(stationRoot,"sessions",session);
        Title = "写真の位置を調整"; Width = 1080; Height = 760; MinWidth = 800; MinHeight = 480;
        if (App.IsTouchMode) WindowState = WindowState.Maximized;
        Background=Brushes.White;Foreground=new SolidColorBrush(Color.FromRgb(25,35,50));
        var root = new DockPanel { Margin = new Thickness(16),Background=Brushes.White }; Content = root;
        var header = new StackPanel();
        header.Children.Add(_heading);
        header.Children.Add(new TextBlock { Text = "写真を指で動かして位置を合わせます。2本指で拡大・縮小できます。", FontSize = 15, Margin = new Thickness(0,4,0,4) });
        var tools = new WrapPanel();
        tools.Children.Add(_square); tools.Children.Add(_wide); tools.Children.Add(_top);
        var center = Button("中央に戻す"); tools.Children.Add(center); tools.Children.Add(_zoom);
        header.Children.Add(tools); DockPanel.SetDock(header,Dock.Top); root.Children.Add(header);
        var recipe = new WrapPanel();
        recipe.Children.Add(new TextBlock { Text="現像の仕上がり",VerticalAlignment=VerticalAlignment.Center,FontSize=15 });
        recipe.Children.Add(_preset); header.Children.Add(recipe);
        var bottom = new DockPanel();
        var navigation = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        var later = Button("後で続ける");
        navigation.Children.Add(later); navigation.Children.Add(_previous); navigation.Children.Add(_next); navigation.Children.Add(_finish);
        _finish.Background = new SolidColorBrush(Color.FromRgb(36,91,190)); _finish.Foreground = Brushes.White;
        DockPanel.SetDock(navigation,Dock.Right); bottom.Children.Add(navigation); bottom.Children.Add(_message);
        DockPanel.SetDock(bottom,Dock.Bottom); root.Children.Add(bottom); root.Children.Add(_space);
        _space.Children.Add(_frame); _frame.Children.Add(_image);
        _image.RenderTransform = new TransformGroup { Children = { _scale, _translate } };
        RenderOptions.SetBitmapScalingMode(_image,BitmapScalingMode.LowQuality);
        _space.SizeChanged += (_,_) => UpdateFrame();
        _square.Click += async (_,_) => await ChangeRatio(1); _wide.Click += async (_,_) => await ChangeRatio(1.5);
        _top.Click += (_,_) => { if (_current is null) return; _topName = _names[_index]; UpdateFrame(); };
        center.Click += (_,_) => { if (_current is null) return; var p=Current; SavePosition(p with { CenterX=.5,CenterY=.5 }); };
        _zoom.ValueChanged += (_,_) => { if (_current is null || _updating) return; SavePosition(Current with { Zoom=_zoom.Value }); };
        _previous.Click += async (_,_) => await Navigate(-1);
        _next.Click += async (_,_) => await Navigate(1);
        _finish.Click += async (_,_) => await Finish();
        later.Click += async (_,_) => await CloseDraft();
        _frame.MouseLeftButtonDown += (_,e) => { if (_current is null || e.StylusDevice is not null) return; _mouse=e.GetPosition(_frame); _frame.CaptureMouse(); e.Handled=true; };
        _frame.MouseMove += (_,e) => {
            if (_mouse is not Point old || e.LeftButton!=MouseButtonState.Pressed) return;
            var point=e.GetPosition(_frame); Move(point.X-old.X,point.Y-old.Y,1); _mouse=point; e.Handled=true;
        };
        _frame.MouseLeftButtonUp += (_,e) => { _mouse=null; _frame.ReleaseMouseCapture(); e.Handled=true; };
        _frame.LostMouseCapture += (_,_) => _mouse=null;
        _frame.MouseWheel += (_,e) => { Move(0,0,e.Delta>0?1.08:1/1.08); e.Handled=true; };
        _frame.ManipulationStarting += (_,e) => { e.ManipulationContainer=_frame; e.Mode=ManipulationModes.Translate|ManipulationModes.Scale; e.Handled=true; };
        _frame.ManipulationDelta += (_,e) => {
            if(!e.IsInertial) Move(e.DeltaManipulation.Translation.X,e.DeltaManipulation.Translation.Y,
                (e.DeltaManipulation.Scale.X+e.DeltaManipulation.Scale.Y)/2);
            else e.Complete();
            e.Handled=true;
        };
        Loaded += async (_,_) => {
            try {
                _loading=true; SetButtons(); _message.Text="写真を読み込んでいます…";
                var list=await _runner.RunAsync("list",[_session]);
                var defaultId=list.TryGetProperty("defaultPresetId",out var d)&&d.ValueKind==JsonValueKind.String?d.GetString():null;
                if(list.TryGetProperty("selections",out var selections)&&selections.ValueKind==JsonValueKind.Object) {
                    var previous=selections.EnumerateObject().Select(p=>p.Value.TryGetProperty("preset",out var recipe)&&recipe.TryGetProperty("id",out var recipeId)?recipeId.GetString():null).Distinct().ToArray();
                    if(previous.Length==1&&previous[0] is not null)defaultId=previous[0];
                }
                foreach(var preset in list.GetProperty("presets").EnumerateArray()) {
                    var item=new ComboBoxItem { Content=preset.GetProperty("name").GetString(),Tag=preset.GetProperty("id").GetString() };
                    _preset.Items.Add(item);if((string?)item.Tag==defaultId)_preset.SelectedItem=item;
                }
                if(_preset.SelectedIndex<0&&_preset.Items.Count>0)_preset.SelectedIndex=0;
                _names=list.GetProperty("sources").EnumerateArray().Select(x=>x.GetProperty("fileName").GetString()!).ToArray();
                if(_names.Length==0)throw new InvalidOperationException("取込済み写真がありません");
                _topName=_names[0];
                foreach(var name in new[]{"touch-framing-draft.json","touch-framing.json"}) {
                    var file=Path.Combine(_directory,name); if(!File.Exists(file))continue;
                    try {
                        var saved=JsonSerializer.Deserialize<Saved>(await File.ReadAllTextAsync(file),Json);
                        if(saved is { Version:1 } && saved.AspectRatio is 1 or 1.5) {
                            _ratio=saved.AspectRatio;
                            if(_names.Contains(saved.TopFileName))_topName=saved.TopFileName;
                            foreach(var p in saved.Items)if(_names.Contains(p.Key))_positions[p.Key]=p.Value;
                        }
                    } catch(JsonException) { }
                    break;
                }
                await ShowPhoto();
            } catch(Exception e) { _loading=false; _message.Text=e.Message; SetButtons(); }
        };
        Closing += async (_,e) => { if(_allowClose)return; e.Cancel=true; if(!_busy)await CloseDraft(); };
    }

    private Position Current => _positions[_names[_index]];
    private async Task ChangeRatio(double ratio) {
        if(_current is null || _loading || _busy || ratio==_ratio)return;
        _ratio=ratio; UpdateFrame();
        // All photos share one frame. Revisit them when the shared shape changes.
        await Navigate(-_index);
        _message.Text="全写真の形を変更しました。1枚目から位置を確認してください。";
    }
    private void SavePosition(Position position) { _positions[_names[_index]]=position; UpdateFrame(); }
    private void Move(double dx,double dy,double factor) {
        if(_current is null||_loading||_busy)return;
        var p=Current; var z=Math.Clamp(p.Zoom*factor,1,4);
        SavePosition(p with { Zoom=z, CenterX=p.CenterX-dx/(_image.Width*_scale.ScaleX), CenterY=p.CenterY-dy/(_image.Height*_scale.ScaleY) });
    }
    private void UpdateFrame() {
        if(_current is null||_space.ActualWidth<1||_space.ActualHeight<1)return;
        var cw=Math.Min(_space.ActualWidth-8,(_space.ActualHeight-8)*_ratio);var ch=cw/_ratio;
        if(cw<=0||ch<=0)return;
        _frame.Width=cw;_frame.Height=ch;
        _image.Width=_current.Image.PixelWidth;_image.Height=_current.Image.PixelHeight;
        var p=Current;
        var z=Math.Clamp(double.IsFinite(p.Zoom)?p.Zoom:1,1,4);
        var scale=Math.Max(cw/_image.Width,ch/_image.Height)*z;
        var halfX=Math.Min(.5,cw/(2*_image.Width*scale));var halfY=Math.Min(.5,ch/(2*_image.Height*scale));
        p=p with {Zoom=z,CenterX=Math.Clamp(double.IsFinite(p.CenterX)?p.CenterX:.5,halfX,1-halfX),
            CenterY=Math.Clamp(double.IsFinite(p.CenterY)?p.CenterY:.5,halfY,1-halfY)};
        _positions[_names[_index]]=p;
        _scale.ScaleX=_scale.ScaleY=scale;
        _translate.X=cw/2-p.CenterX*_image.Width*scale;_translate.Y=ch/2-p.CenterY*_image.Height*scale;
        _updating=true;_zoom.Value=z;_updating=false;
        _heading.Text=$"{_index+1} / {_names.Length}枚　{(_topName==_names[_index]?"★ トップ写真":"位置の確認")}";
        _square.FontWeight=_ratio==1?FontWeights.Bold:FontWeights.Normal;
        _wide.FontWeight=_ratio==1.5?FontWeights.Bold:FontWeights.Normal;
    }
    private Task<Preview> GetPreview(string name) {
        if(_cache.TryGetValue(name,out var task))return task;
        async Task<Preview> Load() {
            await _decodeLimit.WaitAsync();
            try {
                var data=await _runner.RunAsync("touch-preview",[_session,name]);
                return await Task.Run(()=> {
                    var image=new BitmapImage();image.BeginInit();image.CacheOption=BitmapCacheOption.OnLoad;
                    image.UriSource=new Uri(data.GetProperty("path").GetString()!);image.EndInit();image.Freeze();
                    return new Preview(image,data.GetProperty("sourceHash").GetString()!,data.GetProperty("width").GetInt32(),data.GetProperty("height").GetInt32());
                });
            } finally {_decodeLimit.Release();}
        }
        return _cache[name]=Load();
    }
    private async Task ShowPhoto() {
        _loading=true;_current=null;_image.Source=null;SetButtons();_message.Text="写真を読み込んでいます…";
        try {
            var name=_names[_index];_current=await GetPreview(name);
            if(!_positions.TryGetValue(name,out var p)||p.SourceHash!=_current.Hash)
                _positions[name]=new(name,_current.Hash,_current.Width,_current.Height);
            _image.Source=_current.Image;
            _message.Text="位置を合わせて「次へ」。余白は追加されません。";
            UpdateFrame();
            var keep=_names.Skip(Math.Max(0,_index-1)).Take(4).ToHashSet();
            foreach(var key in _cache.Keys.Where(k=>!keep.Contains(k)).ToArray())_cache.Remove(key);
            foreach(var next in _names.Skip(_index+1).Take(2)) _=Prefetch(next);
        } catch(Exception e) {_message.Text=e.Message;_current=null;}
        finally {_loading=false;SetButtons();}
    }
    private async Task Prefetch(string name) {try{await GetPreview(name);}catch{_cache.Remove(name);}}
    private void SetButtons() {
        var enabled=!_busy&&!_loading&&_current is not null;
        _previous.IsEnabled=enabled&&_index>0;_next.IsEnabled=enabled&&_index<_names.Length-1;
        _finish.IsEnabled=enabled&&_index==_names.Length-1&&_positions.Count==_names.Length;
        _square.IsEnabled=_wide.IsEnabled=_top.IsEnabled=_zoom.IsEnabled=_preset.IsEnabled=enabled;
    }
    private async Task Persist(bool completed) {
        if(_names.Length==0)return;
        Directory.CreateDirectory(_directory);
        var value=new Saved(1,completed,_topName,_ratio,_positions);
        var file=Path.Combine(_directory,completed?"touch-framing.json":"touch-framing-draft.json");
        var temp=file+".tmp";await File.WriteAllTextAsync(temp,JsonSerializer.Serialize(value,Json));File.Move(temp,file,true);
        if(completed) {
            var choice=Path.Combine(_directory,"framing-choice.json");
            await File.WriteAllTextAsync(choice+".tmp",JsonSerializer.Serialize(new{topFileName=_topName},Json));File.Move(choice+".tmp",choice,true);
            var draft=Path.Combine(_directory,"touch-framing-draft.json");if(File.Exists(draft))File.Delete(draft);
        }
    }
    private async Task Navigate(int step) {
        if(_busy||_loading)return;_busy=true;SetButtons();
        try {await Persist(false);_index=Math.Clamp(_index+step,0,_names.Length-1);await ShowPhoto();}
        catch(Exception e){_message.Text=e.Message;}
        finally{_busy=false;SetButtons();}
    }
    private async Task Finish() {
        if(_busy||_loading||_current is null)return;_busy=true;SetButtons();
        try {await Persist(true);_allowClose=true;DialogResult=true;}
        catch(Exception e){_message.Text="位置を保存できませんでした："+e.Message;_busy=false;SetButtons();}
    }
    private async Task CloseDraft() {
        if(_busy)return;_busy=true;SetButtons();
        try {await Persist(false);_allowClose=true;Close();}
        catch(Exception e){_message.Text="途中の位置を保存できませんでした："+e.Message;_busy=false;SetButtons();}
    }
}

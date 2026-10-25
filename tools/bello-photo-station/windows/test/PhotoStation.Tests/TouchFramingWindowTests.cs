using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using PhotoStation.Desktop;
using PhotoStation.Infrastructure;

namespace PhotoStation.Tests;

public sealed class TouchFramingWindowTests
{
    [Fact]
    public void PositionReviewPersistsAcrossCancelThenCompletesAllPhotos()
    {
        Exception? failure=null;
        var thread=new Thread(()=> {
            try { Run(); } catch(Exception e) { failure=e; }
        });
        thread.SetApartmentState(ApartmentState.STA);thread.Start();
        Assert.True(thread.Join(TimeSpan.FromSeconds(90)),"WPF review timed out");
        if(failure is not null)throw failure;
    }

    private static void Run()
    {
        RenderOptions.ProcessRenderMode=System.Windows.Interop.RenderMode.SoftwareOnly;
        var evidence=Environment.GetEnvironmentVariable("BELLO_TOUCH_QA_ROOT");
        var root=evidence is null?Path.Combine(Path.GetTempPath(),"touch-wpf-"+Guid.NewGuid()):Path.Combine(evidence,"WPF");
        var id=Guid.NewGuid().ToString("D");
        var session=Path.Combine(root,"sessions",id);var source=Path.Combine(session,"source");
        Directory.CreateDirectory(source);
        for(var i=0;i<3;i++){
            var actual=evidence is null?null:Directory.GetFiles(Path.Combine(evidence,"取込元","DCIM")).Order().ElementAt(i);
            if(actual is not null)File.Copy(actual,Path.Combine(source,$"{i+1}.jpg"));
            else {
                var visual=new DrawingVisual();
                using(var context=visual.RenderOpen()){
                    context.DrawRectangle(Brushes.LightGray,null,new Rect(0,0,900,600));
                    context.DrawRectangle(Brushes.DarkBlue,null,new Rect(300,150,300,300));
                }
                var bitmap=new RenderTargetBitmap(900,600,96,96,PixelFormats.Pbgra32);bitmap.Render(visual);
                var encoder=new JpegBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));
                using var stream=File.Create(Path.Combine(source,$"{i+1}.jpg"));encoder.Save(stream);
            }
        }
        var script=Path.GetFullPath("../../../../../../src/presetCli.mjs",AppContext.BaseDirectory);
        var runner=new PresetWorkflowRunner("node",script,root);
        var first=new TouchFramingWindow(runner,id,root){Width=1080,Height=760};
        Exception? error=null;
        first.Loaded+=async (_,_)=>{
            try{
                await Ready(first);
                AssertCentered(first);
                Move(first,0,0,1.5);
                AssertCentered(first);
                Move(first,0,0,1/1.5);
                var watch=Stopwatch.StartNew();
                for(var i=0;i<500;i++)Move(first,i%2==0?1:-1,0,1);
                watch.Stop();
                Move(first,-80,-20,1.5);
                Click(first,"中央に戻す");
                AssertCentered(first);
                SaveImage(first,Path.Combine(root,"01-position.png"));
                Click(first,"次へ");await Ready(first,2);
                File.WriteAllText(Path.Combine(root,"performance.json"),JsonSerializer.Serialize(new{syntheticGestureCount=500,totalMilliseconds=watch.Elapsed.TotalMilliseconds,physicalTouchTested=false}));
                Click(first,"後で続ける");
            }catch(Exception e){error=e;first.Close();}
        };
        first.ShowDialog();if(error is not null)throw error;
        Assert.False(File.Exists(Path.Combine(session,"touch-framing.json")));
        var draft=JsonDocument.Parse(File.ReadAllText(Path.Combine(session,"touch-framing-draft.json")));
        Assert.True(draft.RootElement.GetProperty("items").GetProperty("1.jpg").GetProperty("zoom").GetDouble()>1);
        var second=new TouchFramingWindow(runner,id,root){Width=1080,Height=760};
        second.Loaded+=async (_,_)=>{
            try{
                await Ready(second);
                Click(second,"横長 3:2");await Ready(second);
                Click(second,"次へ");await Ready(second,2);
                Click(second,"次へ");await Ready(second,3);
                SaveImage(second,Path.Combine(root,"02-last-photo.png"));
                Assert.True(Find(second,"完了・現像へ").IsEnabled);
                Click(second,"完了・現像へ");
            }catch(Exception e){error=e;second.Close();}
        };
        Assert.True(second.ShowDialog());if(error is not null)throw error;
        var saved=JsonDocument.Parse(File.ReadAllText(Path.Combine(session,"touch-framing.json")));
        Assert.Equal(1.5,saved.RootElement.GetProperty("aspectRatio").GetDouble());
        Assert.True(saved.RootElement.GetProperty("completed").GetBoolean());
        Assert.Equal(3,saved.RootElement.GetProperty("items").EnumerateObject().Count());
        Assert.False(File.Exists(Path.Combine(session,"touch-framing-draft.json")));
        File.WriteAllText(Path.Combine(root,"last-session.txt"),id);
    }
    private static void Move(TouchFramingWindow w,double dx,double dy,double zoom)=>typeof(TouchFramingWindow).GetMethod("Move",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(w,[dx,dy,zoom]);
    private static void AssertCentered(TouchFramingWindow w){
        w.UpdateLayout();
        var image=(Image)typeof(TouchFramingWindow).GetField("_image",BindingFlags.Instance|BindingFlags.NonPublic)!.GetValue(w)!;
        var frame=(Canvas)typeof(TouchFramingWindow).GetField("_frame",BindingFlags.Instance|BindingFlags.NonPublic)!.GetValue(w)!;
        var point=image.TranslatePoint(new Point(image.ActualWidth/2,image.ActualHeight/2),frame);
        Assert.InRange(Math.Abs(point.X-frame.ActualWidth/2),0,.01);
        Assert.InRange(Math.Abs(point.Y-frame.ActualHeight/2),0,.01);
    }
    private static void Click(DependencyObject w,string label)=>Find(w,label).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
    private static Button Find(DependencyObject root,string label)=>Children(root).OfType<Button>().Single(b=>Equals(b.Content,label));
    private static IEnumerable<DependencyObject> Children(DependencyObject root){
        yield return root;
        foreach(var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>())
            foreach(var node in Children(child))yield return node;
    }
    private static async Task Ready(TouchFramingWindow w,int number=1){
        var start=Stopwatch.StartNew();
        while(start.Elapsed<TimeSpan.FromSeconds(25)){
            if(Children(w).OfType<TextBlock>().Any(t=>t.Text.StartsWith($"{number} /"))&&Find(w,"この写真をトップにする").IsEnabled)return;
            await Task.Delay(40);
        }
        throw new Exception("Review not ready: "+string.Join(" | ",Children(w).OfType<TextBlock>().Select(t=>t.Text)));
    }
    private static void SaveImage(Window w,string path){
        w.UpdateLayout();
        var content=(FrameworkElement)w.Content;
        var bitmap=new RenderTargetBitmap((int)content.ActualWidth,(int)content.ActualHeight,96,96,PixelFormats.Pbgra32);bitmap.Render(content);
        var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using var stream=File.Create(path);encoder.Save(stream);
    }
}

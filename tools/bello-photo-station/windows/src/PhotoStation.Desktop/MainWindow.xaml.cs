using System.IO;
using System.Windows;
using PhotoStation.Application;
namespace PhotoStation.Desktop;
public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        if (App.IsTestMode) Title = "BELLO Photo Station r12 テスト用";
        if (App.IsTouchMode) {
            Title = "BELLO Photo Station r12 写真取込専用";
            DesktopPanel.Visibility = Visibility.Collapsed; TouchPanel.Visibility = Visibility.Visible;
            MinWidth = 800; MinHeight = 480; WindowState = WindowState.Maximized;
        }
        var model = new MainViewModel(); DataContext = model;
        model.EnsureLightroomReadyAsync = async () => {
            if (App.LightroomStartup is { } startup) model.LightroomStatus = await startup;
            return LightroomConnection.IsConnected(model.StationRoot);
        };
        model.SelectPresetAsync = async session => {
            if(model.CreatePresetRunner() is not {} runner)return false;
            var framingWindow=new TouchFramingWindow(runner,session,model.StationRoot){Owner=this};
            if(framingWindow.ShowDialog()!=true)return false;
            if(framingWindow.SelectedPresetId is {} chosen) {
                await runner.RunAsync("choose-product",[session,chosen]);return true;
            }
            var data=await runner.RunAsync("list",[session]);
            var presets=data.GetProperty("presets").EnumerateArray().ToArray();
            var saved=data.TryGetProperty("defaultPresetId",out var value)&&value.ValueKind==System.Text.Json.JsonValueKind.String?value.GetString():null;
            var preset=presets.FirstOrDefault(p=>p.GetProperty("id").GetString()==saved);
            if(preset.ValueKind==System.Text.Json.JsonValueKind.Undefined)preset=presets.FirstOrDefault();
            if(preset.ValueKind==System.Text.Json.JsonValueKind.Undefined)
                return new PresetComparisonWindow(runner,session){Owner=this}.ShowDialog()==true;
            await runner.RunAsync("choose-product",[session,preset.GetProperty("id").GetString()!]);
            return true;
        };
        model.SelectProductImagesAsync = files => Task.FromResult<IReadOnlyList<FileInfo>?>(
            new ProductImageSelectionWindow(files) { Owner = this }.Choose());
        Loaded += async (_, _) =>
        {
            if (Environment.GetCommandLineArgs().Contains("--installation-check"))
            {
                Title += "（インストール確認）";
                IsEnabled = false;
                return;
            }
            await model.InitializeAsync();
            if (App.LightroomStartup is { } startup) model.LightroomStatus = await startup;
            if (App.IsTouchMode && model.LightroomStatus.Contains("接続済み")) Activate();
        };
        Closing += (_, e) => {
            if (model.IsBusy) { e.Cancel = true; MessageBox.Show(this, "写真の処理中です。処理が終わってから終了してください。", "BELLO Photo Station"); }
        };
        var connectionTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
        connectionTimer.Tick += (_, _) => {
            if (LightroomConnection.IsConnected(model.StationRoot)) model.LightroomStatus = "Lightroom Classic プラグイン接続済み";
            else if (model.LightroomStatus == "Lightroom Classic プラグイン接続済み")
                model.LightroomStatus = "Lightroomとの接続が切れています。［Lightroomを接続］を押してください。";
        };
        if (!Environment.GetCommandLineArgs().Contains("--installation-check")) connectionTimer.Start();
        Closed += async (_, _) => { connectionTimer.Stop(); model.StopDetection(); try { await model.SaveDestinationAsync(); } catch { } };
    }

    private void ChooseFolder_Click(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel model || model.IsBusy) return;
        var dialog = new Microsoft.Win32.OpenFolderDialog { Title = "写真の保存先を選択", Multiselect = false };
        if (Directory.Exists(model.DestinationFolder)) dialog.InitialDirectory = model.DestinationFolder;
        if (dialog.ShowDialog(this) == true) model.DestinationFolder = dialog.FolderName;
    }

    private void SignOut_Click(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel model || model.IsBusy) return;
        try { ValidationSession.SignOut(); model.MarkSignedOut(); MessageBox.Show(this, "このPCからログアウトしました。次にWEBへ保存するときにログインしてください。", "BELLO Photo Station"); }
        catch { MessageBox.Show(this, "認証情報を削除できませんでした。アプリを終了してから再度お試しください。", "BELLO Photo Station"); }
    }

    private async void SetupLightroom_Click(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel model || model.IsBusy) return;
        var button = (System.Windows.Controls.Button)sender; button.IsEnabled = false;
        try
        {
            model.LightroomStatus = "Lightroom連携を設定しています…";
            model.LightroomStatus = await LightroomConnection.ConfigureAndConnectAsync(model.StationRoot);
            MessageBox.Show(this, model.LightroomStatus, "Lightroom連携");
        }
        catch (Exception error) { MessageBox.Show(this, error.Message, "Lightroom連携"); }
        finally { button.IsEnabled = true; }
    }

    private void OpenSettings_Click(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel viewModel) return;
        if (viewModel.IsBusy) return;
        var settingsViewModel = new SettingsViewModel(viewModel.SettingsStore, viewModel.CreatePreviewRunner(), viewModel.PreviewOutputDir);
        new SettingsWindow(settingsViewModel) { Owner = this }.ShowDialog();
    }
}

using System.Diagnostics;
using System.IO;
using System.Text.Json;
using Microsoft.Win32;
using PhotoStation.Infrastructure;

namespace PhotoStation.Desktop;

internal static class LightroomConnection
{
    private static readonly SemaphoreSlim SetupLock = new(1, 1);
    public static bool IsConnected(string stationRoot) => LightroomConnectionStatus.IsConnected(
        Environment.GetEnvironmentVariable("BELLO_LIGHTROOM_BRIDGE_ROOT") ?? stationRoot, DateTimeOffset.UtcNow, 10);

    private static void RequestConnection()
    {
        // Lightroom's documented local URL handler resumes our enabled plugin.
        // No tokens, photo paths, or arbitrary commands are sent through the URL.
        using var key = Registry.ClassesRoot.OpenSubKey(@"lightroom\shell\open\command");
        if (key is null) return;
        try { using var process = Process.Start(new ProcessStartInfo("lightroom://jp.bello.photo-station/connect") { UseShellExecute = true }); }
        catch (System.ComponentModel.Win32Exception) { /* The status below remains unconnected. */ }
    }

    private static string Record(string stationRoot, string status)
    {
        try
        {
            var processes = Process.GetProcessesByName("Lightroom");
            var versions = new List<string>();
            foreach (var process in processes)
            {
                using (process) { try { versions.Add(process.MainModule?.FileVersionInfo.ProductVersion ?? "unknown"); } catch { versions.Add("unknown"); } }
            }
            var root = Environment.GetEnvironmentVariable("BELLO_LIGHTROOM_BRIDGE_ROOT") ?? stationRoot;
            var log = Path.Combine(stationRoot, "diagnostics");
            Directory.CreateDirectory(log);
            File.WriteAllText(Path.Combine(log, "lightroom-connection.json"), JsonSerializer.Serialize(new {
                checkedAt = DateTimeOffset.UtcNow, status, stationRoot, bridgeRoot = root,
                connected = IsConnected(stationRoot), lightroomVersions = versions,
                heartbeatExists = File.Exists(Path.Combine(root, "lightroom", "heartbeat.json"))
            }));
        }
        catch (IOException) { /* Diagnostics must never hide the original outcome. */ }
        catch (UnauthorizedAccessException) { }
        return status;
    }
    public static async Task<string> ConfigureAndConnectAsync(string stationRoot)
    {
        await SetupLock.WaitAsync();
        try
        {
            var script = Path.Combine(AppContext.BaseDirectory, "Install-LightroomBridge.ps1");
            if (!File.Exists(script)) return "Lightroom連携ファイルがありません。配布フォルダーをすべて展開してください。";
            var processes = Process.GetProcessesByName("Lightroom");
            var wasRunning = processes.Length > 0;
            foreach (var process in processes) process.Dispose();
            var system = Environment.GetFolderPath(Environment.SpecialFolder.System);
            var start = new ProcessStartInfo(Path.Combine(system, "WindowsPowerShell", "v1.0", "powershell.exe"))
            {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
            foreach (var argument in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
                "-StationRoot", stationRoot, "-PreserveExistingRoot" }) start.ArgumentList.Add(argument);
            start.Environment["PSModulePath"] = Path.Combine(system, "WindowsPowerShell", "v1.0", "Modules");
            using var installer = Process.Start(start) ?? throw new IOException("Lightroom連携の設定を開始できませんでした。");
            var outputTask = installer.StandardOutput.ReadToEndAsync();
            var errorTask = installer.StandardError.ReadToEndAsync();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            try { await installer.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException) { installer.Kill(true); throw new IOException("Lightroom連携の設定が時間内に完了しませんでした。設定ボタンから再実行してください。"); }
            var output = await outputTask; await errorTask;
            if (installer.ExitCode != 0) throw new IOException("Lightroom連携を配置できませんでした。フォルダー全体を展開し、［Lightroom連携の設定］で再実行してください。");
            var config = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "Adobe", "Lightroom", "Modules", "BelloPhotoStation.lrplugin", "root.txt");
            var bridgeRoot = File.ReadAllText(config).Trim();
            Environment.SetEnvironmentVariable("BELLO_LIGHTROOM_BRIDGE_ROOT", bridgeRoot);
            if (wasRunning && output.Contains("BELLO_LIGHTROOM_RELOAD_REQUIRED", StringComparison.Ordinal))
                return Record(stationRoot, "連携を更新しました。Lightroom Classicを一度終了してから［Lightroomを接続］を押してください。写真は取り込み直す必要はありません。");
            var launch = LightroomLauncher.Installed().EnsureStarted();
            if (launch.Contains("見つかりません") || launch.Contains("起動できません")) return launch;
            for (var i = 0; i < 180; i++)
            {
                if (IsConnected(stationRoot))
                    return Record(stationRoot, "Lightroom Classic プラグイン接続済み");
                if (i == 20 || i == 60 || i == 120) RequestConnection();
                await Task.Delay(500);
            }
            return Record(stationRoot, "Lightroomに接続できていません。Lightroomのログイン状態を確認し、［ファイル→プラグインマネージャー］でBELLO Photo Stationを有効にしてから［Lightroomを接続］を押してください。接続するまで現像・送信は行いません。");
        }
        catch (Exception error) { return Record(stationRoot, error.Message); }
        finally { SetupLock.Release(); }
    }
}

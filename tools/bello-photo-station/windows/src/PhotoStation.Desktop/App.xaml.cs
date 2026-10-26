using System.IO;
using System.Windows;
using PhotoStation.Infrastructure;

namespace PhotoStation.Desktop;

public partial class App : System.Windows.Application
{
    private SingleInstanceGuard? _guard;
    internal static bool IsTestMode { get; private set; }
    internal static bool IsTouchMode { get; private set; }
    internal static Task<string>? LightroomStartup { get; private set; }
    protected override void OnStartup(StartupEventArgs e)
    {
        // Headless child process: no SD scan, Lightroom, UI, history or login access.
        if (e.Args.Contains("--sign-device-request")) { Shutdown(DeviceRequestSigner.Run()); return; }
        Environment.SetEnvironmentVariable("BELLO_DEVICE_SIGNER_EXE", Environment.ProcessPath);
        // Distribution smoke checks must not restore the operator's real login,
        // scan SD cards, or run retention against their existing photo history.
        if (e.Args.Contains("--installation-check"))
        {
            Environment.SetEnvironmentVariable("BELLO_PHOTO_STATION_ROOT",
                Path.Combine(Path.GetTempPath(), "BELLO-PhotoStation-InstallationCheck", Guid.NewGuid().ToString("N")));
            Environment.SetEnvironmentVariable("BELLO_PHOTO_STATION_TOKEN", null);
        }
        IsTouchMode = e.Args.Contains("--touch-mode");
        IsTestMode = e.Args.Contains("--test-mode") || IsTouchMode;
        if (IsTouchMode) Resources.MergedDictionaries.Add(new ResourceDictionary { Source = new Uri("TouchStyles.xaml", UriKind.Relative) });
        if (IsTestMode && !e.Args.Contains("--installation-check"))
        {
            Environment.SetEnvironmentVariable("BELLO_PHOTO_STATION_ROOT", Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "data")));
            Environment.SetEnvironmentVariable("BELLO_PHOTO_STATION_TOKEN", null);
            var bridgeConfig = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "Adobe", "Lightroom", "Modules", "BelloPhotoStation.lrplugin", "root.txt");
            try {
                if (File.Exists(bridgeConfig)) {
                    var serviceRoot = File.ReadAllText(bridgeConfig).Trim();
                    if (Path.IsPathFullyQualified(serviceRoot) && Directory.Exists(serviceRoot))
                        Environment.SetEnvironmentVariable("BELLO_LIGHTROOM_BRIDGE_ROOT", serviceRoot);
                }
            } catch (IOException) { /* The renderer will report unavailable linkage. */ }
        }
        try { _guard = new SingleInstanceGuard(IsTestMode ? "desktop-test" : "staging"); }
        catch (InvalidOperationException error)
        {
            MessageBox.Show(error.Message, "BELLO Photo Station", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown(2); return;
        }
        // The portable EXE carries its own Node pipeline. Set process-local
        // defaults before MainWindow constructs MainViewModel.
        var root = AppContext.BaseDirectory;
        if (File.Exists(Path.Combine(root, "pipeline", "src", "validationLogin.mjs")))
        {
            Environment.SetEnvironmentVariable("BELLO_PHOTO_STATION_NODE_DIR", Path.Combine(root, "pipeline"));
            Environment.SetEnvironmentVariable("BELLO_PHOTO_STATION_NODE_EXE", Path.Combine(root, "node.exe"));
            if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("BELLO_PHOTO_STATION_API_ENDPOINT")))
                Environment.SetEnvironmentVariable("BELLO_PHOTO_STATION_API_ENDPOINT", "https://dq30ujzf5d.execute-api.us-west-2.amazonaws.com/");
        }
        if (!e.Args.Contains("--installation-check")) {
            Environment.SetEnvironmentVariable("BELLO_LIGHTROOM_WAIT_FOR_START", "1");
            var stationRoot = Environment.GetEnvironmentVariable("BELLO_PHOTO_STATION_ROOT")
                ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BELLO", "PhotoStation", "staging");
            LightroomStartup = LightroomConnection.ConfigureAndConnectAsync(stationRoot);
        }
        // Startup handlers must also see the bundled connection/runtime defaults.
        // A new PC has no developer environment variables to fall back to.
        base.OnStartup(e);
    }
    protected override void OnExit(ExitEventArgs e) { _guard?.Dispose(); base.OnExit(e); }
}

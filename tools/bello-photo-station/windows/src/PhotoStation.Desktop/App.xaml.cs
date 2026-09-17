using System.Windows;
using PhotoStation.Infrastructure;

namespace PhotoStation.Desktop;

public partial class App : System.Windows.Application
{
    private SingleInstanceGuard? _guard;
    protected override void OnStartup(StartupEventArgs e)
    {
        try { _guard = new SingleInstanceGuard("staging"); }
        catch (InvalidOperationException error)
        {
            MessageBox.Show(error.Message, "BELLO Photo Station", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown(2); return;
        }
        base.OnStartup(e);
    }
    protected override void OnExit(ExitEventArgs e) { _guard?.Dispose(); base.OnExit(e); }
}

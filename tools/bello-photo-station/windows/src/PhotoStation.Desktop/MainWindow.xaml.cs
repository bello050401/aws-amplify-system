using System.Windows;
namespace PhotoStation.Desktop;
public partial class MainWindow : Window
{
    public MainWindow() { InitializeComponent(); DataContext = new MainViewModel(); Loaded += async (_, _) => await ((MainViewModel)DataContext).InitializeAsync(); }

    private void OpenSettings_Click(object sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel viewModel) return;
        var settingsViewModel = new SettingsViewModel(viewModel.SettingsStore, viewModel.CreatePreviewRunner(), viewModel.PreviewOutputDir);
        new SettingsWindow(settingsViewModel) { Owner = this }.ShowDialog();
    }
}

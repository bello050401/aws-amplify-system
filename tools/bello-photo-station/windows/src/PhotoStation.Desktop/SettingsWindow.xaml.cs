using System.Windows;
namespace PhotoStation.Desktop;
public partial class SettingsWindow : Window
{
    public SettingsWindow(SettingsViewModel viewModel)
    {
        InitializeComponent();
        DataContext = viewModel;
        Loaded += async (_, _) => await viewModel.InitializeAsync();
    }

    private void BrowseTestImage_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new Microsoft.Win32.OpenFileDialog { Filter = "JPEG画像 (*.jpg;*.jpeg)|*.jpg;*.jpeg" };
        if (dialog.ShowDialog(this) == true && DataContext is SettingsViewModel viewModel) viewModel.TestImagePath = dialog.FileName;
    }
}

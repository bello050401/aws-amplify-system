using System.Windows;
using System.Windows.Controls;

namespace PhotoStation.Desktop;

/// <summary>First sign-in for the isolated validation environment.</summary>
public sealed class ValidationLoginWindow : Window
{
    private readonly PasswordBox _password = new();
    private readonly TextBox _username = new() { Text = "photo-device-e2e" };
    private readonly TextBlock _passwordLabel = new() { Text = "パスワード" };
    private ValidationSession.LoginResult? _challenge;
    private readonly TextBlock _status = new() { TextWrapping = TextWrapping.Wrap };
    private readonly Button _signIn = new() { Content = "ログインして開始", IsDefault = true, Padding = new Thickness(16, 9, 16, 9) };

    public ValidationLoginWindow()
    {
        Title = "BELLO Photo Station にログイン";
        Width = 480; SizeToContent = SizeToContent.Height; MinWidth = 420; ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ShowInTaskbar = false;
        var layout = new StackPanel { Margin = new Thickness(24) };
        layout.Children.Add(new TextBlock { Text = "BELLO WEBへ保存", FontSize = 21, FontWeight = FontWeights.Bold });
        layout.Children.Add(new TextBlock { Text = "写真用アカウントでログインしてください。社外のPCからも利用できます。パスワードは保存せず、次回の認証情報はこのWindowsユーザー用に暗号化します。", TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 10, 0, 16) });
        layout.Children.Add(new TextBlock { Text = "ユーザー名（写真用アカウント）" });
        _username.Margin = new Thickness(0, 5, 0, 12);
        layout.Children.Add(_username);
        layout.Children.Add(_passwordLabel);
        _password.Margin = new Thickness(0, 5, 0, 12);
        layout.Children.Add(_password);
        _status.Margin = new Thickness(0, 0, 0, 12);
        layout.Children.Add(_status);
        _signIn.HorizontalAlignment = HorizontalAlignment.Right;
        _signIn.Click += async (_, _) => await SignInAsync();
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        var cancel = new Button { Content = "キャンセル", IsCancel = true, Margin = new Thickness(0, 0, 10, 0), Padding = new Thickness(16, 9, 16, 9) };
        buttons.Children.Add(cancel); buttons.Children.Add(_signIn); layout.Children.Add(buttons);
        Content = layout;
        Loaded += (_, _) => _password.Focus();
    }

    private async Task SignInAsync()
    {
        var password = _password.Password;
        _password.Clear();
        if (string.IsNullOrEmpty(password)) { _status.Text = "パスワードを入力してください。"; return; }
        _signIn.IsEnabled = false;
        _username.IsEnabled = false;
        _status.Text = "BELLO WEBに接続しています…";
        try
        {
            _challenge = await ValidationSession.SignInAsync(_username.Text, password, _challenge);
            password = string.Empty;
            if (_challenge is not null)
            {
                _passwordLabel.Text = _challenge.ChallengeName == "NEW_PASSWORD_REQUIRED" ? "新しいパスワード" : "確認コード";
                _status.Text = _challenge.ChallengeName == "NEW_PASSWORD_REQUIRED" ? "英大文字・小文字・数字・記号を含む16文字以上のパスワードを設定してください。" : "届いた確認コード、または認証アプリのコードを入力してください。";
                _password.Focus(); return;
            }
            DialogResult = true;
        }
        catch (Exception error)
        {
            _status.Text = error.Message;
        }
        finally { password = string.Empty; _signIn.IsEnabled = true; _username.IsEnabled = _challenge is null; }
    }
}

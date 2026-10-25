using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PhotoStation.Application;

namespace PhotoStation.Desktop;

/// <summary>Persist only Cognito's refresh token, encrypted for the current Windows user.</summary>
internal static class ValidationSession
{
    private static string StorePath => Path.Combine(Environment.GetEnvironmentVariable("BELLO_PHOTO_STATION_ROOT")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BELLO", "PhotoStation", "staging"), "validation-refresh.dpapi");
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("BELLO Photo Station isolated validation v1");

    internal static async Task<bool> TryRestoreAsync()
    {
        if (PhotoEndpointSafety.HasUsableValidationToken(Environment.GetEnvironmentVariable("BELLO_PHOTO_STATION_TOKEN"), DateTimeOffset.UtcNow))
            return true;
        if (!File.Exists(StorePath)) return false;
        try
        {
            var encrypted = await File.ReadAllBytesAsync(StorePath);
            var refresh = Encoding.UTF8.GetString(ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.CurrentUser));
            var session = await ExchangeAsync(refresh, refreshOnly: true);
            Accept(session);
            return true;
        }
        catch
        {
            // AWS sign-in may be temporarily unavailable. Keep the encrypted
            // refresh token so the next launch can retry without data loss.
            return false;
        }
    }

    internal sealed record LoginResult(string? IdToken, string? RefreshToken, string? ChallengeName, string? Session, string? Username);

    internal static async Task<LoginResult?> SignInAsync(string username, string password, LoginResult? challenge = null)
    {
        var input = challenge is null ? JsonSerializer.Serialize(new { username, password })
            : JsonSerializer.Serialize(new { username = challenge.Username, challengeName = challenge.ChallengeName, session = challenge.Session, answer = password });
        var session = await ExchangeAsync(input, refreshOnly: false);
        if (session.ChallengeName is not null) return session;
        Accept(session);
        return null;
    }

    private static void Accept(LoginResult session)
    {
        if (!PhotoEndpointSafety.HasUsableValidationToken(session.IdToken, DateTimeOffset.UtcNow) || string.IsNullOrEmpty(session.RefreshToken))
            throw new InvalidOperationException("BELLO WEBの認証を保存できませんでした。");
        var bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(session.RefreshToken), Entropy, DataProtectionScope.CurrentUser);
        Directory.CreateDirectory(Path.GetDirectoryName(StorePath)!);
        var temporary = StorePath + ".tmp";
        File.WriteAllBytes(temporary, bytes);
        File.Move(temporary, StorePath, overwrite: true);
        Environment.SetEnvironmentVariable("BELLO_PHOTO_STATION_TOKEN", session.IdToken);
    }

    internal static string DeviceId()
    {
        var token = Environment.GetEnvironmentVariable("BELLO_PHOTO_STATION_TOKEN") ?? "";
        if (!PhotoEndpointSafety.HasUsableValidationToken(token, DateTimeOffset.UtcNow)) throw new InvalidOperationException("ログインしてください");
        var payload = token.Split('.')[1].Replace('-', '+').Replace('_', '/');
        using var json = JsonDocument.Parse(Convert.FromBase64String(payload.PadRight((payload.Length + 3) / 4 * 4, '=')));
        return json.RootElement.TryGetProperty("custom:deviceId", out var device) && !string.IsNullOrWhiteSpace(device.GetString())
            ? device.GetString()! : throw new InvalidOperationException("写真用アカウントに端末IDが登録されていません。管理者に確認してください。");
    }

    internal static void SignOut()
    {
        Environment.SetEnvironmentVariable("BELLO_PHOTO_STATION_TOKEN", null);
        if (File.Exists(StorePath)) File.Delete(StorePath);
    }

    private static async Task<LoginResult> ExchangeAsync(string secret, bool refreshOnly)
    {
        var root = AppContext.BaseDirectory;
        var start = new ProcessStartInfo(Path.Combine(root, "node.exe"))
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        start.ArgumentList.Add(Path.Combine(root, "pipeline", "src", "validationLogin.mjs"));
        start.ArgumentList.Add(refreshOnly ? "--refresh" : "--session");
        using var process = Process.Start(start) ?? throw new InvalidOperationException("ログイン処理を起動できません。");
        await process.StandardInput.WriteAsync(secret);
        process.StandardInput.Close();
        var resultTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException) { if (!process.HasExited) process.Kill(entireProcessTree: true); throw; }
        var result = await resultTask;
        _ = await errorTask; // Never display SDK diagnostics or secrets.
        if (process.ExitCode != 0)
        {
            string? code = null;
            try { using var failure = JsonDocument.Parse(result); if (failure.RootElement.TryGetProperty("errorCode", out var errorCode)) code = errorCode.GetString(); }
            catch (JsonException) { }
            throw new InvalidOperationException(code switch {
                "INVALID_CREDENTIALS" => "ユーザー名またはパスワードが違います。写真用アカウント photo-device-e2e の情報を入力してください。WEB在庫管理のログインとは別です。パスワードの全角・半角も確認してください。",
                "ACCOUNT_NOT_CONFIRMED" => "写真用アカウントの確認が完了していません。管理者に確認してください。",
                "PASSWORD_RESET_REQUIRED" => "写真用アカウントのパスワード更新が必要です。管理者に確認してください。",
                "TOO_MANY_REQUESTS" => "ログインが集中しています。少し待ってから再実行してください。",
                "NETWORK_ERROR" => "ログイン先に接続できません。インターネット接続とPCの日付・時刻を確認してください。",
                "PHOTO_PERMISSION_REQUIRED" => "このアカウントには写真保存の権限がありません。写真用アカウントでログインしてください。",
                _ => "BELLO WEBにログインできませんでした。写真用アカウント・インターネット接続を確認してください。"
            });
        }
        return JsonSerializer.Deserialize<LoginResult>(result, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidOperationException("認証結果を読み取れませんでした");
    }
}

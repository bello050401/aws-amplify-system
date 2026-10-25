using System.Diagnostics;
using Microsoft.Win32;

namespace PhotoStation.Infrastructure;

public sealed class LightroomLauncher(Func<bool> isRunning, Func<string?> findExecutable, Action<string> start)
{
    public string EnsureStarted()
    {
        try
        {
            if (isRunning()) return "Lightroom Classic は起動しています";
            var executable = findExecutable();
            if (executable is null) return "Lightroom Classic が見つかりません。インストール先を確認してください";
            // Recheck after discovery: another startup may already have launched it.
            if (!isRunning()) start(executable);
            return "Lightroom Classic を起動しました";
        }
        catch { return "Lightroom Classic を起動できませんでした。手動で起動してから再実行できます"; }
    }

    public static LightroomLauncher Installed() => new(
        () => {
            var processes = Process.GetProcessesByName("Lightroom");
            try { return processes.Length > 0; }
            finally { foreach (var process in processes) process.Dispose(); }
        }, FindInstalled,
        executable => { using var process = Process.Start(new ProcessStartInfo(executable) { UseShellExecute = true });
            if (process is null) throw new InvalidOperationException("Lightroom could not start"); });

    private static string? FindInstalled()
    {
        if (!OperatingSystem.IsWindows()) return null;
        foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            using var root = RegistryKey.OpenBaseKey(hive, view);
            using var key = root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Lightroom.exe");
            var candidate = (key?.GetValue(null) as string)?.Trim('"');
            if (candidate is not null && Path.IsPathFullyQualified(candidate) && File.Exists(candidate)) return candidate;
        }
        foreach (var folder in new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86 })
        {
            var candidate = Path.Combine(Environment.GetFolderPath(folder), "Adobe", "Adobe Lightroom Classic", "Lightroom.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }
}

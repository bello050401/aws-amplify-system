using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace PhotoStation.Infrastructure;

public static class CardIdentity
{
    public static string Read(DriveInfo drive)
    {
        if (!GetVolumeInformationW(drive.RootDirectory.FullName, null, 0, out var serial, out _, out _, null, 0))
            throw new IOException("SDカードの識別情報を取得できません", new Win32Exception(Marshal.GetLastWin32Error()));
        return FromVolume(serial, drive.TotalSize, drive.DriveFormat);
    }

    // Drive letters and volume labels can change; neither identifies a card.
    public static string FromVolume(uint serial, long size, string format) => Hash($"card-v2\0{serial:X8}\0{size}\0{format}");
    public static string Legacy(DriveInfo drive) => Hash($"{drive.VolumeLabel}\0{drive.TotalSize}\0{drive.DriveFormat}");
    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVolumeInformationW(string root, StringBuilder? label, uint labelSize,
        out uint serial, out uint maximumComponentLength, out uint flags, StringBuilder? format, uint formatSize);
}

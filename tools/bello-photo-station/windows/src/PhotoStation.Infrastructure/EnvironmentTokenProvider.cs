using PhotoStation.Application;

namespace PhotoStation.Infrastructure;

/// <summary>
/// 固定のAWSアクセスキー等をコードへ埋め込まず、環境変数からのみ短期トークンを
/// 取得する(tools/bello-photo-station/README.mdの方針と同じ)。
/// </summary>
public sealed class EnvironmentTokenProvider(string variableName = "BELLO_PHOTO_STATION_TOKEN") : ITokenProvider
{
    public string? GetToken() => Environment.GetEnvironmentVariable(variableName);
}

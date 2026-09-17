namespace PhotoStation.Domain;

/// <summary>
/// 端末ローカルの画像編集設定。プロパティ名・既定値は
/// tools/bello-photo-station/src/settings.mjs の DEFAULT_SETTINGS と1:1で揃えている
/// (JSONへはcamelCaseで書き出す想定 — EditSettingsStore参照)。既定値をコンストラクタ
/// 引数の既定値として持たせているのは「初期編集設定」節の固定値をこの型自体が表す
/// ようにするため。
/// </summary>
public sealed record EditSettings(
    bool KeepAspectRatio = true,
    bool AutoCrop = false,
    string CropMethod = "none",
    bool AutoRotate = true,
    string ColorSpace = "srgb",
    string OutputFormat = "jpeg",
    int LongEdgePx = 3000,
    int JpegQuality = 90,
    int ThumbnailLongEdgePx = 480,
    int ThumbnailJpegQuality = 80,
    bool StripMetadata = true,
    double Brightness = 0,
    double Contrast = 0,
    double ColorTemperatureShift = 0,
    double Saturation = 0,
    double Sharpness = 0,
    string? LightroomPresetName = null)
{
    public static readonly EditSettings Default = new();
}

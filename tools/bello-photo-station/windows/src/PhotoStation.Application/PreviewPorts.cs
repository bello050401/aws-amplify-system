using PhotoStation.Domain;

namespace PhotoStation.Application;

public sealed record PreviewResult(string SourcePath, string ProcessedPath, string ThumbnailPath, int ProcessedWidth, int ProcessedHeight);

/// <summary>
/// 設定画面の「テスト画像1枚によるプレビュー」「適用前後の比較」を1枚だけ実行する。
/// 保存前の編集中設定でも試せるよう、settingsはファイル経由ではなく引数でそのまま渡す。
/// </summary>
public interface IPreviewRunner
{
    Task<PreviewResult> RunAsync(string sourceImagePath, EditSettings settings, string outputDir, CancellationToken cancellationToken = default);
}

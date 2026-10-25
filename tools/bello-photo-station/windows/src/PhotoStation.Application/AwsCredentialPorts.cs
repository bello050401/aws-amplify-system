namespace PhotoStation.Application;

public sealed record AwsTemporaryCredentials(string AccessKeyId, string SecretAccessKey, string? SessionToken, DateTimeOffset? ExpirationUtc);

/// <summary>
/// ローカルのAWS CLIプロファイル(既定 "Bello")が解決した短期クレデンシャルを
/// 取得する窓口。SSOやスイッチロールの解決自体はAWS CLI側に任せ、ここでは
/// 結果のアクセスキーだけを受け取る。Cognitoの検証用ユーザーパスワードとは
/// 完全に別物で、このインターフェースにパスワードが渡ることはない。
/// </summary>
public interface IAwsCredentialExporter
{
    Task<AwsTemporaryCredentials> ExportAsync(string profile, CancellationToken cancellationToken = default);
}

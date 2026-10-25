using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace PhotoStation.Infrastructure;

internal readonly record struct Sigv4Headers(string Authorization, string AmzDate);

/// <summary>
/// AWS Signature Version 4 の最小実装。クエリ文字列を持たず、単一のJSON本文と
/// 固定ヘッダー集合(content-type / host / x-amz-date / x-amz-target(/x-amz-security-token))
/// だけを署名すればよい cognito-idp の AdminInitiateAuth 呼び出し1本に絞っている。
/// </summary>
internal static class Sigv4Signer
{
    public static Sigv4Headers Sign(
        string method, string host, string canonicalUri, string payload,
        string accessKeyId, string secretAccessKey, string? sessionToken,
        string region, string service, string amzTarget, DateTimeOffset now)
    {
        var amzDate = now.ToString("yyyyMMddTHHmmssZ", CultureInfo.InvariantCulture);
        var dateStamp = now.ToString("yyyyMMdd", CultureInfo.InvariantCulture);
        var payloadHash = Sha256Hex(payload);

        var headers = new SortedDictionary<string, string>(StringComparer.Ordinal)
        {
            ["content-type"] = "application/x-amz-json-1.1",
            ["host"] = host,
            ["x-amz-date"] = amzDate,
            ["x-amz-target"] = amzTarget,
        };
        if (!string.IsNullOrEmpty(sessionToken)) headers["x-amz-security-token"] = sessionToken;

        var canonicalHeaders = string.Concat(headers.Select(kv => $"{kv.Key}:{kv.Value}\n"));
        var signedHeaderNames = string.Join(';', headers.Keys);
        var canonicalRequest = string.Join('\n', method, canonicalUri, "", canonicalHeaders, signedHeaderNames, payloadHash);

        var credentialScope = $"{dateStamp}/{region}/{service}/aws4_request";
        var stringToSign = string.Join('\n', "AWS4-HMAC-SHA256", amzDate, credentialScope, Sha256Hex(canonicalRequest));

        var signingKey = DeriveSigningKey(secretAccessKey, dateStamp, region, service);
        var signature = Convert.ToHexString(HmacSha256(signingKey, stringToSign)).ToLowerInvariant();

        var authorization = $"AWS4-HMAC-SHA256 Credential={accessKeyId}/{credentialScope}, SignedHeaders={signedHeaderNames}, Signature={signature}";
        return new Sigv4Headers(authorization, amzDate);
    }

    public static byte[] DeriveSigningKey(string secretAccessKey, string dateStamp, string region, string service)
    {
        var kDate = HmacSha256(Encoding.UTF8.GetBytes("AWS4" + secretAccessKey), dateStamp);
        var kRegion = HmacSha256(kDate, region);
        var kService = HmacSha256(kRegion, service);
        return HmacSha256(kService, "aws4_request");
    }

    public static byte[] HmacSha256(byte[] key, string data) => new HMACSHA256(key).ComputeHash(Encoding.UTF8.GetBytes(data));

    public static string Sha256Hex(string data) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(data))).ToLowerInvariant();
}

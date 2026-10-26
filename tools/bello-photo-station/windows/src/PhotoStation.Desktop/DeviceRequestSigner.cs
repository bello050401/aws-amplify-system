using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PhotoStation.Desktop;

/// <summary>Windows CNG key: per Windows user, persistent and not exportable.</summary>
internal static class DeviceRequestSigner
{
    private const string KeyName = "BELLO-PhotoStation-Device-v1";
    private static string Base64Url(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    public static int Run()
    {
        try
        {
            var input = Console.In.ReadToEnd();
            if (input.Length > 8192) return 2;
            var request = JsonDocument.Parse(input);
            var message = request.RootElement.GetProperty("message").GetString();
            if (string.IsNullOrEmpty(message) || message.Length > 4096 || !message.StartsWith("BELLO-HTTP-PROOF-v1\n")) return 2;
            var provider = CngProvider.MicrosoftSoftwareKeyStorageProvider;
            if (!CngKey.Exists(KeyName, provider))
            {
                using var created = CngKey.Create(CngAlgorithm.ECDsaP256, KeyName, new CngKeyCreationParameters
                {
                    Provider = provider, ExportPolicy = CngExportPolicies.None, KeyUsage = CngKeyUsages.Signing
                });
            }
            using var key = CngKey.Open(KeyName, provider);
            using var signer = new ECDsaCng(key);
            var parameters = signer.ExportParameters(false);
            var signature = signer.SignData(Encoding.UTF8.GetBytes(message), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
            Console.Write(JsonSerializer.Serialize(new
            {
                key = new { kty = "EC", crv = "P-256", x = Base64Url(parameters.Q.X!), y = Base64Url(parameters.Q.Y!) },
                signature = Base64Url(signature), exportPolicy = key.ExportPolicy.ToString()
            }));
            return 0;
        }
        catch { Console.Error.WriteLine("DEVICE_SIGNATURE_FAILED"); return 1; }
    }
}

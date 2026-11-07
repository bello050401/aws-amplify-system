import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

/** Use only globally routable IPv4, including after every redirect. */
export function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export function publicResearchUrl(raw: string): boolean {
  try {
    const u = new URL(raw),
      h = u.hostname.toLowerCase();
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === "443") &&
      !h.startsWith("[") &&
      h.includes(".") &&
      !/\.(?:local|internal|localhost)\.?$/.test(h) &&
      (isIP(h) === 0 || publicIPv4(h))
    );
  } catch {
    return false;
  }
}
export async function safeResearchGet(
  raw: string,
  maxBytes = 1_500_000,
  timeoutMs = 10_000,
): Promise<{ url: string; text: string } | null> {
  const deadline = Date.now() + timeoutMs;
  let url = raw;
  for (let redirect = 0; redirect <= 3; redirect++) {
    if (!publicResearchUrl(url)) return null;
    const u = new URL(url),
      remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    let dnsTimer: ReturnType<typeof setTimeout> | undefined;
    const addresses = await Promise.race([
      lookup(u.hostname, { all: true, family: 4 }),
      new Promise<never>((_, reject) => {
        dnsTimer = setTimeout(() => reject(Error("DNS_TIMEOUT")), remaining);
      }),
    ]).finally(() => clearTimeout(dnsTimer));
    if (!addresses.length || addresses.some((a) => !publicIPv4(a.address)))
      return null;
    const response = await new Promise<{
      location?: string;
      text?: string;
    } | null>((resolve, reject) => {
      // DNS is validated once then pinned for this request. TLS verifies the hostname.
      const req = request(
        u,
        {
          method: "GET",
          headers: {
            "user-agent": "BELLO-InquiryResearch/2.0",
            "accept-encoding": "identity",
          },
          lookup: (_host, _opts, cb) => cb(null, addresses[0].address, 4),
        },
        (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
            res.resume();
            resolve({ location: res.headers.location });
            return;
          }
          if (
            res.statusCode !== 200 ||
            !/text\/html|text\/plain|application\/xhtml/.test(
              res.headers["content-type"] ?? "",
            ) ||
            Number(res.headers["content-length"] ?? 0) > maxBytes
          ) {
            res.destroy();
            resolve(null);
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          res.on("data", (data: Buffer) => {
            size += data.length;
            if (size > maxBytes) {
              res.destroy();
              reject(Error("PAGE_TOO_LARGE"));
            } else chunks.push(data);
          });
          res.on("end", () =>
            resolve({ text: Buffer.concat(chunks).toString("utf8") }),
          );
          res.on("error", reject);
        },
      );
      const timer = setTimeout(
        () => req.destroy(Error("PAGE_TIMEOUT")),
        Math.max(1, deadline - Date.now()),
      );
      req.on("close", () => clearTimeout(timer));
      req.on("error", reject);
      req.end();
    });
    if (!response) return null;
    if (response.location) {
      url = new URL(response.location, url).href;
      continue;
    }
    return response.text === undefined ? null : { url, text: response.text };
  }
  return null;
}

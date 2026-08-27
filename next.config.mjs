/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // BASE serves item images from more than one Akamai-fronted host —
    // confirmed via a real /1/items response returning base-ec2.akamaized.net
    // (see extractImageUrls in lib/base/client.real.ts and
    // docs/NOTES_BASE_API.md), while the public shop page itself references
    // baseec-img-mng.akamaized.net. Both are allowed rather than guessing
    // which one a given account/region gets.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "baseec-img-mng.akamaized.net",
      },
      {
        protocol: "https",
        hostname: "base-ec2.akamaized.net",
      },
    ],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // BASE product image CDN. Add more hosts here if BASE returns other domains
    // (e.g. a signed/regional CDN host) once confirmed against the live API.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "baseec-img-mng.akamaized.net",
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

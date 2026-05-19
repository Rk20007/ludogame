/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep server bundles compatible with mixed CJS/ESM deps (e.g. Mongoose + legacy models)
  transpilePackages: [],
};

export default nextConfig;

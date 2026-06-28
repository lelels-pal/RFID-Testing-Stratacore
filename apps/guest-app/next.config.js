/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: {
    optimizePackageImports: ['qrcode.react'],
  },
};

module.exports = nextConfig;

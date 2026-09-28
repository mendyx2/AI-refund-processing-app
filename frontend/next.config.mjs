/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Customers land straight in the help center; staff use /admin.
  async redirects() {
    return [{ source: "/", destination: "/support", permanent: false }];
  },
};

export default nextConfig;

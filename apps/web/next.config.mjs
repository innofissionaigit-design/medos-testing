/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Standalone output is for the Docker image (set NEXT_OUTPUT=standalone); it needs symlinks, which plain Windows disallows.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone", outputFileTracingRoot: new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") } : {}),
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The patient app's service worker is stored under /patient/ but covers the /patient page itself; it is never cached, so an update reaches phones at once.
      { source: "/patient/sw.js", headers: [{ key: "Service-Worker-Allowed", value: "/patient" }, { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] },
    ];
  },
};
export default nextConfig;

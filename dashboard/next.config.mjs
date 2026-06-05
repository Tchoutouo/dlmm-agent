/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 est un module natif : il doit rester externe au bundle serveur.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;

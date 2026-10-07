import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin Turbopack to this folder. Without it, any lockfile in a parent folder
  // makes Turbopack watch and cache the whole nexuscommerce/ tree (backend,
  // ML models, multi-MB datasets), which is slow and memory hungry.
  turbopack: { root: projectRoot },
};

export default nextConfig;

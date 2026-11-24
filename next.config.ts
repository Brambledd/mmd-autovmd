import type { NextConfig } from "next"

/** @type {import('next').NextConfig} */
const nextConfig: NextConfig = {
  reactStrictMode: false,
  devIndicators: false,
  // mmd-mpl 的 wasm 必须以真实 node_modules 文件形式存在（server-compile.ts 按
  // import.meta.url 定位 mmd_mpl_bg.wasm 读取字节），不能被打包器内联
  serverExternalPackages: ["mmd-mpl"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "lxbvoqdvdbhmufga.public.blob.vercel-storage.com",
        port: "",
        pathname: "/**",
      },
    ],
  },
}

module.exports = nextConfig

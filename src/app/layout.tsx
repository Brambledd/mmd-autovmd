import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import "./globals.css"
import Header from "@/components/header"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "MMD Pose Studio",
  description:
    "Generate MMD poses and facial morphs directly from natural language. LLM for MikuMikuDance pose generation.",
  keywords: ["MMD", "MikuMikuDance", "AI pose", "text to pose", "ai companion", "waifu", "pose generation"],
  openGraph: {
    title: "MMD Pose Studio",
    description: "Generate MMD poses directly from natural language. LLM for MikuMikuDance pose generation.",
    url: "http://localhost:4000",
    siteName: "MMD Pose Studio",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "MMD Pose Studio",
    description: "Generate MMD poses directly from natural language. LLM for MikuMikuDance pose generation.",
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

/**
 * Embedded stage (`?embed=1`, used by the DSH sidebar plugin): flag the document before
 * hydration so `globals.css` can hide the site chrome without a flash. Mirrors
 * `readStageParams` in `src/lib/stage-params.ts`.
 */
const EMBED_FLAG_SCRIPT = `try{if(new URLSearchParams(location.search).get("embed")==="1"){document.documentElement.classList.add("popo-embed")}}catch(e){}`

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="select-none outline-none" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#0f172a]`}>
        <script dangerouslySetInnerHTML={{ __html: EMBED_FLAG_SCRIPT }} />
        <Header />
        {children}
      </body>
    </html>
  )
}

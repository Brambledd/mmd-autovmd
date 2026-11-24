"use client"

import dynamic from "next/dynamic"

const PlaygroundScene = dynamic(() => import("@/components/playground-scene"), {
    ssr: false,
})

export default function Home() {
    // Support ?mpl=<urlencoded MPL> so external tools (e.g. DSH chat) can deep-link a pose
    let initialMpl: string | null = null
    if (typeof window !== "undefined") {
        const params = new URLSearchParams(window.location.search)
        const mpl = params.get("mpl")
        if (mpl) initialMpl = mpl
    }

    const pose = initialMpl
        ? { id: 0, name: "shared", preview_url: "", uid: "", mpl: initialMpl, author: "", created_at: "" }
        : null

    return (
        <div className="w-full h-screen">
            <PlaygroundScene pose={pose} />
        </div>
    )
}

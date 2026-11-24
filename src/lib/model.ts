/**
 * Active model registry — single source of truth for which PMX the scenes
 * load, plus a cached skeleton used by the pose auditor and the per-model
 * prompt conditioning (Phase 2).
 */

import { loadPmxBones } from "./pmx-bones.ts"
import type { PmxBones } from "./pmx-bones.ts"

export interface ModelOption {
  id: string
  label: string
  url: string
}

export const AVAILABLE_MODELS: ModelOption[] = [
  { id: "topaz", label: "Topaz", url: "/models/topaz/topaz.pmx" },
  { id: "caelus", label: "星穹铁道-男主", url: "/models/caelus/男主1.0.pmx" },
]

export const MODEL_URL = AVAILABLE_MODELS[0].url

const cache = new Map<string, Promise<PmxBones | null>>()

/**
 * Parsed bones of the active model, fetched once per model URL per session.
 * Resolves null when the model cannot be loaded/parsed — callers must treat
 * auditing and conditioning as optional polish, never a hard dependency.
 */
export function getActiveModelBones(modelUrl: string = MODEL_URL): Promise<PmxBones | null> {
  let pending = cache.get(modelUrl)
  if (!pending) {
    pending = loadPmxBones(modelUrl).catch(() => null)
    cache.set(modelUrl, pending)
  }
  return pending
}

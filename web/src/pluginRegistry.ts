import { useEffect, useState } from 'react'
import { api, type Plugin, type PluginContribution } from './api'

/** A plug-in contribution resolved to the plug-in that declared it. This is how
 * the core renders plug-in UI into its "slots" (left-bar panels, track menus,
 * etc.) without ever naming a specific plug-in. */
export interface ResolvedContribution extends PluginContribution {
  plugin: Plugin
}

// Process-wide cache so every consumer shares one /api/plugins fetch and stays
// in sync. Plug-ins change rarely (install/bootstrap), so this is plenty.
let cache: Plugin[] | null = null
let inflight: Promise<Plugin[]> | null = null
const listeners = new Set<(p: Plugin[]) => void>()

export async function loadPlugins(force = false): Promise<Plugin[]> {
  if (cache && !force) return cache
  if (inflight && !force) return inflight
  inflight = api
    .plugins()
    .then(({ plugins }) => {
      cache = plugins
      inflight = null
      listeners.forEach((l) => l(plugins))
      return plugins
    })
    .catch((e) => {
      inflight = null
      throw e
    })
  return inflight
}

/** Reactive list of discovered plug-ins (shared cache). */
export function usePlugins(): Plugin[] {
  const [plugins, setPlugins] = useState<Plugin[]>(cache ?? [])
  useEffect(() => {
    listeners.add(setPlugins)
    loadPlugins().catch(() => {})
    return () => {
      listeners.delete(setPlugins)
    }
  }, [])
  return plugins
}

/** All installed-plug-in contributions registered for a given slot. */
export function contributionsFor(plugins: Plugin[], slot: string): ResolvedContribution[] {
  const out: ResolvedContribution[] = []
  for (const p of plugins) {
    if (!p.installed) continue
    for (const c of p.ui?.contributions ?? []) {
      if (c.slot === slot) out.push({ ...c, plugin: p })
    }
  }
  return out
}

/** Reactive contributions for a slot (re-renders when plug-ins (re)load). */
export function useContributions(slot: string): ResolvedContribution[] {
  const plugins = usePlugins()
  return contributionsFor(plugins, slot)
}

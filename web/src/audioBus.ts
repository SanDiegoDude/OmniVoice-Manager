// Global "one player at a time" coordinator. Every playback source (AudioPlayer
// components, segment solo previews, voice-library previews, raw <audio> tags)
// claims the bus right before it starts; the bus stops whoever held it last.
// The most recent click always wins.
let current: { owner: symbol; stop: () => void } | null = null

export function claimPlayback(owner: symbol, stop: () => void): void {
  if (current && current.owner !== owner) {
    try {
      current.stop()
    } catch {
      // a stale stopper (unmounted component) must never block the new player
    }
  }
  current = { owner, stop }
}

export function releasePlayback(owner: symbol): void {
  if (current?.owner === owner) current = null
}

export type DecisionKind = 'decide' | 'confirm' | 'info'

// How an item left the list: the user took the recommendation, gave another
// answer or handed it back; the assistant withdrew it; or the user removed it.
export type ResolutionBy = 'accepted' | 'answered' | 'delegated' | 'withdrawn' | 'manual'

export type Resolution = {
  by: ResolutionBy
  // What the user chose, for `answered`.
  answer?: string
}

export type Decision = {
  id: string
  // Raised order; restoring a removed item puts it back in place.
  seq: number
  title: string
  kind: DecisionKind
  recommendation?: string
  // Set while the item sits in `removed`.
  resolution?: Resolution
}

export type Board = {
  // The session this board belongs to; '' before one is loaded.
  sessionId: string
  items: Decision[]
  // Newest first, at most REMOVED_KEPT.
  removed: Decision[]
  nextSeq: number
}

declare module 'claude-code' {
  interface PluginState {
    'pending-decisions': { board: Board; showRemoved: boolean }
  }
}

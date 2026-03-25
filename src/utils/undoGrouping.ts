/**
 * UndoGroupTracker — manages time-based grouping of text edits for undo.
 *
 * Text edits within a 1000ms window on the same node are grouped under one
 * group_key. A Cmd+Z will undo the entire group as a single operation.
 *
 * Usage:
 *   const tracker = new UndoGroupTracker()
 *   // On each keystroke:
 *   if (tracker.shouldStartNewGroup(nodeId, Date.now())) {
 *     const prev = tracker.flush()
 *     if (prev) await recordUndoStepIpc('text_edit', nodeId, prev.startSnapshot, current, prev.groupKey)
 *     tracker.startGroup(nodeId, currentSnapshot)
 *   }
 */
export class UndoGroupTracker {
  private undoGroupKey: string | null = null
  private undoGroupStartSnapshot: object | null = null
  private lastEditTimestamp: number = 0
  private lastEditNodeId: string | null = null

  /**
   * Returns true if a new undo group should start.
   * Triggers when: >1000ms gap since last edit, OR nodeId changed.
   */
  shouldStartNewGroup(nodeId: string, now: number): boolean {
    if (this.undoGroupKey === null) return true
    if (nodeId !== this.lastEditNodeId) return true
    if (now - this.lastEditTimestamp > 1000) return true
    return false
  }

  /**
   * Start a new undo group for the given node at the given snapshot.
   * Creates a unique group key and stores the start snapshot.
   * Returns the new group key.
   */
  startGroup(nodeId: string, snapshot: object): string {
    const key = `group_${nodeId}_${Date.now()}_${Math.random().toString(36).slice(2)}`
    this.undoGroupKey = key
    this.undoGroupStartSnapshot = { ...snapshot }
    this.lastEditNodeId = nodeId
    this.lastEditTimestamp = Date.now()
    return key
  }

  /**
   * Update the last edit timestamp (called on each keystroke within a group).
   */
  touch(nodeId: string, now: number): void {
    this.lastEditTimestamp = now
    this.lastEditNodeId = nodeId
  }

  /**
   * Get the current group key (or null if no group is active).
   */
  getCurrentGroupKey(): string | null {
    return this.undoGroupKey
  }

  /**
   * Returns the pending group data and resets internal state.
   * Returns null if no group is active.
   */
  flush(): { groupKey: string; startSnapshot: object } | null {
    if (this.undoGroupKey === null || this.undoGroupStartSnapshot === null) {
      return null
    }
    const result = {
      groupKey: this.undoGroupKey,
      startSnapshot: this.undoGroupStartSnapshot,
    }
    this.undoGroupKey = null
    this.undoGroupStartSnapshot = null
    this.lastEditTimestamp = 0
    this.lastEditNodeId = null
    return result
  }

  /**
   * Reset all state without returning data (used when switching nodes
   * without flushing a pending group).
   */
  reset(): void {
    this.undoGroupKey = null
    this.undoGroupStartSnapshot = null
    this.lastEditTimestamp = 0
    this.lastEditNodeId = null
  }
}

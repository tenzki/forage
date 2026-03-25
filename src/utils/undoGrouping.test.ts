import { describe, it, expect, beforeEach } from 'vitest'
import { UndoGroupTracker } from './undoGrouping'

describe('UndoGroupTracker', () => {
  let tracker: UndoGroupTracker

  beforeEach(() => {
    tracker = new UndoGroupTracker()
  })

  describe('shouldStartNewGroup', () => {
    it('returns true when no group is active', () => {
      expect(tracker.shouldStartNewGroup('node-1', Date.now())).toBe(true)
    })

    it('returns true when more than 1000ms has passed since last edit', () => {
      tracker.startGroup('node-1', { text: 'hello' })
      tracker.touch('node-1', Date.now())

      // Simulate 1001ms later
      const future = Date.now() + 1001
      expect(tracker.shouldStartNewGroup('node-1', future)).toBe(true)
    })

    it('returns true when nodeId changes', () => {
      tracker.startGroup('node-1', { text: 'hello' })
      tracker.touch('node-1', Date.now())

      // Different node ID
      expect(tracker.shouldStartNewGroup('node-2', Date.now())).toBe(true)
    })

    it('returns false for edits within 1000ms on the same node', () => {
      const now = Date.now()
      tracker.startGroup('node-1', { text: 'hello' })
      tracker.touch('node-1', now)

      // 500ms later, same node
      expect(tracker.shouldStartNewGroup('node-1', now + 500)).toBe(false)
    })

    it('returns false immediately after startGroup', () => {
      tracker.startGroup('node-1', { text: 'hello' })
      // Immediately after (same ms), same node — should be within group
      expect(tracker.shouldStartNewGroup('node-1', Date.now())).toBe(false)
    })
  })

  describe('startGroup', () => {
    it('creates a new group key', () => {
      const key = tracker.startGroup('node-1', { text: 'hello' })
      expect(key).toBeTruthy()
      expect(typeof key).toBe('string')
      expect(key.startsWith('group_')).toBe(true)
    })

    it('stores the snapshot passed in', () => {
      const snapshot = { text: 'initial text', type: 'doc' }
      tracker.startGroup('node-1', snapshot)

      const flushed = tracker.flush()
      expect(flushed?.startSnapshot).toEqual(snapshot)
    })

    it('creates unique keys on successive calls', () => {
      const key1 = tracker.startGroup('node-1', { text: 'a' })
      tracker.flush()
      const key2 = tracker.startGroup('node-1', { text: 'b' })
      expect(key1).not.toBe(key2)
    })

    it('returns the group key', () => {
      const key = tracker.startGroup('node-1', {})
      expect(tracker.getCurrentGroupKey()).toBe(key)
    })
  })

  describe('getCurrentGroupKey', () => {
    it('returns null when no group is active', () => {
      expect(tracker.getCurrentGroupKey()).toBeNull()
    })

    it('returns the current group key after startGroup', () => {
      const key = tracker.startGroup('node-1', {})
      expect(tracker.getCurrentGroupKey()).toBe(key)
    })

    it('returns null after flush', () => {
      tracker.startGroup('node-1', {})
      tracker.flush()
      expect(tracker.getCurrentGroupKey()).toBeNull()
    })
  })

  describe('flush', () => {
    it('returns null when no pending group exists', () => {
      expect(tracker.flush()).toBeNull()
    })

    it('returns pending group data when a group is active', () => {
      const snapshot = { text: 'hello world' }
      const key = tracker.startGroup('node-1', snapshot)

      const result = tracker.flush()
      expect(result).not.toBeNull()
      expect(result?.groupKey).toBe(key)
      expect(result?.startSnapshot).toEqual(snapshot)
    })

    it('resets state after flush', () => {
      tracker.startGroup('node-1', { text: 'hello' })
      tracker.flush()

      // After flush, state is reset
      expect(tracker.getCurrentGroupKey()).toBeNull()
      expect(tracker.flush()).toBeNull()
    })

    it('returns null on second flush call', () => {
      tracker.startGroup('node-1', { text: 'hello' })
      tracker.flush()
      expect(tracker.flush()).toBeNull()
    })

    it('group data contains original start snapshot, not modified later', () => {
      const snapshot = { text: 'original' }
      tracker.startGroup('node-1', snapshot)

      // Modifying the original snapshot object should not affect stored snapshot
      // (startGroup stores a copy)
      snapshot.text = 'modified'

      const result = tracker.flush()
      expect(result?.startSnapshot).toEqual({ text: 'original' })
    })
  })
})

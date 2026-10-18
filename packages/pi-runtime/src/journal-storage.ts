import { MemoryStorage, type Id, type Seq, type StorageWrite } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord'

export interface JournalCommit { sequence: number; writes: readonly StorageWrite[] }

/** The backend must fence every operation against the executing run's lease. */
export interface DurableJournal {
  load(): Promise<JournalCommit[]>
  mintId(minimum: number): Promise<number>
  append(commit: JournalCommit): Promise<void>
  close(): Promise<void>
}

/**
 * Pi's reference storage supplies record/delta semantics and detached reads. The
 * backend journals each validated commit before it is published to the Harness.
 * As with Pi's JSONL storage, retained history is materialized in memory on open;
 * the host bounds journal size and deletes it with its owning call.
 */
export class JournalStorage extends MemoryStorage {
  private sequence = 0

  private constructor(private readonly journal: DurableJournal) { super() }

  static async open(journal: DurableJournal): Promise<JournalStorage> {
    const storage = new JournalStorage(journal)
    try {
      for (const commit of await journal.load()) {
        storage.prepareCommit(commit.writes, commit.sequence as Seq).apply()
        storage.sequence = commit.sequence
      }
      return storage
    } catch (error) {
      await journal.close()
      throw error
    }
  }

  override async mintId<I extends Id<string>>(): Promise<I> {
    const minimum = await super.mintId<I>()
    return await this.journal.mintId(minimum) as I
  }

  override async commit(writes: readonly StorageWrite[], context: Context): Promise<Seq> {
    context.abortSignal?.throwIfAborted()
    const prepared = this.prepareCommit(writes, (this.sequence + 1) as Seq)
    await this.journal.append({ sequence: prepared.seq, writes: prepared.writes })
    const sequence = prepared.apply()
    this.sequence = sequence
    return sequence
  }

  override async close(context: Context): Promise<void> {
    try { await super.close(context) } finally { await this.journal.close() }
  }
}

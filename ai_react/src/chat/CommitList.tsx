import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getSnapshot, subscribe } from './store.ts'

interface GitCommit {
  hash: string
  /** Full commit message (subject + body). */
  message: string
  /** Commit time as a unix timestamp (seconds). */
  date: number
  /** snapshot = pre-modification snapshot, agent = agent turn commit. */
  kind: 'snapshot' | 'agent' | 'user'
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Scrollable list of every commit in the repository (full messages), newest
 * first. Refreshes automatically whenever an agent turn finishes. The newest
 * commit has a FORGET button that removes it from git history
 * (`git reset --hard HEAD~1`), restoring the previous project state.
 */
export function CommitList() {
  const { busy } = useSyncExternalStore(subscribe, getSnapshot)
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/git/log')
      const body = await res.json()
      if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`))
      setCommits(body.commits as GitCommit[])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  // Initial load, plus a refresh every time `busy` flips back to false —
  // i.e. right after each agent turn (and its end-of-turn commit) completes.
  useEffect(() => {
    if (!busy) void refresh()
  }, [busy, refresh])

  const forget = useCallback(
    async (c: GitCommit) => {
      const subject = c.message.split('\n')[0]
      const ok = window.confirm(
        `Remove commit ${c.hash} ("${subject}") from git history?\n\n` +
          'This resets the project to the previous commit and permanently discards its changes.',
      )
      if (!ok) return
      try {
        const res = await fetch('/api/git/forget', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hash: c.hash }),
        })
        const body = await res.json()
        if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`))
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
      void refresh()
    },
    [refresh],
  )

  return (
    <aside className="commit-panel">
      <div className="commit-panel-header">
        <span>Commits</span>
        <a
          className="commit-recovery-link"
          href="/recovery"
          target="_blank"
          rel="noreferrer"
          title="Standalone recovery page — works even when the app is broken"
        >
          Recovery
        </a>
        <button title="Refresh" onClick={() => void refresh()}>
          ⟳
        </button>
      </div>
      <div className="commit-panel-list">
        {error && <div className="commit-error">{error}</div>}
        {!error && commits.length === 0 && <div className="commit-empty">No commits to show.</div>}
        {commits.map((c, i) => (
          <div key={c.hash} className={`commit-item${c.kind === 'snapshot' ? ' snapshot' : ''}`}>
            <div className="commit-subject">{c.message}</div>
            <div className="commit-meta">
              <code>{c.hash}</code>
              <span>{formatDate(c.date)}</span>
              {c.kind !== 'user' && <span className="commit-badge">{c.kind}</span>}
              {i === 0 && (
                <button
                  className="commit-forget"
                  title="Remove this commit from git history (git reset --hard HEAD~1)"
                  disabled={busy}
                  onClick={() => void forget(c)}
                >
                  FORGET
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}

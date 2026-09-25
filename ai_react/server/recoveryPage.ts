// Self-contained recovery page served at /recovery. It deliberately has no
// dependency on the React app, the Vite module graph, or any source file the
// agent can write to — so it keeps working even when the agent has broken the
// frontend. Everything (markup, styles, script) is inlined below.

export const recoveryHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Recovery — ai-react</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #1a1a1a;
    color: #f0f0f0;
    font: 15px/1.5 system-ui, sans-serif;
    padding: 32px 16px;
  }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .intro { color: #9a9a9a; margin: 0 0 20px; }
  .toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  button {
    background: #2a2a2a; color: #f0f0f0; border: 1px solid #3a3a3a;
    border-radius: 6px; padding: 6px 12px; font: inherit; font-size: 13px;
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: #3a3a3a; }
  button:disabled { opacity: 0.5; cursor: default; }
  .status { font-size: 13px; color: #9a9a9a; }
  .status.error { color: #e08080; }
  .status.ok { color: #a0c0a0; }
  ul { list-style: none; margin: 0; padding: 0; border: 1px solid #3a3a3a; border-radius: 8px; overflow: hidden; }
  li { padding: 10px 14px; border-bottom: 1px solid #2a2a2a; background: #202020; }
  li:last-child { border-bottom: none; }
  li.snapshot { background: #1c1c1c; }
  .subject { white-space: pre-wrap; word-break: break-word; }
  .meta { display: flex; align-items: center; gap: 10px; margin-top: 4px; font-size: 12.5px; color: #9a9a9a; }
  .meta code { color: #c0c0c0; }
  .badge {
    border: 1px solid #3a3a3a; border-radius: 4px; padding: 0 6px;
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px;
  }
  .restore { margin-left: auto; }
</style>
</head>
<body>
<main>
  <h1>Recovery</h1>
  <p class="intro">
    This page is served directly by the dev server and works even when the app
    itself is broken. Restoring creates a new commit with the selected commit's
    project state — nothing is deleted from history.
  </p>
  <div class="toolbar">
    <button id="refresh">Refresh</button>
    <span id="status" class="status"></span>
  </div>
  <ul id="commits"></ul>
</main>
<script>
  const list = document.getElementById('commits')
  const statusEl = document.getElementById('status')
  let busy = false

  function setStatus(text, kind) {
    statusEl.textContent = text
    statusEl.className = 'status' + (kind ? ' ' + kind : '')
  }

  function formatDate(unixSeconds) {
    return new Date(unixSeconds * 1000).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }

  function render(commits) {
    list.replaceChildren()
    for (const c of commits) {
      const li = document.createElement('li')
      if (c.kind === 'snapshot') li.className = 'snapshot'

      const subject = document.createElement('div')
      subject.className = 'subject'
      subject.textContent = c.message
      li.append(subject)

      const meta = document.createElement('div')
      meta.className = 'meta'
      const hash = document.createElement('code')
      hash.textContent = c.hash
      const date = document.createElement('span')
      date.textContent = formatDate(c.date)
      meta.append(hash, date)
      if (c.kind !== 'user') {
        const badge = document.createElement('span')
        badge.className = 'badge'
        badge.textContent = c.kind
        meta.append(badge)
      }
      const btn = document.createElement('button')
      btn.className = 'restore'
      btn.textContent = 'RESTORE'
      btn.addEventListener('click', () => restore(c))
      meta.append(btn)
      li.append(meta)
      list.append(li)
    }
  }

  async function refresh() {
    try {
      const res = await fetch('/api/git/log')
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status)
      render(body.commits)
      if (!busy) setStatus('')
    } catch (err) {
      setStatus(String(err.message || err), 'error')
    }
  }

  async function restore(c) {
    if (busy) return
    const subject = c.message.split('\\n')[0]
    const ok = window.confirm(
      'Restore the project state of commit ' + c.hash + ' ("' + subject + '")?\\n\\n' +
      'Current uncommitted changes are saved as a snapshot first, then the ' +
      'restored state is committed on top. Nothing is deleted from history.'
    )
    if (!ok) return
    busy = true
    setStatus('Restoring ' + c.hash + ' …')
    try {
      const res = await fetch('/api/git/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash: c.hash }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status)
      setStatus(
        body.restored
          ? 'Restored state of ' + c.hash + ' as commit ' + body.restored + '.'
          : 'Project already matches commit ' + c.hash + ' — nothing to do.',
        'ok',
      )
    } catch (err) {
      setStatus(String(err.message || err), 'error')
    } finally {
      busy = false
      refresh()
    }
  }

  document.getElementById('refresh').addEventListener('click', refresh)
  refresh()
</script>
</body>
</html>
`

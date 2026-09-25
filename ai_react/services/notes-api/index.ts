import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { URL } from 'node:url'

const PORT = Number(process.env.PORT)
const DATA_PATH = path.join(process.cwd(), 'data.json')

// Ensure data.json exists with three initial notes
if (!fs.existsSync(DATA_PATH)) {
  fs.writeFileSync(DATA_PATH, JSON.stringify([
    { id: 1, title: 'First Note', content: 'This is the first note.' },
    { id: 2, title: 'Second Note', content: 'This is the second note.' },
    { id: 3, title: 'Third Note', content: 'This is the third note.' }
  ], null, 2))
}

function readData() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8')
    return JSON.parse(raw)
  } catch {
    return []
  }
}

function writeData(notes: any[]) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(notes, null, 2))
}

function sendJSON(res: http.ServerResponse, status: number, data: any) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function sendError(res: http.ServerResponse, status: number, message: string) {
  sendJSON(res, status, { error: message })
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function parseNote(body: any): { title?: string; content?: string } | null {
  if (!body || typeof body !== 'object') return null
  const { title, content } = body
  if (typeof title !== 'string' || typeof content !== 'string') return null
  return { title, content }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  const pathParts = url.pathname.split('/').filter(Boolean)

  // GET /health
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJSON(res, 200, { status: 'ok' })
    return
  }

  // GET /notes
  if (req.method === 'GET' && url.pathname === '/notes') {
    const notes = readData()
    sendJSON(res, 200, notes)
    return
  }

  // POST /notes - create
  if (req.method === 'POST' && url.pathname === '/notes') {
    try {
      const body = await readBody(req)
      const parsed = JSON.parse(body)
      const noteData = parseNote(parsed)
      if (!noteData) {
        sendError(res, 400, 'Invalid note: title and content are required strings')
        return
      }
      const notes = readData()
      const newNote = {
        id: notes.length > 0 ? Math.max(...notes.map(n => n.id)) + 1 : 1,
        title: noteData.title,
        content: noteData.content
      }
      notes.push(newNote)
      writeData(notes)
      sendJSON(res, 201, newNote)
    } catch {
      sendError(res, 400, 'Invalid JSON body')
    }
    return
  }

  // PUT /notes/:id - update
  if (req.method === 'PUT' && pathParts[0] === 'notes' && pathParts[1]) {
    const id = parseInt(pathParts[1], 10)
    if (isNaN(id)) {
      sendError(res, 400, 'Invalid note id')
      return
    }
    try {
      const body = await readBody(req)
      const parsed = JSON.parse(body)
      const noteData = parseNote(parsed)
      if (!noteData) {
        sendError(res, 400, 'Invalid note: title and content are required strings')
        return
      }
      const notes = readData()
      const index = notes.findIndex(n => n.id === id)
      if (index === -1) {
        sendError(res, 404, 'Note not found')
        return
      }
      notes[index] = { ...notes[index], ...noteData }
      writeData(notes)
      sendJSON(res, 200, notes[index])
    } catch {
      sendError(res, 400, 'Invalid JSON body')
    }
    return
  }

  // DELETE /notes/:id
  if (req.method === 'DELETE' && pathParts[0] === 'notes' && pathParts[1]) {
    const id = parseInt(pathParts[1], 10)
    if (isNaN(id)) {
      sendError(res, 400, 'Invalid note id')
      return
    }
    const notes = readData()
    const index = notes.findIndex(n => n.id === id)
    if (index === -1) {
      sendError(res, 404, 'Note not found')
      return
    }
    const [deleted] = notes.splice(index, 1)
    writeData(notes)
    sendJSON(res, 200, deleted)
    return
  }

  sendError(res, 404, 'Not found')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`notes-api listening on ${PORT}`)
})
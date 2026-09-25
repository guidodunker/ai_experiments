import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { allocatePort, isPortFree } from '../server/services/ports.ts'

function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(port, '127.0.0.1', () => resolve(srv))
  })
}

test('a port someone else holds is not free', async () => {
  const srv = await occupy(4098)
  try {
    assert.equal(await isPortFree(4098), false)
  } finally {
    srv.close()
  }
})

test('allocation skips ports already taken by known services', async () => {
  const port = await allocatePort([4001, 4002], { from: 4001, to: 4099 })
  assert.equal(port, 4003)
})

test('allocation skips a port occupied by an unrelated process', async () => {
  const srv = await occupy(4001)
  try {
    assert.equal(await allocatePort([], { from: 4001, to: 4099 }), 4002)
  } finally {
    srv.close()
  }
})

test('an exhausted range is an explicit error, never a silent reuse', async () => {
  await assert.rejects(() => allocatePort([4001, 4002], { from: 4001, to: 4002 }), /No free port/)
})

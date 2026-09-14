/** Private model wire fixture with a controlled first-response pause for cross-replica observation. */

import { createServer, request } from 'node:http'
import { createRequire } from 'node:module'
import { pipeline, Transform } from 'node:stream'

const require = createRequire('/app/apps/cli/package.json')
const { startMockLlmServer } = await import(require.resolve('@deepseek-ai/dsh-llm-mock-server'))
const model = await startMockLlmServer({
  apiKey: 'docker-model-test-only',
  sequence: ['slow_success', 'tool_call_success', 'success'],
  repeatLast: true,
  successText: `REPLICA_STREAM_START ${'verified '.repeat(16)}REPLICA_STREAM_DONE`,
  chunkSize: 64,
  chunkDelayMs: 30,
  toolName: 'exit_plan_mode',
  toolArguments: JSON.stringify({ plan: '# Replica restart verification\n\n- Keep pending questions.\n- Continue on the remaining replica.' }),
})
let count = 0
let release
const outgoing = new Set()
const server = createServer((incoming, response) => {
  const path = new URL(incoming.url, 'http://model').pathname
  if (path === '/control/status') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      held: release !== undefined,
      requestCount: model.requests.length,
      requests: model.requests.map(value => ({ body: value.body, outcome: value.outcome, chunksSent: value.chunksSent })),
    }))
    return
  }
  if (path === '/control/release' && incoming.method === 'POST') {
    const resume = release
    release = undefined
    resume?.()
    response.end('released')
    return
  }
  const number = ++count
  const peer = request(`${model.baseURL}${incoming.url}`, { method: incoming.method, headers: incoming.headers })
  outgoing.add(peer)
  peer.once('close', () => outgoing.delete(peer))
  peer.once('error', error => response.destroy(error))
  incoming.pipe(peer)
  peer.once('response', upstream => {
    response.writeHead(upstream.statusCode, upstream.headers)
    let first = true
    const gate = new Transform({
      transform(chunk, _encoding, callback) {
        if (number === 1 && first && upstream.statusCode === 200) {
          first = false
          this.push(chunk)
          release = error => callback(error)
        } else {
          callback(null, chunk)
        }
      },
    })
    response.once('close', () => {
      upstream.destroy()
      gate.destroy()
    })
    pipeline(upstream, gate, response, error => {
      if (error !== undefined && !response.destroyed) response.destroy(error)
    })
  })
})
server.listen(3081, '0.0.0.0')
process.once('SIGTERM', async () => {
  release?.(new Error('test model shutdown'))
  release = undefined
  for (const peer of outgoing) peer.destroy()
  const closed = new Promise(resolve => server.close(resolve))
  server.closeAllConnections()
  await Promise.all([closed, model.close()])
})

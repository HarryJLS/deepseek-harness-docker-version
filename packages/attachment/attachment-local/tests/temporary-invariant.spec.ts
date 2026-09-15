import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { parseUserId, withUser } from '@deepseek-ai/dsh-user-context'
import LocalAttachmentStore from '../src/index.ts'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, stat: vi.fn(fs.stat) }
})

const contexts: Context[] = []
const directories: string[] = []
const alice = parseUserId('alice')
const bob = parseUserId('bob')
const data = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
  'base64',
))

async function setup() {
  const root = await mkdtemp(join(process.cwd(), '.temporary-attachments-test-'))
  directories.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  const fiber = await ctx.plugin(LocalAttachmentStore, { temporaryRoot: relative(process.cwd(), root) })
  return { ctx, root, fiber, store: ctx.get('attachments')! }
}

function agentFor(ctx: Context, session: Session): Agent {
  return {
    id: session.id, ctx, session, options: {}, status: 'running',
    inbox: createInboxStub(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function imageMessage(ref: ImageAttachmentRef): UserMessage {
  return createUserMessage({ content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } })
}

function sessionFor(userId = alice): Session {
  const id = SessionId('temporary-images')
  return Session.create(id, undefined, { id, version: 3, isSeeded: false, createdAt: 1, userId })
}

async function prepare(
  ctx: Context,
  session: Session,
  messages: UserMessage[] = [],
  decision: PreStepDecision = { kind: 'enter', messages, startsRequestSeries: true },
  signal = new AbortController().signal,
) {
  return agentEvents(ctx, agentFor(ctx, session)).waterfall(
    'agent/pre-step', { messages, turn: 1, step: 1, signal }, () => Promise.resolve(decision),
  )
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('temporary attachment storage', () => {
  it('rejects absolute, empty, and escaping configuration paths', () => {
    for (const temporaryRoot of ['', '.', './', '/tmp/images', '../images', 'images/../outside', 'C:\\images']) {
      expect(() => new LocalAttachmentStore(new Context(), { temporaryRoot })).toThrow(/temporaryRoot/u)
    }
  })

  it('records only relative references and filenames, with independent per-user files', async () => {
    const { store, root } = await setup()
    const first = await withUser(alice, () => store.saveImage({ data, mediaType: 'image/png', name: '../screen.png' }))
    const second = await withUser(bob, () => store.saveImage({ data, mediaType: 'image/png', name: 'screen.png' }))
    expect(first.attachmentId).toBe(second.attachmentId)
    expect(first.name).toBe('screen.png')
    expect(first.temporaryPath).not.toBe(second.temporaryPath)
    expect(first.temporaryPath).not.toContain('..')
    expect(JSON.stringify(first)).not.toContain(Buffer.from(data).toString('base64'))
    expect(first).not.toHaveProperty('data')
    const path = withUser(alice, () => store.imageHostPath(first))!
    expect(path.startsWith(root)).toBe(true)
    expect(await readFile(path)).toEqual(Buffer.from(data))
    await expect(withUser(alice, () => store.readImage(first))).resolves.toEqual({ ref: first, data })
    await expect(withUser(bob, () => store.readImage(first))).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_REF' })
    await expect(withUser(alice, () => store.readImage({ ...first, temporaryPath: '../outside' })))
      .rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_REF' })
    const request = await withUser(alice, () => store.readImageRequest(first, { maxPixels: 1, maxBytes: 1024 }))
    expect(request.data.byteLength).toBeGreaterThan(0)
  })

  it('keeps batch input order and records a filename for unnamed uploads', async () => {
    const { store } = await setup()
    const refs = await withUser(alice, () => store.saveImages([
      { data, mediaType: 'image/png', name: 'one.png' },
      { data, mediaType: 'image/png' },
    ]))
    expect(refs[0]!.name).toBe('one.png')
    expect(refs[1]!.name).toBeTypeOf('string')
    expect(refs.every(ref => ref.temporaryPath !== undefined)).toBe(true)
  })

  it('keeps generic-file bytes and streaming uploads in separate user directories', async () => {
    const { store, root } = await setup()
    const input = { data: new Uint8Array(Buffer.from('private document')), name: '../report.txt' }
    const first = await withUser(alice, () => store.saveFile(input))
    const second = await withUser(bob, () => store.saveFileStream({
      name: input.name,
      data: (async function* () { yield input.data.subarray(0, 3); yield input.data.subarray(3) })(),
    }))
    expect(first.name).toBe('report.txt')
    expect(first.attachmentId).toBe(second.attachmentId)
    expect(first.temporaryPath).not.toBe(second.temporaryPath)
    const path = withUser(alice, () => store.fileHostPath(first))!
    expect(path.startsWith(root)).toBe(true)
    expect(await readFile(path)).toEqual(Buffer.from(input.data))
    expect(() => withUser(bob, () => store.readFileStream(first))).toThrow('does not belong')
    expect(() => withUser(alice, () => store.fileHostPath({ ...first, temporaryPath: '../report.txt' })))
      .toThrow('does not belong')
    const chunks: Uint8Array[] = []
    const stream = withUser(alice, () => store.readFileStream(first))
    for await (const chunk of stream) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(input.data))
    expect(JSON.stringify(first)).not.toContain(Buffer.from(input.data).toString('base64'))
  })

  it('leaves present images unchanged and logs a path replacement after deletion', async () => {
    const { ctx, store } = await setup()
    const ref = await withUser(alice, () => store.saveImage({ data, mediaType: 'image/png', name: 'screen.png' }))
    const session = sessionFor()
    session.append('user/message', imageMessage(ref), { surfaceOp: 'append' })
    const original = session.snapshotEvents()[0]!
    expect((await prepare(ctx, session)).kind).toBe('enter')
    expect(session.snapshotEvents()).toHaveLength(1)
    await rm(withUser(alice, () => store.imageHostPath(ref))!)
    const decision = await prepare(ctx, session)
    expect(decision).toMatchObject({ kind: 'enter', startsRequestSeries: true })
    expect(session.snapshotEvents()).toHaveLength(2)
    expect(session.snapshotEvents()[0]).toBe(original)
    expect(session.snapshotEvents()[1]).toMatchObject({
      type: 'user/message', surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0],
    })
    expect(JSON.stringify(session.deriveMessages())).toContain('Temporary image unavailable')
    expect(JSON.stringify(session.deriveMessages())).toContain(ref.temporaryPath)
    expect(JSON.stringify(session.deriveMessages())).toContain('screen.png')
    await prepare(ctx, session)
    expect(session.snapshotEvents()).toHaveLength(2)
    const restored = Session.create(session.id, session.snapshotEvents(), session.header)
    expect(restored.deriveMessages()).toEqual(session.deriveMessages())
  })

  it('replaces missing assistant and nested tool images without changing tool result metadata', async () => {
    const { ctx } = await setup()
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'missing.png',
    }
    const session = sessionFor()
    session.append('assistant/message', {
      turn: 1, step: 1, stream: [], message: createAssistantMessage({
        content: [{ type: 'image', attachment: ref }], source: { provider: 'test', model: 'test' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: 1, step: 1, meta: { path: 'screen.png' },
      message: createToolResultMessage({
        callId: ToolCallId('image-call'), isError: false,
        content: [{ type: 'text', text: 'screenshot' }, { type: 'image', attachment: ref }],
      }),
    }, { surfaceOp: 'append' })
    await prepare(ctx, session)
    expect(session.snapshotEvents()).toHaveLength(4)
    expect(session.snapshotEvents()[2]).toMatchObject({
      type: 'user/message',
      data: { source: { kind: 'plugin', plugin: 'attachment-local' } },
      sourceEventSeqs: [0],
    })
    expect(session.snapshotEvents()[3]).toMatchObject({ type: 'tool/result', data: { meta: { path: 'screen.png' } } })
    expect(JSON.stringify(session.deriveMessages())).not.toContain('"type":"image"')
    expect(JSON.stringify(session.deriveMessages())).toContain('screenshot')
    await prepare(ctx, session)
    expect(session.snapshotEvents()).toHaveLength(4)
  })

  it('quotes a complete assistant tool exchange while retaining available media and the original records', async () => {
    const { ctx, store } = await setup()
    const available = await withUser(alice, () => store.saveImage({ data, mediaType: 'image/png' }))
    const missing: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    }
    const session = sessionFor()
    const callId = ToolCallId('quoted-call')
    session.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: createAssistantMessage({
        content: [
          { type: 'text', text: 'The original assistant explanation.' },
          { type: 'image', attachment: missing },
          { type: 'tool-call', id: callId, name: 'inspect', arguments: '{"path":"record.txt"}' },
        ],
        source: { provider: 'test', model: 'test' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId, isError: false,
        content: [{ type: 'text', text: 'The recorded tool result.' }, { type: 'image', attachment: available }],
      }),
    }, { surfaceOp: 'append' })
    const original = session.snapshotEvents()
    await prepare(ctx, session)
    expect(session.snapshotEvents().slice(0, 2)).toEqual(original)
    const derived = session.deriveMessages()
    expect(derived).toHaveLength(1)
    expect(derived[0]?.source).toMatchObject({ kind: 'plugin', plugin: 'attachment-local' })
    const quote = derived[0]?.content[0]
    expect(quote?.type === 'text' ? quote.text : undefined).toContain('original assistant explanation')
    expect(JSON.stringify(derived)).toContain('recorded tool result')
    expect(derived[0]?.content).toContainEqual({ type: 'image', attachment: available })
    expect(derived.flatMap(value => value.content).some(block => block.type === 'tool-call' || block.type === 'tool-result')).toBe(false)
    const restored = Session.create(session.id, session.snapshotEvents(), session.header)
    expect(restored.deriveMessages()).toEqual(derived)
    await prepare(ctx, session)
    expect(session.snapshotEvents()).toHaveLength(3)
  })

  it('rewrites not-yet-logged messages, preserves rejection and abort, and disposes its listener', async () => {
    const { ctx, store, fiber } = await setup()
    const ref = await withUser(alice, () => store.saveImage({ data, mediaType: 'image/png' }))
    await rm(withUser(alice, () => store.imageHostPath(ref))!)
    const session = sessionFor()
    const incoming = imageMessage(ref)
    expect(await prepare(ctx, session, [incoming], { kind: 'reject' })).toEqual({ kind: 'reject' })
    expect(session.snapshotEvents()).toHaveLength(0)
    const decision = await prepare(ctx, session, [incoming])
    expect(decision).toMatchObject({ kind: 'enter', messages: [{ content: [{ type: 'text' }] }] })
    expect(incoming.content[0]!.type).toBe('image')
    await expect(prepare(ctx, session, [incoming], undefined, AbortSignal.abort(new Error('cancelled'))))
      .rejects.toThrow('cancelled')
    await fiber.dispose()
    const after = await prepare(ctx, session, [incoming])
    expect(after).toMatchObject({ kind: 'enter', messages: [incoming] })
  })

  it('handles anonymous sessions and unnamed imported references', async () => {
    const { ctx } = await setup()
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
      mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    }
    const session = Session.create(SessionId('anonymous-image'))
    session.append('user/message', imageMessage(ref), { surfaceOp: 'append' })
    await prepare(ctx, session)
    expect(JSON.stringify(session.deriveMessages())).toContain('/users/2d/')
    expect(JSON.stringify(session.deriveMessages())).not.toContain('; filename')
  })

  it('propagates file permission failures without recording a missing-image replacement', async () => {
    const { ctx, store } = await setup()
    const ref = await withUser(alice, () => store.saveImage({ data, mediaType: 'image/png' }))
    const session = sessionFor()
    session.append('user/message', imageMessage(ref), { surfaceOp: 'append' })
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    vi.mocked(stat).mockRejectedValueOnce(error)
    await expect(prepare(ctx, session)).rejects.toBe(error)
    expect(session.snapshotEvents()).toHaveLength(1)
  })

  it('repairs missing history before downstream pre-step consumers inspect it', async () => {
    const { ctx, store } = await setup()
    const ref = await withUser(alice, () => store.saveImage({ data, mediaType: 'image/png' }))
    await rm(withUser(alice, () => store.imageHostPath(ref))!)
    const session = sessionFor()
    session.append('user/message', imageMessage(ref), { surfaceOp: 'append' })
    ctx.on('agent/pre-step', ({ agent }, next) => {
      expect(JSON.stringify(agent.session.deriveMessages())).not.toContain('"type":"image"')
      return next()
    })
    await prepare(ctx, session)
  })
})

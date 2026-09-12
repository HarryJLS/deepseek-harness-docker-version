import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { parseUserId, withUser } from '@deepseek-ai/dsh-user-context'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import LocalAttachmentStore from '../src/index.ts'
import * as attachmentInvariant from '../src/invariant.ts'

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
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(attachmentInvariant)
  return { ctx, root, fiber, store: ctx.get('attachments')! }
}

function agentFor(ctx: Context, session: Session): Agent {
  return {
    id: session.id, ctx, session, options: {}, status: 'running',
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
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
  return Session.create(id, undefined, { id, version: 0, createdAt: 1, userId })
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

  it('leaves present images unchanged and logs a path replacement after deletion', async () => {
    const { ctx, store } = await setup()
    const ref = await withUser(alice, () => store.saveImage({ data, mediaType: 'image/png', name: 'screen.png' }))
    const session = sessionFor()
    session.append('user/message', imageMessage(ref), { surfaceOp: 'append' })
    const original = session.events[0]!
    expect((await prepare(ctx, session)).kind).toBe('enter')
    expect(session.events).toHaveLength(1)
    await rm(withUser(alice, () => store.imageHostPath(ref))!)
    const decision = await prepare(ctx, session)
    expect(decision).toMatchObject({ kind: 'enter', startsRequestSeries: true })
    expect(session.events).toHaveLength(2)
    expect(session.events[0]).toBe(original)
    expect(session.events[1]).toMatchObject({
      type: 'user/message', surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0],
    })
    expect(JSON.stringify(session.deriveMessages())).toContain('Temporary image unavailable')
    expect(JSON.stringify(session.deriveMessages())).toContain(ref.temporaryPath)
    expect(JSON.stringify(session.deriveMessages())).toContain('screen.png')
    await prepare(ctx, session)
    expect(session.events).toHaveLength(2)
    const restored = Session.create(session.id, session.events, session.header)
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
      turn: 1, step: 1, message: createAssistantMessage({
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
    expect(session.events).toHaveLength(4)
    expect(session.events[3]).toMatchObject({ type: 'tool/result', data: { meta: { path: 'screen.png' } } })
    expect(JSON.stringify(session.deriveMessages())).not.toContain('"type":"image"')
    expect(JSON.stringify(session.deriveMessages())).toContain('screenshot')
    await prepare(ctx, session)
    expect(session.events).toHaveLength(4)
  })

  it('rewrites not-yet-logged messages, preserves rejection and abort, and disposes its listener', async () => {
    const { ctx, store, fiber } = await setup()
    const ref = await withUser(alice, () => store.saveImage({ data, mediaType: 'image/png' }))
    await rm(withUser(alice, () => store.imageHostPath(ref))!)
    const session = sessionFor()
    const incoming = imageMessage(ref)
    expect(await prepare(ctx, session, [incoming], { kind: 'reject' })).toEqual({ kind: 'reject' })
    expect(session.events).toHaveLength(0)
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
    expect(session.events).toHaveLength(1)
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

/** Document lifecycle and connection defaults used by Nacos provider examples. */
import z from '@deepseek-ai/schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NacosConfigClient, type NacosConfigListener } from '../src/client.ts'
import { nacosDocument, nacosEntrySchema } from '../src/document.ts'

afterEach(() => { vi.restoreAllMocks() })

function server(initial: string) {
  let content = initial
  let listener: NacosConfigListener | undefined
  const stop = vi.fn()
  const close = vi.spyOn(NacosConfigClient.prototype, 'close').mockImplementation(() => {})
  vi.spyOn(NacosConfigClient.prototype, 'connect').mockResolvedValue()
  vi.spyOn(NacosConfigClient.prototype, 'read').mockImplementation(async () => ({ content, md5: '' }))
  const publish = vi.spyOn(NacosConfigClient.prototype, 'publish').mockImplementation(async (_key, next) => { content = next })
  vi.spyOn(NacosConfigClient.prototype, 'watch').mockImplementation(async (_key, onChange) => {
    listener = onChange
    return stop
  })
  return {
    close,
    stop,
    publish,
    read: () => content,
    push: (next: string) => {
      content = next
      listener?.(next)
    },
  }
}

function textDocument() {
  return nacosDocument({ host: '127.0.0.1' }, 'my-plugin.txt', {
    parse: content => content ?? '',
    render: document => document,
  })
}

describe('NacosDocument examples', () => {
  it('reads, watches, updates, and releases a text document', async () => {
    const remote = server('initial')
    const entry = textDocument()
    const changed = vi.fn<(document: string) => void>()
    try {
      await entry.connect()
      expect(await entry.read()).toBe('initial')
      await entry.watch(changed)
      remote.push('external')
      await entry.write(current => `${current}\nReady.`)
      expect(changed).toHaveBeenCalledWith('external')
      expect(remote.read()).toBe('external\nReady.')
      expect(remote.publish).toHaveBeenCalledWith(
        { dataId: 'my-plugin.txt', group: 'DEFAULT_GROUP' },
        'external\nReady.',
      )
    } finally {
      entry.close()
    }
    expect(remote.stop).toHaveBeenCalledOnce()
    expect(remote.close).toHaveBeenCalledOnce()
  })

  it('serializes edits and permits publication under an exclusive operation', async () => {
    const remote = server('initial')
    const entry = textDocument()
    try {
      await entry.connect()
      expect(await Promise.all([
        entry.write(current => `${current}A`),
        entry.write(current => `${current}B`),
      ])).toEqual(['initialA', 'initialAB'])
      await entry.exclusive(async (current) => { await entry.publish(`${current}!`) })
      expect(remote.read()).toBe('initialAB!')
    } finally {
      entry.close()
    }
  })

  it('releases the connection when an example write rejects', async () => {
    const remote = server('initial')
    remote.publish.mockRejectedValueOnce(new Error('unavailable'))
    const entry = textDocument()
    await expect((async () => {
      try {
        await entry.connect()
        await entry.write(current => `${current}\nReady.`)
      } finally {
        entry.close()
      }
    })()).rejects.toThrow('unavailable')
    expect(remote.close).toHaveBeenCalledOnce()
    expect(remote.read()).toBe('initial')
  })

  it('requires a host and resolves documented connection defaults', () => {
    const schema = z.object(nacosEntrySchema)
    expect(() => schema({})).toThrow()
    expect(schema({ host: 'nacos' })).toEqual({
      host: 'nacos',
      port: 8848,
      namespace: '',
      group: 'DEFAULT_GROUP',
      requestTimeoutMs: 10000,
    })
  })
})

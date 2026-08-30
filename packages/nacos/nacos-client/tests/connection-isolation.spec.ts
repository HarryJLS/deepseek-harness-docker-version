/**
 * Each client gets its own connection.
 *
 * This is not a style preference. grpc-js pools subchannels by (target,
 * credentials, options), Nacos identifies a client connection by its source
 * address, and a harness process runs several Nacos-backed plugins at once. Two
 * clients sharing a connection therefore share a registration, and the one the
 * server displaces goes silently deaf — it keeps answering reads while never
 * seeing another change.
 */

import { describe, expect, it, vi } from 'vitest'
import * as grpc from '@grpc/grpc-js'
import { NacosConfigClient } from '../src/client.ts'

/** Channel options captured from each constructed gRPC client. */
function captureChannelOptions(): { options: unknown[]; restore: () => void } {
  const options: unknown[] = []
  const spy = vi.spyOn(grpc, 'loadPackageDefinition').mockReturnValue({
    Request: class {
      constructor(_address: string, _credentials: unknown, channelOptions: unknown) {
        options.push(channelOptions)
      }
      close(): void {}
    },
    BiRequestStream: class {
      constructor(_address: string, _credentials: unknown, channelOptions: unknown) {
        options.push(channelOptions)
      }
      close(): void {}
    },
  } as never)
  return { options, restore: () => { spy.mockRestore() } }
}

describe('connection isolation', () => {
  it('gives every client a distinct channel option set', async () => {
    const { options, restore } = captureChannelOptions()
    try {
      // connect() rejects at the server check — the clients are constructed
      // first, which is the whole of what this asserts.
      const first = new NacosConfigClient({ host: 'nacos.invalid', port: 8848 })
      const second = new NacosConfigClient({ host: 'nacos.invalid', port: 8848 })
      await first.connect().catch(() => undefined)
      await second.connect().catch(() => undefined)

      const agents = options.map(
        entry => (entry as Record<string, string>)['grpc.primary_user_agent'],
      )
      expect(agents.length).toBeGreaterThanOrEqual(2)
      for (const agent of agents) expect(agent).toMatch(/^dsh-nacos-client\//u)
      // Two clients must not collapse onto one pooled subchannel.
      expect(new Set(agents).size).toBeGreaterThan(1)
    } finally {
      restore()
    }
  })
})

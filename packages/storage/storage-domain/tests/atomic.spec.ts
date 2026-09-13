import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { defineDomain, domainTable } from '../src/spec.ts'
import { DomainImpl } from '../src/domain.ts'
import type { DomainChanged } from '../src/events.ts'

const spec = defineDomain({
  name: 'atomic_test', version: 1,
  tables: { rows: domainTable<string, { count: number }>(z.object({ count: z.number() })) },
  global: { schema: z.object({ order: z.array(z.string()) }), initial: { order: [] as string[] } },
})

function bench() {
  let medium = { tables: { rows: {} as Record<string, unknown> }, global: { order: [] as string[] } }
  let tail = Promise.resolve()
  const scoped = (data: typeof medium): KvUnit => ({
    loadAll: async () => structuredClone(data),
    putRecord: async (_table, key, value) => { data.tables.rows[key] = value },
    deleteRecord: async (_table, key) => { Reflect.deleteProperty(data.tables.rows, key) },
    setGlobal: async (value) => { data.global = value as typeof data.global },
    close: async () => {},
  })
  const unit: KvUnit = {
    ...scoped(medium),
    transaction: (operation) => {
      const job = tail.then(async () => {
        const staged = structuredClone(medium)
        const result = await operation(scoped(staged))
        medium = staged
        return result
      })
      tail = job.then(() => {}, () => {})
      return job
    },
  }
  const ctx = new Context()
  const changed = vi.fn<(change: DomainChanged) => void>()
  ctx.on('domain/changed', changed)
  const create = () => new DomainImpl(ctx, spec, unit, new Map([['rows', new Map<string, unknown>()]]), { order: [] }, () => {})
  return { create, changed, medium: () => medium }
}

describe('atomic domain snapshots', () => {
  it('refreshes stale owners and commits concurrent updates without overwriting records', async () => {
    const b = bench()
    const a = b.create()
    const second = b.create()
    await Promise.all([a, second].map(domain => domain.atomic(async (fresh) => {
      const table = fresh.table('rows')
      const prior = table.get('counter') as { count: number } | undefined
      await table.put('counter', { count: (prior?.count ?? 0) + 1 })
    })))
    expect(b.medium().tables.rows.counter).toEqual({ count: 2 })
    await a.atomic(async () => {})
    expect(a.table('rows').get('counter')).toEqual({ count: 2 })
    const count = b.changed.mock.calls.length
    await a.atomic(async () => {})
    expect(b.changed).toHaveBeenCalledTimes(count)
  })

  it('keeps cache and medium unchanged and publishes nothing when an operation rolls back', async () => {
    const b = bench()
    const domain = b.create()
    await expect(domain.atomic(async (fresh) => {
      await fresh.table('rows').put('bad', { count: 1 })
      await fresh.global.set({ order: ['bad'] })
      throw new Error('operation failed')
    })).rejects.toThrow('operation failed')
    expect(domain.table('rows').size).toBe(0)
    expect(b.medium().global.order).toEqual([])
    expect(b.changed).not.toHaveBeenCalled()
  })

  it('publishes final values once and preserves stable table handles', async () => {
    const b = bench()
    const domain = b.create()
    const table = domain.table('rows')
    await domain.atomic(async (fresh) => {
      await fresh.global.set({ order: ['intermediate'] })
      await fresh.table('rows').put('record', { count: 2 })
      await fresh.global.set({ order: ['record'] })
    })
    expect(domain.table('rows')).toBe(table)
    expect(table.get('record')).toEqual({ count: 2 })
    expect(b.changed.mock.calls.map(([change]) => change.operation === 'put' ? change.value : undefined))
      .toEqual([{ count: 2 }, { order: ['record'] }])
    await domain.atomic(async (fresh) => { await fresh.table('rows').delete('record') })
    expect(table.get('record')).toBeUndefined()
    expect(b.changed).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'deleted', key: 'record' }))
  })

  it('rejects a backend without transactions before invoking the operation', async () => {
    const unit = { close: async () => {} } as KvUnit
    const domain = new DomainImpl(new Context(), spec, unit, new Map(), { order: [] }, () => {})
    const operation = vi.fn()
    await expect(domain.atomic(operation)).rejects.toMatchObject({ code: 'facet-unsupported' })
    expect(operation).not.toHaveBeenCalled()
  })

  it('rejects a provider that returns without creating its transaction snapshot', async () => {
    const unit = { transaction: async () => undefined } as unknown as KvUnit
    const domain = new DomainImpl(new Context(), spec, unit, new Map(), { order: [] }, () => {})
    await expect(domain.atomic(async () => {})).rejects.toThrow('without a snapshot')
  })
})

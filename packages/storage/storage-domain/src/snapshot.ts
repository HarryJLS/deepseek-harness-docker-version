/** Schema-validated snapshots shared by domain opening and atomic refresh. */

import type { KvUnit } from '@deepseek-ai/dsh-storage'
import type { DomainSpec } from './spec.ts'
import { DomainError } from './error.ts'

/**
 * Read and validate one complete domain without publishing partial state.
 * @param spec - declared table and global schemas.
 * @param unit - ordinary or transaction-scoped backend reader.
 * @param reportInvalidRecord - reports an invalid record after its backup succeeds.
 * @returns detached validated tables and global value.
 */
export async function loadDomainSnapshot(spec: DomainSpec, unit: KvUnit, reportInvalidRecord: (message: string) => void): Promise<{
  tables: Map<string, Map<string, unknown>>
  globalValue: unknown
}> {
  const snapshot = await unit.loadAll()
  const tables = new Map<string, Map<string, unknown>>()
  for (const [table, definition] of Object.entries(spec.tables)) {
    const records = new Map<string, unknown>()
    for (const [key, raw] of Object.entries(snapshot.tables[table] ?? {})) {
      let parsed: unknown
      try {
        parsed = parseRecord(spec.name, table, key, () => definition.valueSchema.parse(raw))
      } catch (error) {
        if (spec.invalidRecords !== 'backup-and-skip' || unit.backupRecord === undefined) throw error
        const moved = await unit.backupRecord(table, key)
        reportInvalidRecord(
          `domain '${spec.name}': stored record '${key}' in table '${table}' failed schema validation; `
          + `moved to '${moved}' and treated as absent. Cause: ${String((error as DomainError).cause)}`,
        )
        continue
      }
      records.set(key, parsed)
    }
    tables.set(table, records)
  }
  const global = spec.global
  const globalValue = global === undefined ? undefined : snapshot.global === null
    ? global.initial
    : parseRecord(spec.name, '', '', () => global.schema.parse(snapshot.global))
  return { tables, globalValue }
}

function parseRecord<T>(domain: string, table: string, key: string, parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    const slot = table === '' ? 'global' : `record '${key}' in table '${table}'`
    throw new DomainError('invalid-record', `domain '${domain}': stored ${slot} does not match its schema`, {
      detail: { table, key }, cause: error,
    })
  }
}

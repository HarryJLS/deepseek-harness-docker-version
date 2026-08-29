/**
 * Document parsing and the environment-over-store precedence — the two places
 * where a mistake in this provider is silent rather than loud. A malformed
 * half that quietly empties every credential, or a write that appears to
 * succeed under a shadowing environment variable, both look like working
 * software until an operation fails somewhere else.
 */

import { describe, expect, it } from 'vitest'
import { parseDocument } from '../src/index.ts'

describe('parseDocument', () => {
  it('treats an absent or blank entry as an empty document', () => {
    for (const content of [undefined, '', '   \n  ']) {
      expect(parseDocument(content)).toEqual({ refs: {}, records: {} })
    }
  })

  it('reads both sections', () => {
    const document = parseDocument([
      'refs:',
      '  DEEPSEEK_API_KEY: sk-live',
      'records:',
      '  client-connection/browser-session:',
      '    kind: grant',
      '    payload:',
      '      version: 1',
    ].join('\n'))
    expect(document.refs).toEqual({ DEEPSEEK_API_KEY: 'sk-live' })
    expect(document.records['client-connection/browser-session']).toEqual({
      kind: 'grant',
      payload: { version: 1 },
    })
  })

  it('keeps a well-formed half when the other half is malformed', () => {
    // Failing the whole document over one bad section would drop every
    // credential the other section holds.
    const document = parseDocument('refs:\n  KEY: value\nrecords: not-a-mapping\n')
    expect(document.refs).toEqual({ KEY: 'value' })
    expect(document.records).toEqual({})
  })

  it('treats a list section as empty rather than indexing it by number', () => {
    expect(parseDocument('refs:\n  - one\n  - two\n').refs).toEqual({})
  })

  it('rejects a document that is not a mapping', () => {
    // Silently returning an empty document here would reset every namespace on
    // the next write; the operator must see the entry is wrong.
    expect(() => parseDocument('- a\n- b\n')).toThrow(/must be a YAML mapping/u)
    expect(() => parseDocument('just a string\n')).toThrow(/must be a YAML mapping/u)
  })

  it('reads a null document as empty', () => {
    expect(parseDocument('~\n')).toEqual({ refs: {}, records: {} })
  })
})

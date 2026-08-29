/**
 * Settings-document parsing.
 *
 * The provider hands whatever it parses straight to the settings seam, which
 * resolves every namespace from it. A document that parsed to the wrong shape
 * would therefore not fail here — it would quietly reset every namespace to
 * its defaults on the next commit, which is why the mapping check is loud.
 */

import { describe, expect, it } from 'vitest'
import { parseDocument } from '../src/index.ts'

describe('parseDocument', () => {
  it('treats an absent or blank entry as an empty document', () => {
    for (const content of [undefined, '', '  \n\n ']) {
      expect(parseDocument(content)).toEqual({})
    }
  })

  it('reads namespace sections verbatim', () => {
    const document = parseDocument([
      'agent-default-model:',
      '  provider: deepseek-official',
      '  model: deepseek-v4-flash',
      'llm-pi-ai:',
      '  profiles: []',
    ].join('\n'))
    expect(document).toEqual({
      'agent-default-model': { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      'llm-pi-ai': { profiles: [] },
    })
  })

  it('reads an explicit null document as empty', () => {
    expect(parseDocument('~\n')).toEqual({})
  })

  it('refuses a document that is not a mapping of sections', () => {
    // Returning {} here would look identical to "no settings yet" and silently
    // discard whatever the operator actually wrote.
    expect(() => parseDocument('- one\n- two\n')).toThrow(/must be a YAML mapping/u)
    expect(() => parseDocument('a scalar\n')).toThrow(/must be a YAML mapping/u)
  })

  it('propagates a YAML syntax error rather than reporting an empty document', () => {
    expect(() => parseDocument('key: [unclosed\n')).toThrow()
  })
})

/** Deterministic filesystem cleanup after an image tool result has been recorded. */

import { unlinkSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-session'

export const name = 'snapshot-expire-temporary-image'
export const inject = ['attachments']

export function apply(ctx: Context): void {
  const remove = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'tool-result') remove(block.content)
      if (block.type === 'image') {
        const path = ctx.attachments.imageHostPath(block.attachment)
        if (path === undefined) throw new Error('snapshot requires a local temporary image')
        unlinkSync(path)
      }
    }
  }
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/result' && event.surfaceOp === 'append') remove(event.data.message.content)
  })
}

/** Log missing temporary images as path-only replacements before another model request. */

import { stat } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { assertNever, type ContentBlock, type Message } from '@deepseek-ai/dsh-llm'
import type { SurfaceEvent } from '@deepseek-ai/dsh-session'
import { DEFAULT_USER_ID, withUser } from '@deepseek-ai/dsh-user-context'

/**
 * Keep temporary-file disappearance reconstructable from the session log.
 * @param ctx - attachment provider context; registrations unwind with the provider.
 * @param hostPath - authorized location resolver for this temporary store.
 */
export function installTemporaryImageContext(
  ctx: Context,
  hostPath: (ref: ImageAttachmentRef) => string,
): void {
  ctx.inject(['agents'], (agentCtx) => {
    agentCtx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      return withUser(agent.session.header.userId ?? DEFAULT_USER_ID, async () => {
        const missing = new Map<string, Promise<boolean>>()
        const isMissing = (ref: ImageAttachmentRef): Promise<boolean> => {
          const path = hostPath(ref)
          let check = missing.get(path)
          if (check === undefined) {
            check = stat(path).then(() => false, (error: unknown) => {
              if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true
              throw error
            })
            missing.set(path, check)
          }
          return check
        }
        const content = async (blocks: ContentBlock[]): Promise<ContentBlock[]> => {
          let changed = false
          const result: ContentBlock[] = []
          for (const block of blocks) {
            signal.throwIfAborted()
            if (block.type === 'image' && await isMissing(block.attachment)) {
              const ref = block.attachment
              const path = ref.temporaryPath ?? relative(process.cwd(), hostPath(ref)).split(sep).join('/')
              result.push({
                type: 'text',
                text: `[Temporary image unavailable: ${JSON.stringify(path)}`
                  + `${ref.name === undefined ? '' : `; filename ${JSON.stringify(ref.name)}`}. Attach the file again to inspect it.]`,
              })
              changed = true
            } else if (block.type === 'tool-result') {
              const nested = await content(block.content)
              result.push(nested === block.content ? block : { ...block, content: nested })
              changed ||= nested !== block.content
            } else {
              result.push(block)
            }
          }
          return changed ? result : blocks
        }
        const message = async <T extends Message>(value: T): Promise<T> => {
          const rewritten = await content(value.content)
          return rewritten === value.content ? value : { ...value, content: rewritten }
        }
        const embeddedMessage = async <T extends { message: Message }>(value: T): Promise<T> => {
          const rewritten = await message(value.message)
          return rewritten === value.message ? value : { ...value, message: rewritten }
        }
        const { session } = agent
        const history = session.events
        for (const seq of [...session.surface.nodes]) {
          const event = history[seq] as SurfaceEvent
          const intent = {
            surfaceOp: { op: 'replace' as const, start: seq, end: seq },
            sourceEventSeqs: [seq],
          }
          switch (event.type) {
            case 'user/message': {
              const rewritten = await message(event.data)
              signal.throwIfAborted()
              if (rewritten !== event.data) session.append(event.type, rewritten, intent)
              break
            }
            case 'assistant/message':
            case 'tool/result': {
              const rewritten = await embeddedMessage(event.data)
              signal.throwIfAborted()
              if (rewritten !== event.data) session.append(event.type, rewritten, intent)
              break
            }
            /* v8 ignore next 2 -- SessionSurface contains only the closed set of message-producing events. */
            default:
              assertNever(event, 'temporary attachment surface')
          }
        }
        const decision = await next()
        if (decision.kind === 'reject') return decision
        const messages = []
        for (const incoming of decision.messages) messages.push(await message(incoming))
        signal.throwIfAborted()
        return { ...decision, messages }
      })
    })
  })
}

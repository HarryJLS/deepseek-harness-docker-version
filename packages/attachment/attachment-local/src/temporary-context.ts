/** Log missing temporary images as path-only replacements before another model request. */

import { stat } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Session, SurfaceEvent } from '@deepseek-ai/dsh-session'
import { DEFAULT_USER_ID, withUser } from '@deepseek-ai/dsh-user-context'

/** Keep available media usable beside the exact quoted history, without duplicating ordinary text. */
function retainedMedia(blocks: readonly ContentBlock[]): ContentBlock[] {
  return blocks.flatMap((block): ContentBlock[] => {
    if (block.type === 'image' || block.type === 'file') return [block]
    return block.type === 'tool-result' ? retainedMedia(block.content) : []
  })
}

/** A quoted tool exchange must include every result of its assistant's calls. */
function assistantGroupEnd(session: Session, nodes: readonly SurfaceEvent[], start: number): number {
  const event = nodes[start]
  if (event?.type !== 'assistant/message') throw new Error('temporary attachment: expected an assistant history node')
  const pending = new Set(event.data.message.content.flatMap(block => block.type === 'tool-call' ? [block.id] : []))
  let end = start
  while (pending.size > 0 && end + 1 < nodes.length) {
    const next = nodes[++end] as SurfaceEvent
    const message = session.deriveEventMessage(next)
    for (const block of message?.content ?? []) {
      if (block.type === 'tool-result') pending.delete(block.toolCallId)
    }
  }
  if (pending.size > 0) throw new Error('temporary attachment: cannot replace an unfinished assistant tool exchange')
  return end
}

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
        const nodes = session.surface.nodes.map(seq => session.eventAt(seq) as SurfaceEvent)
        for (let index = 0; index < nodes.length; index++) {
          const event = nodes[index] as SurfaceEvent
          const seq = event.seq
          const intent = {
            surfaceOp: { op: 'replace' as const, startSeq: seq, endSeq: seq },
            sourceEventSeqs: [seq],
          }
          switch (event.type) {
            case 'user/message': {
              const rewritten = await message(event.data)
              signal.throwIfAborted()
              if (rewritten !== event.data) session.append(event.type, rewritten, intent)
              break
            }
            case 'assistant/message': {
              const rewritten = await embeddedMessage(event.data)
              signal.throwIfAborted()
              if (rewritten === event.data) break
              // V3 assistant records are immutable model settlements. Quote the
              // complete tool exchange as plugin context, preserving the source
              // records and keeping orphaned tool results out of model history.
              const end = assistantGroupEnd(session, nodes, index)
              const group = nodes.slice(index, end + 1)
              const messages: Message[] = []
              for (const item of group) {
                const original = session.deriveEventMessage(item)
                if (original !== null) messages.push(await message(original))
              }
              signal.throwIfAborted()
              const summary = 'Temporary images in prior assistant output are unavailable.'
              session.append('user/message', createUserMessage({
                content: [
                  { type: 'text', text: `${summary}\n\nRecorded history with missing images replaced by their paths:\n${JSON.stringify(messages)}` },
                  ...messages.flatMap(value => retainedMedia(value.content)),
                ],
                source: { kind: 'plugin', plugin: 'attachment-local', form: 'notice', summary },
              }), {
                surfaceOp: { op: 'replace', startSeq: seq, endSeq: (nodes[end] as SurfaceEvent).seq },
                sourceEventSeqs: group.map(item => item.seq),
              })
              index = end
              break
            }
            case 'tool/result': {
              const rewritten = await embeddedMessage(event.data)
              signal.throwIfAborted()
              if (rewritten !== event.data) session.append(event.type, rewritten, intent)
              break
            }
            case 'system/message':
              break
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

/** Host receipt persistence for deployments whose requests can reach different replicas. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { FileUploadReceiptId } from './types.ts'

/** Physical Session incarnation admitted before an upload consumes bytes. */
export type FileUploadGeneration = Branded<'FileUploadGeneration'>

/** Optional Host storage for completed upload receipts; binary data stays with attachments. */
export interface SharedFileUploadStore {
  /**
   * Authorize the requested Session without activating its Agent.
   * @param sessionId - receiving Session.
   * @returns its physical incarnation, or undefined for a missing or inaccessible Session.
   * @throws storage failures other than an authorization miss.
   */
  authorize(sessionId: SessionId): Promise<FileUploadGeneration | undefined>
  /**
   * Publish one immutable receipt after byte storage succeeds.
   * @param sessionId - receiving Session.
   * @param generation - physical incarnation admitted before byte intake.
   * @param receiptId - randomly minted receipt identity.
   * @param file - reference to the already stored file, never its bytes.
   */
  save(sessionId: SessionId, generation: FileUploadGeneration, receiptId: FileUploadReceiptId, file: FileAttachmentRef): Promise<void>
  /**
   * Read an unexpired receipt and recheck its Session owner and incarnation.
   * @param sessionId - receiving Session.
   * @param receiptId - receipt presented by the caller.
   * @returns the file reference, or undefined for an unknown, expired, or foreign receipt.
   */
  read(sessionId: SessionId, receiptId: FileUploadReceiptId): Promise<FileAttachmentRef | undefined>
}

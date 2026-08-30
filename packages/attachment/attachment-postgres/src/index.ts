/**
 * PostgreSQL attachment store.
 *
 * Normalized image bytes are the source of truth an agent's history depends
 * on: a message that references an attachment the store cannot produce is a
 * broken conversation, not a degraded one. A container with no writable volume
 * therefore keeps them in the database, content-addressed by the same
 * `sha256:` reference the session log records — which makes deduplication a
 * primary-key conflict rather than logic this module has to own.
 *
 * The derived model-request variants stay on the container's own filesystem on
 * purpose. A variant is a deterministic function of (reference, route policy),
 * so a replaced container regenerates exactly the same bytes; persisting them
 * would spend database space and write bandwidth on a cache that costs nothing
 * to rebuild. Only what cannot be recomputed is made durable.
 *
 * Image inspection, normalization, and the request ladder are reused verbatim
 * from `@deepseek-ai/dsh-attachment-local`; only the object medium differs.
 *
 * @module @deepseek-ai/dsh-attachment-postgres
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import pg from 'pg'
import { AttachmentError, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  ensureSchema,
  postgresConnectionSchema,
  resolvePostgresPool,
  resolvePostgresSchema,
  tablesPresent,
} from '@deepseek-ai/dsh-postgres-schema'
import type { PostgresConnectionConfig } from '@deepseek-ai/dsh-postgres-schema'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestPolicy,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGE_DIMENSION,
  DEFAULT_MAX_IMAGE_PIXELS,
  DEFAULT_MAX_IMAGES_PER_MESSAGE,
  DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
  DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
  DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
  DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS,
  prepareImageFile,
  readRequestImageFile,
  validateImageFile,
  type NormalizationPolicy,
} from '@deepseek-ai/dsh-attachment-local'

/** Object table owned by this store, unqualified. */
const OBJECT_TABLE = 'attachment_object'

/** Accepted image media types, matching the local provider's default policy. */
const DEFAULT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** Plugin config: the database plus the deployment's image policy. */
export interface Config extends PostgresConnectionConfig {
  /** Largest accepted encoded image. */
  maxImageBytes?: number
  /** Largest accepted image count in one message. */
  maxImagesPerMessage?: number
  /** Largest accepted aggregate encoded bytes in one message. */
  maxMessageImageBytes?: number
  /** Largest accepted decoded pixel count. */
  maxImagePixels?: number
  /** Largest accepted decoded long edge. */
  maxImageDimension?: number
  /** Total-pixel budget of the stored normalized image. */
  normalizedImageMaxPixels?: number
  /** Long-edge cap of the stored normalized image. */
  normalizedImageMaxDimension?: number
  /** Encoded-byte target of the stored normalized image; the quality ladder aims at it. */
  normalizedImageMaxBytes?: number
}

/**
 * Extract the bare digest from a content-addressed reference.
 * @param ref - the durable reference recorded in the session log.
 * @returns the lowercase hex digest.
 */
function digestOf(ref: ImageAttachmentRef): string {
  const id = String(ref.attachmentId)
  if (!id.startsWith('sha256:')) {
    throw new AttachmentError('Attachment reference is not content-addressed.', 'ATTACHMENT_CORRUPT')
  }
  return id.slice('sha256:'.length)
}

/** PostgreSQL-backed attachment store. */
export class PostgresAttachmentStore extends AttachmentStore {
  static Config: z<Config> = z.object({
    ...postgresConnectionSchema,
    maxImageBytes: z.natural().min(1).default(DEFAULT_MAX_IMAGE_BYTES),
    maxImagesPerMessage: z.natural().min(1).default(DEFAULT_MAX_IMAGES_PER_MESSAGE),
    maxMessageImageBytes: z.natural().min(1).default(DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
    maxImagePixels: z.natural().min(1).default(DEFAULT_MAX_IMAGE_PIXELS),
    maxImageDimension: z.natural().min(1).default(DEFAULT_MAX_IMAGE_DIMENSION),
    normalizedImageMaxPixels: z.natural().min(1).default(DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS),
    normalizedImageMaxDimension: z.natural().min(1).default(DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION),
    normalizedImageMaxBytes: z.natural().min(1).default(DEFAULT_NORMALIZED_IMAGE_MAX_BYTES),
  })

  readonly imageLimits: ImageAttachmentLimits
  private readonly normalizationPolicy: NormalizationPolicy
  private readonly pool: pg.Pool
  private readonly schema: string
  /** Container-local root for the deterministic request-variant cache. */
  private variantRoot = ''

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.schema = resolvePostgresSchema(config)
    this.imageLimits = {
      maxImageBytes: config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      maxImagesPerMessage: config.maxImagesPerMessage ?? DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: config.maxMessageImageBytes ?? DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxImagePixels: config.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS,
      maxImageDimension: config.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION,
      mediaTypes: [...DEFAULT_MEDIA_TYPES],
    }
    this.normalizationPolicy = {
      maxPixels: config.normalizedImageMaxPixels ?? DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS,
      maxDimension: config.normalizedImageMaxDimension ?? DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
      maxBytes: config.normalizedImageMaxBytes ?? DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
    }
    this.pool = new pg.Pool(resolvePostgresPool(config))
  }

  /** Create the object table and the container-local variant cache root. */
  protected async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    // A production role often holds no DDL rights, and `IF NOT EXISTS` does not
    // exempt a statement from the privilege check; a table already there means
    // there is nothing to create.
    if (!await tablesPresent(this.pool, this.schema, [OBJECT_TABLE])) {
      await ensureSchema(this.pool, this.schema)
      await this.pool.query(
        `CREATE TABLE IF NOT EXISTS "${this.schema}"."${OBJECT_TABLE}" (
           sha256     text  PRIMARY KEY,
           media_type text  NOT NULL,
           bytes      integer NOT NULL,
           width      integer NOT NULL,
           height     integer NOT NULL,
           data       bytea NOT NULL,
           created_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
    }
    this.variantRoot = await mkdtemp(join(tmpdir(), 'dsh-attachment-'))
    yield async () => { await this.pool.end() }
  }

  /** Validate one image without persisting it, using the shared admission path. */
  async validateImage(input: SaveImageAttachment): Promise<void> {
    await validateImageFile(input, this.imageLimits, this.normalizationPolicy)
  }

  /**
   * Normalize and durably commit one image. The reference is the digest of the
   * normalized bytes, so an identical image committed twice conflicts on the
   * primary key and the existing row stands.
   */
  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const prepared = await prepareImageFile(input, this.imageLimits, this.normalizationPolicy)
    const ref = prepared.ref
    await this.pool.query(
      `INSERT INTO "${this.schema}"."${OBJECT_TABLE}"
         (sha256, media_type, bytes, width, height, data)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sha256) DO NOTHING`,
      [digestOf(ref), ref.mediaType, ref.bytes, ref.width, ref.height, Buffer.from(prepared.data)],
    )
    return ref
  }

  /**
   * Read one image and verify it still matches the recorded reference. The
   * stored row is verified against the reference the session log carries, so a
   * mismatch surfaces as corruption rather than silently reaching a model.
   */
  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    const result = await this.pool.query<{
      media_type: string
      bytes: number
      width: number
      height: number
      data: Buffer
    }>(
      `SELECT media_type, bytes, width, height, data
       FROM "${this.schema}"."${OBJECT_TABLE}" WHERE sha256 = $1`,
      [digestOf(ref)],
    )
    signal?.throwIfAborted()
    const row = result.rows[0]
    if (row === undefined) {
      throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    }
    if (row.media_type !== ref.mediaType || row.bytes !== ref.bytes
      || row.width !== ref.width || row.height !== ref.height
      || row.data.byteLength !== ref.bytes) {
      throw new AttachmentError(
        'Stored attachment metadata does not match its reference.',
        'ATTACHMENT_CORRUPT',
      )
    }
    return { ref, data: new Uint8Array(row.data) }
  }

  /**
   * Derive one model-request version. The ladder and its cache come from the
   * local provider; the cache root is this container's own temporary directory
   * because every variant is recomputable from the durable original.
   */
  override async readImageRequest(
    ref: ImageAttachmentRef,
    policy: ImageRequestPolicy,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    signal?.throwIfAborted()
    const stored = await this.readImage(ref, signal)
    return readRequestImageFile(this.variantRoot, stored, policy, signal)
  }
}

/** Stable Cordis plugin name. */
export const name = 'attachment-postgres'

export default PostgresAttachmentStore

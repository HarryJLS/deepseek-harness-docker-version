/** Shared audit fields and Snowflake primary keys for every MySQL-owned table. */

import { Snowflake } from '@sapphire/snowflake'
import { currentUserId, type UserId } from '@deepseek-ai/dsh-user-context'

/** Required row identity and audit columns, also included in the DBA provisioning script. */
export const MYSQL_AUDIT_DDL = `
  id           bigint      NOT NULL COMMENT '雪花主键',
  is_deleted   char(1)     NOT NULL DEFAULT 'N' COMMENT '是否删除，默认N',
  creator      varchar(32) NOT NULL COMMENT '创建者',
  gmt_created  datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  modifier     varchar(32) NOT NULL COMMENT '更新者',
  gmt_modified datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '修改时间'`

/** All audit fields are explicitly present in every INSERT. */
export const MYSQL_AUDIT_COLUMNS = 'id, is_deleted, creator, gmt_created, modifier, gmt_modified'

/** SQL values for the audit columns; parameters are the Snowflake id and two actors. */
export const MYSQL_AUDIT_VALUES = "?, 'N', ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP"

/** Upserts preserve identity and creation provenance, and revive deleted values. */
export const MYSQL_AUDIT_UPDATE = "is_deleted = 'N', modifier = VALUES(modifier), gmt_modified = CURRENT_TIMESTAMP"

/** Timestamp epoch for signed 64-bit Snowflakes (2024-01-01 UTC). */
const EPOCH = 1_704_067_200_000
const generators = new Map<number, { snowflake: Snowflake; timestamp: number; increment: bigint }>()

/**
 * Resolve the replica's Snowflake generator, shared by its database providers.
 * @param workerId - unique replica number from 0 through 1023; replicas sharing tables must differ.
 * @returns a generator emitting decimal strings so JavaScript cannot round a bigint id.
 * @throws when the replica number is invalid.
 */
export function mysqlIdGenerator(workerId: number): () => string {
  if (!Number.isInteger(workerId) || workerId < 0 || workerId > 1023) {
    throw new Error('mysql snowflakeWorkerId must be an integer from 0 through 1023')
  }
  let generator = generators.get(workerId)
  if (generator === undefined) {
    generator = { snowflake: new Snowflake(EPOCH), timestamp: 0, increment: 0n }
    generators.set(workerId, generator)
  }
  const state = generator
  return () => {
    const timestamp = Math.max(Date.now(), state.timestamp)
    state.increment = timestamp === state.timestamp ? state.increment + 1n : 0n
    state.timestamp = timestamp
    // Exhausting one millisecond advances the logical clock instead of reusing a sequence.
    if (state.increment > 4095n) {
      state.timestamp += 1
      state.increment = 0n
    }
    return state.snowflake.generate({
      timestamp: state.timestamp, increment: state.increment,
      workerId: BigInt(workerId >> 5), processId: BigInt(workerId & 31),
    }).toString()
  }
}

/**
 * Bind a new row's primary key and creation/update actors.
 * @param nextId - resolved replica Snowflake generator.
 * @param actor - durable owner for deferred session writes, otherwise the current request user.
 * @returns parameters for {@link MYSQL_AUDIT_VALUES}.
 */
export function mysqlAuditValues(nextId: () => string, actor: UserId = currentUserId()): string[] {
  return [nextId(), actor, actor]
}

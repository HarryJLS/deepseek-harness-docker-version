/** Real Docker profile, Nacos, and OceanBase behavior across two replaceable application processes. */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import mysql from 'mysql2/promise'
import { chromium, type Browser, type Page } from 'playwright'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { newEnglishPage, writeComposerDraft } from '../../../../web/tests/support.ts'

const image = process.env.DSH_DOCKER_TEST_IMAGE
const docker = process.env.DSH_TEST_DOCKER_BIN ?? 'docker'
const root = resolve(import.meta.dirname, '../../../../..')
const composeFile = join(import.meta.dirname, 'compose.yml')
const project = `dsh-v3-${randomUUID().slice(0, 8)}`
const artifacts = join(root, '.artifacts', project)
const app = 'docker-upgrade-verification'
const uploadPath = '/api/session/uploadFileBinary'
const filename = 'replica-receipt.txt'
const prompt = 'Receive the shared file.'
const eventSchema = z.looseObject({ type: z.string(), data: z.record(z.string(), z.unknown()) })
const receiptSchema = z.object({
  sessionId: z.string(),
  generation: z.string(),
  file: z.record(z.string(), z.unknown()),
})

describe.skipIf(image === undefined)('Docker cross-replica Session V3', () => {
  let browser: Browser | undefined
  let database: mysql.Pool | undefined
  let primary: Page | undefined
  let observer: Page | undefined
  let primaryUrl = ''
  let observerUrl = ''
  let modelUrl = ''
  let archive: unknown
  let definitions: unknown
  const pageErrors: string[] = []

  async function compose(args: string[], timeout = 120000): Promise<string> {
    const result = await execa(docker, ['compose', '--project-name', project, '--file', composeFile, ...args], {
      env: { DSH_DOCKER_TEST_IMAGE: image },
      timeout,
    })
    return result.stdout.trim()
  }

  async function published(service: string, port: number): Promise<string> {
    const address = new URL(`http://${await compose(['port', service, String(port)])}`)
    if (address.hostname !== '127.0.0.1' || address.port === '') throw new Error(`Unexpected test listener: ${address.href}`)
    return address.origin
  }

  async function page(url: string, owner = 'alice', welcome = false): Promise<Page> {
    if (browser === undefined) throw new Error('Test browser is unavailable')
    const result = await newEnglishPage(browser)
    await result.context().addCookies([{ name: 'dsh_test_user', value: owner, url }])
    result.on('pageerror', error => pageErrors.push(error.message))
    await result.goto(url, { waitUntil: 'load' })
    if (welcome) {
      const notice = result.getByRole('dialog', { name: 'Internal Testing Notice' })
      await notice.waitFor({ timeout: 30000 })
      await notice.getByRole('button', { name: 'Continue', exact: true }).click()
      await notice.waitFor({ state: 'hidden', timeout: 30000 })
    }
    return result
  }

  async function workspace(target: Page, existing = false): Promise<void> {
    await target.getByRole('textbox', { name: 'Choose workspace' }).click()
    if (existing) {
      await target.getByRole('menuitem', { name: 'workspace', exact: true }).click()
    } else {
      const dialog = target.getByRole('dialog', { name: 'Select Workspace Directory' })
      await dialog.waitFor({ timeout: 30000 })
      await dialog.getByRole('button', { name: 'Edit path' }).click()
      const path = dialog.getByRole('textbox', { name: 'Edit path' })
      await path.fill('/workspace')
      await path.press('Enter')
      await dialog.getByRole('button', { name: 'Open', exact: true }).click()
    }
    await target.locator('[data-composer-input][contenteditable="true"]').waitFor({ timeout: 30000 })
  }

  function storedSessionRows(target: Page) {
    return target.getByRole('treeitem').filter({
      has: target.locator('button[aria-label^="Session actions for "]'),
    })
  }

  async function selectStoredSession(target: Page): Promise<void> {
    await expect.poll(async () => {
      const collapsed = target.locator('[role="treeitem"][aria-expanded="false"]')
      if (await collapsed.count() === 0) return true
      await collapsed.first().click()
      return false
    }, { timeout: 10000 }).toBe(true)
    const rows = storedSessionRows(target)
    await expect.poll(() => rows.count(), { timeout: 30000 }).toBe(1)
    await rows.first().click()
  }

  async function events(id: string): Promise<Array<z.infer<typeof eventSchema>>> {
    if (database === undefined) throw new Error('Test database is unavailable')
    const [rows] = await database.query<mysql.RowDataPacket[]>(
      'SELECT event FROM dsh_session_event WHERE app = ? AND session_id = ? ORDER BY seq',
      [app, id],
    )
    return z.array(eventSchema).parse(rows.map(row => row.event as unknown))
  }

  async function receipts(id: string) {
    if (database === undefined) throw new Error('Test database is unavailable')
    const [rows] = await database.query<mysql.RowDataPacket[]>(
      "SELECT key_name, value FROM dsh_kv_record WHERE app = ? AND unit = 'dsh-file-upload' AND tbl = 'receipts' AND is_deleted = 'N'",
      [app],
    )
    return rows.map(row => ({
      receiptId: z.string().parse(row.key_name as unknown),
      ...receiptSchema.parse(row.value as unknown),
    })).filter(value => value.sessionId === id)
  }

  async function archivedRows(): Promise<unknown> {
    if (database === undefined) throw new Error('Test database is unavailable')
    const result: unknown[] = []
    for (const table of ['dsh_session', 'dsh_session_event', 'dsh_kv_global']) {
      const [rows] = await database.query(`SELECT * FROM \`${table}\` WHERE app = 'archive-v0' ORDER BY id`)
      result.push(rows)
    }
    return result
  }

  async function tableDefinitions(): Promise<unknown> {
    if (database === undefined) throw new Error('Test database is unavailable')
    const result: unknown[] = []
    for (const table of ['dsh_session', 'dsh_session_event', 'dsh_kv_unit', 'dsh_kv_record', 'dsh_kv_global', 'dsh_attachment_object']) {
      const [rows] = await database.query(`SHOW CREATE TABLE \`${table}\``)
      result.push(rows)
    }
    return result
  }

  async function control(): Promise<unknown> {
    const response = await fetch(`${modelUrl}/control/status`, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(`Model control returned HTTP ${response.status}`)
    return response.json() as Promise<unknown>
  }

  beforeAll(async () => {
    await mkdir(artifacts, { recursive: true })
    await compose(['up', '--detach', '--wait', '--wait-timeout', '600', 'database', 'redis', 'nacos', 'model'], 660000)
    await compose(['run', '--rm', '--no-deps', 'configure'])
    const address = new URL(await published('database', 2881))
    database = mysql.createPool({
      host: address.hostname, port: Number(address.port), user: 'root@test', password: 'dsh-test-only',
      database: 'dsh', supportBigNumbers: true, bigNumberStrings: true,
    })
    archive = await archivedRows()
    definitions = await tableDefinitions()
    await compose(['up', '--detach', '--no-deps', '--wait', '--wait-timeout', '180', 'a', 'b'], 210000)
    await compose(['up', '--detach', '--no-deps', '--wait', 'proxy'])
    primaryUrl = await published('proxy', 80)
    observerUrl = await published('proxy', 81)
    modelUrl = await published('model', 3081)
    browser = await chromium.launch()
    primary = await page(primaryUrl, 'alice', true)
    await workspace(primary)
  }, 960000)

  afterAll(async () => {
    const failures: unknown[] = []
    for (const operation of [
      async () => {
        if (database === undefined) return
        const captured: Record<string, unknown> = {}
        for (const table of ['dsh_session', 'dsh_session_event', 'dsh_kv_record']) {
          const [rows] = await database.query({ sql: `SELECT * FROM \`${table}\` WHERE app = ? ORDER BY id`, timeout: 5000 }, [app])
          captured[table] = rows
        }
        await writeFile(join(artifacts, 'database.json'), JSON.stringify(captured, null, 2))
      },
      async () => {
        if (modelUrl !== '') await writeFile(join(artifacts, 'model.json'), JSON.stringify(await control(), null, 2))
      },
      async () => {
        const pages = browser?.contexts().flatMap(context => context.pages()) ?? []
        for (const [index, target] of pages.entries()) {
          await target.screenshot({ path: join(artifacts, `page-${index}.png`), fullPage: true })
          await writeFile(join(artifacts, `page-${index}.txt`), await target.locator('body').ariaSnapshot())
        }
      },
      async () => { await browser?.close() },
      async () => { await database?.end() },
      async () => {
        if (await compose(['ps', '--all', '--quiet', 'database']) === '') return
        await compose(['cp', 'database:/root/.obd/log', join(artifacts, 'oceanbase-deployer')])
      },
      async () => { await writeFile(join(artifacts, 'containers.log'), await compose(['logs', '--no-color'])) },
      async () => { await compose(['down', '--volumes', '--remove-orphans', '--timeout', '10'], 180000) },
    ]) {
      try { await operation() }
      catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Docker verification cleanup failed')
  }, 240000)

  it('shares upload receipts and live streams, preserves questions across replacement, and keeps archived rows untouched', {
    timeout: 240000, retry: 0,
  }, async () => {
    if (primary === undefined || database === undefined) throw new Error('Docker profile did not start')
    const sender = primary
    onTestFailed(async () => {
      await sender.screenshot({ path: join(artifacts, 'sender-failure.png'), fullPage: true })
      await observer?.screenshot({ path: join(artifacts, 'observer-failure.png'), fullPage: true })
    })
    const uploaded = sender.waitForResponse(response => new URL(response.url()).pathname === uploadPath)
    await sender.locator('input[type="file"]').setInputFiles({
      name: filename, mimeType: 'text/plain', buffer: Buffer.from('shared temporary upload\n'),
    })
    const response = await uploaded
    expect(response.headers()['x-dsh-test-replica']).toBe('a')
    const id = new URL(response.url()).searchParams.get('sessionId')
    if (id === null || id === '') throw new Error('The upload did not address a Session')
    await expect.poll(() => receipts(id), { timeout: 15000 }).toHaveLength(1)
    const receipt = (await receipts(id))[0]!
    expect(receipt.file.name).toBe(filename)
    const [owners] = await database.query<mysql.RowDataPacket[]>(
      'SELECT CAST(id AS CHAR) AS generation, user_id FROM dsh_session WHERE app = ? AND session_id = ?', [app, id],
    )
    expect(owners[0]?.user_id as unknown).toBe('alice')
    expect(owners[0]?.generation as unknown).toBe(receipt.generation)
    await sender.locator('[data-composer-input]').first().fill(prompt)
    await sender.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(control, { timeout: 30000 }).toMatchObject({ held: true, requestCount: 1 })
    expect(JSON.stringify(await control())).toContain(filename)

    observer = await page(observerUrl, 'alice', true)
    await workspace(observer, true)
    await selectStoredSession(observer)
    await observer.getByText(/REPLICA_STREAM_START/).first().waitFor({ timeout: 30000 })
    expect((await events(id)).some(event => event.type === 'assistant/message')).toBe(false)
    await observer.reload({ waitUntil: 'load' })
    await observer.getByText(/REPLICA_STREAM_START/).first().waitFor({ timeout: 30000 })
    expect((await events(id)).some(event => event.type === 'assistant/message')).toBe(false)
    const released = await fetch(`${modelUrl}/control/release`, { method: 'POST', signal: AbortSignal.timeout(5000) })
    expect(released.ok).toBe(true)
    await expect.poll(async () => (await events(id)).filter(event => event.type === 'turn/end').length, { timeout: 30000 }).toBe(1)
    await observer.getByText(/REPLICA_STREAM_DONE/).first().waitFor({ timeout: 30000 })
    expect((await events(id)).find(event => event.type === 'file-upload/consumed')?.data.receiptIds).toEqual([receipt.receiptId])

    const rejected = await fetch(response.url(), {
      method: 'POST', headers: {
        cookie: 'dsh_test_user=bob', 'x-user-id': 'alice', 'content-type': 'application/octet-stream',
      },
      body: 'foreign upload', signal: AbortSignal.timeout(10000),
    })
    expect(await rejected.json() as unknown).toMatchObject({ ok: false, error: { code: 'session/not-found' } })
    const other = await page(observerUrl, 'bob')
    await workspace(other, true)
    expect(await storedSessionRows(other).count()).toBe(0)
    await other.close()
    await compose(['exec', '-T', 'redis', 'redis-cli', 'FLUSHDB'])
    await observer.reload({ waitUntil: 'load' })
    await observer.getByText(/REPLICA_STREAM_DONE/).first().waitFor({ timeout: 30000 })

    await writeComposerDraft(sender, sender.locator('[data-composer-input]').first(),
      '/plan Prepare the replica restart verification plan.')
    await sender.getByRole('button', { name: 'Send message', exact: true }).click()
    const card = observer.locator('[data-plan-review-key]')
    await card.waitFor({ timeout: 30000 })
    await expect.poll(async () => (await events(id)).filter(event => event.type === 'turn/end').length, { timeout: 30000 }).toBe(2)
    const pending = z.object({ id: z.string(), version: z.number().int().nonnegative() })
      .parse((await events(id)).find(event => event.type === 'user-questions/state')?.data.pending)
    await compose(['stop', '--timeout', '10', 'b'])
    await compose(['rm', '--force', 'b'])
    await observer.reload({ waitUntil: 'load' })
    await card.waitFor({ timeout: 30000 })
    await observer.setViewportSize({ width: 430, height: 900 })
    await observer.getByRole('button', { name: 'Open sidebar', exact: true }).waitFor()
    await expect.poll(async () => (await card.boundingBox())?.width).toBeGreaterThan(250)
    await observer.screenshot({ path: join(artifacts, 'pending-after-replacement.png'), fullPage: true })
    await card.getByRole('button', { name: 'Approve', exact: true }).click()
    await card.waitFor({ state: 'hidden', timeout: 30000 })
    await expect.poll(async () => (await events(id)).filter(event => event.type === 'turn/end').length, { timeout: 30000 }).toBe(3)
    const states = (await events(id)).filter(event => event.type === 'user-questions/state')
    expect(states).toHaveLength(2)
    expect(states[1]?.data.decision).toMatchObject({ id: pending.id, version: pending.version, approvedPlan: true })
    expect((await events(id)).filter(event => event.type === 'turn/start')).toHaveLength(3)
    expect(await control()).toMatchObject({ requestCount: 3 })
    await compose(['up', '--detach', '--no-deps', '--wait', '--wait-timeout', '120', 'b'], 180000)
    await compose(['exec', '-T', 'proxy', 'nginx', '-s', 'reload'])
    const restored = await page(primaryUrl)
    await selectStoredSession(restored)
    await restored.getByText(/REPLICA_STREAM_DONE/).first().waitFor({ timeout: 30000 })
    expect(await restored.locator('[data-plan-review-key]').count()).toBe(0)
    await restored.screenshot({ path: join(artifacts, 'restored-on-new-replica.png'), fullPage: true })
    await restored.close()
    expect(await archivedRows()).toEqual(archive)
    expect(await tableDefinitions()).toEqual(definitions)
    expect(pageErrors).toEqual([])
  })
})

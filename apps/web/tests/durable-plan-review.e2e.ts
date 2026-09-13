/** Real Web composition: a pending review ends its turn and survives browser replacement. */
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, recordFixture,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const DIRECTORY = fileURLToPath(new URL('../../../snapshots/web/durable-plan-review', import.meta.url))
const FIXTURE = join(DIRECTORY, 'session.jsonl')
const OVERLAY = fileURLToPath(new URL('./fixtures/durable-questions.patch.yml', import.meta.url))
const MODE = webSnapshotMode()
const TASK = 'Plan a small change: add a --greeting flag to a CLI. Do not read or write files or delegate. '
  + 'Call exit_plan_mode with a short plan of at most three bullet points. '
  + 'After I approve, reply with the single word DURABLE_DONE and stop.'

describe('web e2e: durable plan review', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let errors: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY,
      ...(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 5, compareReplaySession: true }),
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    errors = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('restores the original approval card and admits one new turn after approval', async () => {
    onTestFailed(() => saveFailureShot(page, 'durable-plan-review'))
    const first = scaffold.whenTurnSettled(180000)
    const input = page.locator('[data-composer-input]').first()
    await input.fill(`/plan ${TASK}`)
    await input.press('Enter')
    const card = page.locator('[data-plan-review-key]')
    await card.waitFor({ timeout: 180000 })
    const sessionId = await first
    const agent = scaffold.ctx.agents.get(sessionId)!
    expect(agent.status).toBe('idle')
    const pending = scaffold.ctx.userQuestions.state(agent).pending!
    expect(pending).not.toBeNull()
    const plan = await card.locator('[data-plan-review-scroll]').innerText()

    await page.reload({ waitUntil: 'load' })
    await card.waitFor({ timeout: 30000 })
    expect(await card.locator('[data-plan-review-scroll]').innerText()).toBe(plan)
    await page.setViewportSize({ width: 430, height: 900 })
    await page.locator('[data-sidebar-collapsed]').waitFor({ timeout: 5000 })
    await expect.poll(async () => (await card.boundingBox())?.width ?? 0).toBeGreaterThan(280)
    for (const button of await card.getByRole('button').all()) {
      const rect = await button.boundingBox()
      expect(rect).not.toBeNull()
      expect(rect!.x).toBeGreaterThanOrEqual(0)
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(430)
    }
    await mkdir(join(REPO_ROOT, '.artifacts'), { recursive: true })
    await page.screenshot({ path: join(REPO_ROOT, '.artifacts/durable-review-mobile.png') })
    await page.setViewportSize({ width: 1680, height: 1000 })
    await expect.poll(async () => (await card.boundingBox())?.width ?? 0).toBeGreaterThan(600)
    if (MODE !== 'record') {
      await compareOrRefreshGolden(
        join(DIRECTORY, 'review.expected.md'),
        await captureStableAria(page, '[data-plan-review-key]', scaffold.workspaceCwd),
        MODE,
      )
    }
    const resumed = scaffold.whenTurnSettled(180000)
    await card.getByRole('button', { name: 'Approve', exact: true }).click()
    await card.waitFor({ state: 'hidden', timeout: 10000 })
    await resumed
    await expect.poll(() => page.getByText('DURABLE_DONE', { exact: true }).count(), { timeout: 15000 })
      .toBeGreaterThan(0)
    expect(await card.count()).toBe(0)
    const decided = scaffold.ctx.userQuestions.state(agent).decision!
    expect(decided.id).toBe(pending.id)
    expect(decided.approvedPlan).toBe(true)
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(2)
    const duplicate = await scaffold.ctx.sessionController.answerQuestion({
      sessionId, id: pending.id, version: pending.version,
      answer: { answers: [{ id: 'plan-review', selected: ['Approve'] }] },
    })
    expect(duplicate.duplicate).toBe(true)
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(2)
    if (MODE === 'record') {
      await recordFixture(scaffold, sessionId, FIXTURE)
    } else {
      await compareOrRefreshGolden(
        join(DIRECTORY, 'approved.expected.md'),
        await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd),
        MODE,
      )
    }
    expect(errors.pageErrors).toEqual([])
  }, 240000)
})

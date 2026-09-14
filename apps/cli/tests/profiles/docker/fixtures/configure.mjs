/** Publish only disposable deployment and model credentials into the test Nacos server. */

import { createRequire } from 'node:module'

const require = createRequire('/app/apps/cli/package.json')
const { dump } = await import(require.resolve('js-yaml'))
const documents = {
  'dsh-credentials.yaml': { refs: { DEEPSEEK_API_KEY: 'docker-model-test-only' }, records: {} },
  'dsh-plugin-roster.yml': { packages: [] },
}
for (const [replica, worker] of [['a', 1], ['b', 2]]) {
  documents[`settings-${replica}.yaml`] = {
    deployment: {
      appName: 'docker-upgrade-verification',
      database: {
        host: 'database', port: 2881, database: 'dsh', user: 'dsh_test@test',
        password: 'dsh-test-only', poolSize: 10, snowflakeWorkerId: worker,
      },
      redis: { host: 'redis' },
      attachments: { temporaryRoot: 'tmp/dsh-attachments' },
      execution: { leaseMs: 9000, renewIntervalMs: 1000, pollIntervalMs: 100 },
    },
    'agent-default-model': { provider: 'deepseek-official', model: 'deepseek-flash' },
    'llm-deepseek': {
      baseURL: 'http://model:3081/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
  }
}
for (const [dataId, document] of Object.entries(documents)) {
  const response = await fetch('http://nacos:8848/nacos/v1/cs/configs', {
    method: 'POST',
    body: new URLSearchParams({ dataId, group: 'DEFAULT_GROUP', type: 'yaml', content: dump(document) }),
    signal: AbortSignal.timeout(30000),
  })
  if (!response.ok || (await response.text()).trim() !== 'true') {
    throw new Error(`Cannot publish test Nacos entry ${dataId}: HTTP ${response.status}`)
  }
}
console.log('Disposable Nacos configuration is ready.')

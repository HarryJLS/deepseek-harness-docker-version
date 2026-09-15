/** Build-static first-party Session format migration catalog. */

import { sessionFormatCatalog as firstPartyCatalog } from './generated.ts'
import { withDockerSessionMetadata } from './docker.ts'

/** Installed catalog preserving validated Docker Session ownership. */
export const sessionFormatCatalog = withDockerSessionMetadata(firstPartyCatalog)
export { SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'

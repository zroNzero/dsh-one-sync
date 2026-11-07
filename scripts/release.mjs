#!/usr/bin/env node
import { releasePlugin, previewRelease, RELEASE_REPO } from '../lib/release.js'

const args = process.argv.slice(2)
const preview = args.includes('--preview')
const bumpArg = args.find((arg) => arg.startsWith('--bump='))
const bumpIndex = args.indexOf('--bump')
const bump = bumpArg
  ? bumpArg.slice('--bump='.length)
  : (bumpIndex >= 0 && args[bumpIndex + 1] && !args[bumpIndex + 1].startsWith('--')
    ? args[bumpIndex + 1]
    : 'minor')
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''

try {
  const result = preview
    ? await previewRelease({ sourceDir: process.cwd(), repo: RELEASE_REPO, bump, token })
    : await releasePlugin({ sourceDir: process.cwd(), repo: RELEASE_REPO, bump, token, confirm: true })
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(error && error.message ? error.message : String(error))
  process.exitCode = 1
}

import fs from 'node:fs'

const tag = process.argv[2] || ''
const version = tag.replace(/^v/, '')
const text = fs.readFileSync('CHANGELOG.md', 'utf8')
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const match = text.match(new RegExp(`## \\[${escaped}\\][\\s\\S]*?(?=\\n## \\[|$)`))
fs.writeFileSync('RELEASE_NOTES.md', match ? match[0] : `## [${version}]`)

const { execFileSync } = require('child_process')
const { readFileSync } = require('fs')
const { join } = require('path')

const root = process.cwd()
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function runGit(args, options = {}) {
  const output = execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  })

  return typeof output === 'string' ? output.trim() : ''
}

function hasArg(name) {
  return process.argv.includes(name)
}

function getArgValue(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return null
  }

  return process.argv[index + 1] || null
}

const tag = getArgValue('--tag') || `v${pkg.version}`
const commit = getArgValue('--commit') || 'HEAD'
const shouldPush = hasArg('--push')
const allowVersionMismatch = hasArg('--allow-version-mismatch')

if (!allowVersionMismatch && tag !== `v${pkg.version}`) {
  console.error(
    `Refusing to create ${tag}: package.json is version ${pkg.version}. ` +
      'Update the app version first or pass --allow-version-mismatch if you really mean it.'
  )
  process.exit(1)
}

try {
  runGit(['rev-parse', '--verify', `${commit}^{commit}`])
} catch (error) {
  console.error(`Commit not found: ${commit}`)
  process.exit(1)
}

try {
  runGit(['rev-parse', '--verify', `refs/tags/${tag}`])
  console.error(`Tag already exists locally: ${tag}`)
  process.exit(1)
} catch (error) {
  // The tag does not exist locally, which is what we want.
}

const remoteTag = runGit(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])
if (remoteTag) {
  console.error(`Tag already exists on origin: ${tag}`)
  process.exit(1)
}

const commitSha = runGit(['rev-parse', commit])
const subject = runGit(['log', '-1', '--format=%s', commit])

console.log(`Creating Linux release tag ${tag}`)
console.log(`Commit: ${commitSha}`)
console.log(`Subject: ${subject}`)

runGit(['tag', '-a', tag, commitSha, '-m', `Release ${tag}`], { stdio: 'inherit' })

if (shouldPush) {
  console.log(`Pushing ${tag} to origin`)
  runGit(['push', 'origin', `refs/tags/${tag}`], { stdio: 'inherit' })
  console.log('Tag pushed. GitHub Actions should build and publish the Linux release artifacts.')
} else {
  console.log(`Tag created locally. Push it with: git push origin refs/tags/${tag}`)
}

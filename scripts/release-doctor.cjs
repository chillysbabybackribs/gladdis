const { existsSync, readFileSync } = require('fs')
const { join } = require('path')

const root = process.cwd()
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function envConfigured(name) {
  return Boolean(process.env[name] && process.env[name].trim())
}

function printStatus(label, ok, detail) {
  const state = ok ? 'OK' : 'TODO'
  console.log(`${state.padEnd(4)} ${label}${detail ? ` - ${detail}` : ''}`)
}

function printDeferred(label, detail) {
  console.log(`INFO ${label}${detail ? ` - ${detail}` : ''}`)
}

console.log('Release doctor')
console.log(`Version: ${pkg.version}`)
console.log(`Product name: ${process.env.GLADDIS_PRODUCT_NAME || 'Gladys'}${process.env.GLADDIS_PRODUCT_NAME ? ' (env override)' : ' (default placeholder)'}`)
console.log(`App ID: ${process.env.GLADDIS_APP_ID || 'com.gladdis.app'}${process.env.GLADDIS_APP_ID ? ' (env override)' : ' (default placeholder)'}`)
console.log('')

printStatus(
  'Linux icon',
  existsSync(join(root, 'build', 'icon.png')),
  'required for polished Linux packaging'
)
printDeferred('macOS packaging', 'deferred while Linux is the only active release target')
printDeferred('Windows packaging', 'deferred while Linux is the only active release target')
printStatus(
  'Release workflow',
  existsSync(join(root, '.github', 'workflows', 'release-packages.yml')),
  'GitHub Actions packaging pipeline scaffold for Linux'
)
printStatus(
  'Landing page / download host',
  false,
  'intentionally deferred for now'
)

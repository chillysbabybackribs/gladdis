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

console.log('Release doctor')
console.log(`Version: ${pkg.version}`)
console.log(`Product name: ${process.env.GLADDIS_PRODUCT_NAME || 'Gladdis'}${process.env.GLADDIS_PRODUCT_NAME ? ' (env override)' : ' (default placeholder)'}`)
console.log(`App ID: ${process.env.GLADDIS_APP_ID || 'com.gladdis.app'}${process.env.GLADDIS_APP_ID ? ' (env override)' : ' (default placeholder)'}`)
console.log('')

printStatus(
  'macOS icon',
  existsSync(join(root, 'build', 'icon.icns')),
  'required for polished macOS packaging'
)
printStatus(
  'Windows icon',
  existsSync(join(root, 'build', 'icon.ico')),
  'required for polished Windows packaging'
)
printStatus(
  'Linux icon',
  existsSync(join(root, 'build', 'icon.png')),
  'required for polished Linux packaging'
)
printStatus(
  'Apple notarization env',
  envConfigured('APPLE_ID') && envConfigured('APPLE_APP_SPECIFIC_PASSWORD') && envConfigured('APPLE_TEAM_ID'),
  'set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID'
)
printStatus(
  'Windows signing env',
  envConfigured('CSC_LINK') && envConfigured('CSC_KEY_PASSWORD'),
  'set CSC_LINK and CSC_KEY_PASSWORD in CI or your shell'
)
printStatus(
  'Release workflow',
  existsSync(join(root, '.github', 'workflows', 'release-packages.yml')),
  'GitHub Actions packaging pipeline scaffold'
)
printStatus(
  'Landing page / download host',
  false,
  'intentionally deferred for now'
)

const productName = process.env.GLADDIS_PRODUCT_NAME || 'Gladys'
const appId = process.env.GLADDIS_APP_ID || 'com.gladdis.app'

module.exports = {
  appId,
  productName,
  directories: {
    output: 'release',
    buildResources: 'build'
  },
  files: [
    'out/**',
    'package.json'
  ],
  extraMetadata: {
    main: 'out/main/index.js'
  },
  asar: true,
  asarUnpack: [
    'node_modules/@lydell/node-pty*/**/*'
  ],
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  afterSign: 'scripts/notarize.cjs',
  mac: {
    category: 'public.app-category.developer-tools',
    target: [
      {
        target: 'dmg',
        arch: ['x64', 'arm64']
      },
      {
        target: 'zip',
        arch: ['x64', 'arm64']
      }
    ],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: false
  },
  dmg: {
    sign: false
  },
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64', 'arm64']
      }
    ]
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true
  },
  linux: {
    category: 'Development',
    executableName: 'gladys',
    syncDesktopName: true,
    maintainer: 'dp',
    synopsis: 'Gladys desktop workshop',
    description: 'Gladys is an Electron desktop workshop for chat, browser automation, and local development workflows.',
    target: [
      'AppImage',
      'deb'
    ]
  }
}

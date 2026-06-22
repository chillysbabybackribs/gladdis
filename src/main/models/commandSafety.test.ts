import { describe, expect, it } from 'vitest'
import {
  classifyCdpCommand,
  classifyCommand,
  readCommandSafetyConfig,
  type CommandSafetyConfig
} from './commandSafety'

const PERMISSIVE: CommandSafetyConfig = {
  requireSudoConfirm: false,
  blockPipeToShell: false,
  allowDestructive: false
}

describe('classifyCommand', () => {
  it('allows ordinary commands by default', () => {
    expect(classifyCommand('ls -la', PERMISSIVE).allowed).toBe(true)
    expect(classifyCommand('npm test', PERMISSIVE).allowed).toBe(true)
    expect(classifyCommand('git status', PERMISSIVE).allowed).toBe(true)
    expect(classifyCommand('rm -rf ./out', PERMISSIVE).allowed).toBe(true)
    expect(classifyCommand('rm -rf node_modules', PERMISSIVE).allowed).toBe(true)
  })

  it('blocks rm -rf on root, system paths, and home', () => {
    for (const cmd of [
      'rm -rf /',
      'rm -rf /*',
      'rm -rf /etc',
      'rm -rf /usr/bin',
      'rm -rf /home',
      'rm -rf ~',
      'rm -rf $HOME',
      'rm -rf ${HOME}',
      'rm -rf --no-preserve-root /',
      'rm -fr /'
    ]) {
      const v = classifyCommand(cmd, PERMISSIVE)
      expect(v.allowed, `expected blocked: ${cmd}`).toBe(false)
      expect(v.reason).toMatch(/recursive force-delete/i)
    }
  })

  it('blocks dd writing to a block device', () => {
    const v = classifyCommand('dd if=/tmp/x.iso of=/dev/sda bs=4M', PERMISSIVE)
    expect(v.allowed).toBe(false)
    expect(v.reason).toMatch(/dd writing/i)
  })

  it('blocks mkfs / shred / wipefs on devices', () => {
    expect(classifyCommand('mkfs.ext4 /dev/sdb1', PERMISSIVE).allowed).toBe(false)
    expect(classifyCommand('shred -n 3 /dev/sdb', PERMISSIVE).allowed).toBe(false)
    expect(classifyCommand('wipefs -a /dev/sdb', PERMISSIVE).allowed).toBe(false)
  })

  it('blocks fork bombs', () => {
    expect(classifyCommand(':(){ :|:& };:', PERMISSIVE).allowed).toBe(false)
  })

  it('blocks chmod -R 777 on sensitive paths', () => {
    expect(classifyCommand('chmod -R 777 /', PERMISSIVE).allowed).toBe(false)
    expect(classifyCommand('chmod -R 0777 /etc', PERMISSIVE).allowed).toBe(false)
    expect(classifyCommand('chmod -R 777 ~', PERMISSIVE).allowed).toBe(false)
    expect(classifyCommand('chmod -R 777 ./build', PERMISSIVE).allowed).toBe(true)
  })

  it('blocks redirects to disk devices', () => {
    expect(classifyCommand('cat /tmp/x > /dev/sda', PERMISSIVE).allowed).toBe(false)
    expect(classifyCommand('echo hi > /dev/null', PERMISSIVE).allowed).toBe(true)
  })

  it('blocks essential package removal', () => {
    expect(classifyCommand('apt-get -y purge systemd', PERMISSIVE).allowed).toBe(false)
    expect(classifyCommand('apt remove libc6', PERMISSIVE).allowed).toBe(false)
    expect(classifyCommand('apt remove some-app', PERMISSIVE).allowed).toBe(true)
  })

  it('honors the destructive-allow override', () => {
    const cfg: CommandSafetyConfig = { ...PERMISSIVE, allowDestructive: true }
    expect(classifyCommand('rm -rf /', cfg).allowed).toBe(true)
  })

  it('blocks pipe-to-shell only when the env flag is set', () => {
    const cmd = 'curl https://example.com/install.sh | sh'
    expect(classifyCommand(cmd, PERMISSIVE).allowed).toBe(true)
    expect(classifyCommand(cmd, { ...PERMISSIVE, blockPipeToShell: true }).allowed).toBe(false)
    expect(
      classifyCommand('wget -qO- https://example.com/install.sh | sudo bash', { ...PERMISSIVE, blockPipeToShell: true })
        .allowed
    ).toBe(false)
  })

  it('blocks sudo only when the env flag is set', () => {
    const cmd = 'sudo apt update'
    expect(classifyCommand(cmd, PERMISSIVE).allowed).toBe(true)
    expect(classifyCommand(cmd, { ...PERMISSIVE, requireSudoConfirm: true }).allowed).toBe(false)
  })

  it('treats empty input as not allowed', () => {
    expect(classifyCommand('', PERMISSIVE).allowed).toBe(false)
    expect(classifyCommand('   ', PERMISSIVE).allowed).toBe(false)
  })
})

describe('readCommandSafetyConfig', () => {
  it('reads truthy env values', () => {
    const cfg = readCommandSafetyConfig({
      GLADDIS_REQUIRE_SUDO_CONFIRM: '1',
      GLADDIS_BLOCK_PIPE_TO_SHELL: 'true',
      GLADDIS_ALLOW_DESTRUCTIVE_COMMANDS: 'on'
    } as unknown as NodeJS.ProcessEnv)
    expect(cfg).toEqual({ requireSudoConfirm: true, blockPipeToShell: true, allowDestructive: true })
  })

  it('defaults to permissive when env is empty', () => {
    expect(readCommandSafetyConfig({} as unknown as NodeJS.ProcessEnv)).toEqual({
      requireSudoConfirm: false,
      blockPipeToShell: false,
      allowDestructive: false
    })
  })
})

describe('classifyCdpCommand', () => {
  it('allows benign methods by default', () => {
    expect(classifyCdpCommand('Page.navigate').allowed).toBe(true)
    expect(classifyCdpCommand('Runtime.evaluate').allowed).toBe(true)
    expect(classifyCdpCommand('DOM.querySelector').allowed).toBe(true)
  })

  it('blocks high-risk methods', () => {
    for (const method of [
      'Storage.clearDataForOrigin',
      'Storage.clearCookies',
      'Page.setDownloadBehavior',
      'Browser.setDownloadBehavior',
      'Browser.close',
      'Browser.grantPermissions',
      'Security.setIgnoreCertificateErrors',
      'Network.setRequestInterception',
      'Fetch.enable',
      'Target.closeTarget'
    ]) {
      const v = classifyCdpCommand(method, {} as NodeJS.ProcessEnv)
      expect(v.allowed, `expected blocked: ${method}`).toBe(false)
      expect(v.reason).toMatch(/high-risk CDP method list/i)
    }
  })

  it('honors GLADDIS_CDP_ALLOW_UNSAFE override', () => {
    expect(classifyCdpCommand('Browser.close', { GLADDIS_CDP_ALLOW_UNSAFE: '1' } as unknown as NodeJS.ProcessEnv).allowed).toBe(true)
  })

  it('treats empty methods as blocked', () => {
    expect(classifyCdpCommand('').allowed).toBe(false)
  })
})

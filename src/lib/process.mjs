import { spawnSync } from 'node:child_process'

export function runCommand(command, args, { cwd = process.cwd(), env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env,
  })

  if (typeof result.status === 'number') {
    process.exitCode = result.status
    return result.status
  }

  if (result.error) {
    throw result.error
  }

  return 1
}

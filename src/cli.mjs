#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import repl from 'node:repl'
import { createPublicClient, createWalletClient, formatEther, http, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getRpcEnvOverrides, listNetworks, resolveNetwork } from './lib/chain.mjs'
import { runCommand } from './lib/process.mjs'
import { copyTemplate } from './lib/template.mjs'

function usage() {
  console.log(`liquidtruffle

Usage:
  liquidtruffle init [path]
  liquidtruffle unbox [template] [path]
  liquidtruffle compile [--cwd path]
  liquidtruffle test [--cwd path]
  liquidtruffle deploy [--cwd path] [--network hyperevm|hyperevm-testnet] [--script scripts/deploy.cjs]
  liquidtruffle console [--network hyperevm|hyperevm-testnet]
  liquidtruffle doctor [--cwd path]

Examples:
  liquidtruffle init ./my-hyperevm-app
  liquidtruffle unbox bare-hyperevm ./my-hyperevm-app
  liquidtruffle compile --cwd ./my-hyperevm-app
  liquidtruffle deploy --cwd ./my-hyperevm-app --network hyperevm-testnet
  liquidtruffle console --network hyperevm
`)
}

function getFlag(args, name, fallback = undefined) {
  const flag = `--${name}`
  const index = args.indexOf(flag)
  if (index === -1) return fallback
  return args[index + 1] ?? fallback
}

function hasFlag(args, name) {
  return args.includes(`--${name}`)
}

function positionalArgs(args) {
  const values = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      i += 1
      continue
    }
    values.push(arg)
  }
  return values
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase())
}

function resolveCwd(args) {
  const cwd = getFlag(args, 'cwd', process.cwd())
  return path.resolve(cwd)
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {}
  }

  const values = {}
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) {
      continue
    }

    values[trimmed.slice(0, separatorIndex).trim()] = trimmed.slice(separatorIndex + 1).trim()
  }
  return values
}

function getRuntimeEnv(cwd = process.cwd()) {
  return {
    ...process.env,
    ...parseEnvFile(path.join(cwd, '.env')),
  }
}

async function printDoctor(cwd) {
  const env = getRuntimeEnv(cwd)
  console.log('liquidtruffle doctor')
  console.log(`cwd: ${cwd}`)
  console.log('')

  for (const network of listNetworks({ env })) {
    console.log(`${network.name}`)
    console.log(`  chainId: ${network.chainId}`)
    console.log(`  rpc candidates: ${network.rpcCandidates.join(', ')}`)
    try {
      const resolved = await resolveNetwork(network.key, { env })
      console.log(`  active rpc: ${resolved.rpcUrl}`)
      if (resolved.fallbackActive) {
        console.log(`  fallback active: yes`)
      }
    } catch (error) {
      console.log(`  active rpc: unavailable`)
      const attempts = Array.isArray(error.attempts) ? error.attempts : []
      for (const attempt of attempts) {
        console.log(`    miss ${attempt.rpcUrl} (${attempt.error})`)
      }
    }
    if (network.wrappedNative) {
      console.log(`  wrapped native: ${network.wrappedNative}`)
    }
  }

  console.log('')
  console.log('project checks')

  const checks = [
    ['hardhat config', ['hardhat.config.cjs', 'hardhat.config.js']],
    ['contracts dir', ['contracts']],
    ['deploy script', ['scripts/deploy.cjs', 'scripts/deploy.js']],
    ['env example', ['.env.example']],
  ]

  for (const [label, candidates] of checks) {
    const ok = candidates.some((candidate) => fs.existsSync(path.join(cwd, candidate)))
    console.log(`  ${ok ? 'ok ' : 'miss'} ${label}`)
  }

  console.log('')
  console.log('HyperEVM notes')
  console.log('  - HyperEVM omits debug/admin/engine/txpool/sign RPC families.')
  console.log('  - Contracts above the default 2M gas core block limit may need the big-block flow.')
  console.log('  - There is no official HyperEVM frontend component library to reuse.')
}

async function openConsole(args) {
  const networkName = getFlag(args, 'network', 'hyperevm')
  const network = await resolveNetwork(networkName)

  const transport = http(network.rpcUrl)
  const chain = {
    id: network.chainId,
    name: network.name,
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: {
      default: { http: [network.rpcUrl] },
      public: { http: [network.rpcUrl] },
    },
  }

  const publicClient = createPublicClient({ chain, transport })
  let walletClient = null
  let account = null

  const key = process.env.PRIVATE_KEY
  if (key?.startsWith('0x') && key.length === 66) {
    account = privateKeyToAccount(key)
    walletClient = createWalletClient({ account, chain, transport })
  }

  console.log(`Connected to ${network.name} (${network.rpcUrl})`)
  if (network.fallbackActive) {
    console.log(`Fallback RPC active. Candidates: ${network.rpcCandidates.join(', ')}`)
  }
  console.log('Available globals: publicClient, walletClient, account, chain, parseEther, formatEther')
  console.log('')

  const session = repl.start({ prompt: 'liquidtruffle> ' })
  Object.assign(session.context, {
    publicClient,
    walletClient,
    account,
    chain,
    parseEther,
    formatEther,
  })
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || hasFlag(args, 'help') || command === 'help' || command === '--help') {
    usage()
    return
  }

  if (command === 'init') {
    const target = positionalArgs(args.slice(1))[0] || '.'
    const destination = path.resolve(target)
    copyTemplate('bare-hyperevm', destination)
    console.log(`Initialized bare-hyperevm in ${destination}`)
    return
  }

  if (command === 'unbox') {
    const values = positionalArgs(args.slice(1))
    const template = values[0] || 'bare-hyperevm'
    const target = values[1] || '.'
    const destination = path.resolve(target)
    copyTemplate(template, destination)
    console.log(`Unboxed ${template} in ${destination}`)
    return
  }

  if (command === 'compile') {
    runCommand('npx', ['hardhat', 'compile'], { cwd: resolveCwd(args.slice(1)) })
    return
  }

  if (command === 'test') {
    runCommand('npx', ['hardhat', 'test'], { cwd: resolveCwd(args.slice(1)) })
    return
  }

  if (command === 'deploy') {
    const subArgs = args.slice(1)
    const cwd = resolveCwd(subArgs)
    const env = getRuntimeEnv(cwd)
    const networkName = getFlag(subArgs, 'network', 'hyperevm')
    const script = getFlag(subArgs, 'script', 'scripts/deploy.cjs')
    const network = await resolveNetwork(networkName, { env })
    if (network.fallbackActive) {
      console.log(`Using fallback RPC for ${network.name}: ${network.rpcUrl}`)
    }
    const deployEnv = {
      ...env,
      ...getRpcEnvOverrides(network),
    }
    if (
      networkName === 'hyperevm-testnet' &&
      !isTruthy(deployEnv.VERIFY_TESTNET) &&
      !isTruthy(deployEnv.SKIP_VERIFY)
    ) {
      deployEnv.SKIP_VERIFY = '1'
      console.log('Testnet deploy default: SKIP_VERIFY=1 (set VERIFY_TESTNET=true to opt in).')
    }
    runCommand('npx', ['hardhat', 'run', script, '--network', networkName], {
      cwd,
      env: deployEnv,
    })
    return
  }

  if (command === 'console') {
    await openConsole(args.slice(1))
    return
  }

  if (command === 'doctor') {
    await printDoctor(resolveCwd(args.slice(1)))
    return
  }

  usage()
  process.exitCode = 1
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})

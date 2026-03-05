import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatGwei,
  http as viemHttp,
  isAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getRpcEnvOverrides, listNetworks, resolveNetwork } from '../src/lib/chain.mjs'
import { getCompanionProfile, listCompanionProfiles } from '../src/lib/companions.mjs'
import { copyTemplate } from '../src/lib/template.mjs'
import { getAssistantDefaults, runAssistantTurn } from './assistant.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const COMPANION_ROOT = path.resolve(PROJECT_ROOT, '..')
const CLI_PATH = path.join(PROJECT_ROOT, 'src', 'cli.mjs')
const WORKSPACE_ROOT = path.resolve(
  process.env.LIQUIDTRUFFLE_WORKSPACES || path.join(PROJECT_ROOT, 'workspaces')
)
const API_PORT = 4173
const OMITTED_EDITOR_DIRS = new Set(['.git', 'node_modules', 'artifacts', 'cache', 'dist'])
const EMPTY_ENV = [
  'PRIVATE_KEY=0x',
  'HYPEREVM_RPC=https://rpc.hyperliquid.xyz/evm',
  'HYPEREVM_TESTNET_RPC=https://rpc.hyperliquid-testnet.xyz/evm',
  'HYPEREVM_TESTNET_RPC_FALLBACKS=',
  '',
].join('\n')
const responseCache = new Map()
const jobs = new Map()
const assistantSessions = new Map()

fs.mkdirSync(WORKSPACE_ROOT, { recursive: true })

function chainFromNetwork(network) {
  return {
    id: network.chainId,
    name: network.name,
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: {
      default: { http: [network.rpcUrl] },
      public: { http: [network.rpcUrl] },
    },
  }
}

function cacheFor(key, ttlMs, loader) {
  const now = Date.now()
  const cached = responseCache.get(key)
  if (cached && cached.expiresAt > now) {
    return cached.value
  }

  const value = Promise.resolve().then(loader)
  responseCache.set(key, {
    value,
    expiresAt: now + ttlMs,
  })
  value.catch(() => {
    const current = responseCache.get(key)
    if (current?.value === value) {
      responseCache.delete(key)
    }
  })
  return value
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  })
  res.end(
    JSON.stringify(payload, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )
  )
}

function clearResponseCache(...keys) {
  for (const key of keys) {
    responseCache.delete(key)
  }
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }

  if (chunks.length === 0) {
    return {}
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sanitizeWorkspaceName(name) {
  const trimmed = String(name || '').trim().toLowerCase()
  if (!trimmed || !/^[a-z0-9][a-z0-9-]*$/.test(trimmed)) {
    throw new Error('Workspace names must match /^[a-z0-9][a-z0-9-]*$/.')
  }
  return trimmed
}

function resolveWorkspacePath(name) {
  const safeName = sanitizeWorkspaceName(name)
  const workspacePath = path.resolve(WORKSPACE_ROOT, safeName)
  if (!workspacePath.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new Error('Invalid workspace path.')
  }
  return workspacePath
}

function resolveWorkspaceFile(workspacePath, relativeFilePath) {
  const normalized = String(relativeFilePath || '').replace(/^\/+/, '')
  if (!normalized) {
    throw new Error('File path is required.')
  }

  const filePath = path.resolve(workspacePath, normalized)
  if (!filePath.startsWith(workspacePath + path.sep)) {
    throw new Error('Invalid file path.')
  }

  return { normalized, filePath }
}

function hasValidPrivateKey(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(value || ''))
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

function getWorkspaceEnv(workspacePath) {
  return {
    ...process.env,
    ...parseEnvFile(path.join(workspacePath, '.env')),
  }
}

function extractDefaultLiteral(source, identifier) {
  const pattern = new RegExp(`${identifier}[^\\n]*\\|\\|\\s*'([^']+)'`)
  const match = source.match(pattern)
  return match?.[1] || ''
}

function getLatestDeployment(summary) {
  for (const networkEntry of summary?.deployments || []) {
    const deployment = networkEntry.deployments?.[networkEntry.deployments.length - 1]
    if (deployment) {
      return {
        network: networkEntry.network,
        chainId: networkEntry.chainId,
        updatedAt: networkEntry.updatedAt,
        ...deployment,
      }
    }
  }

  return null
}

function buildCompanionProbeUrls(appUrl) {
  const baseUrl = String(appUrl || '').trim()
  if (!baseUrl) {
    return []
  }

  const urls = [baseUrl]
  try {
    const parsed = new URL(baseUrl)
    const localAliases = new Set(['localhost', '127.0.0.1', '::1'])
    if (!localAliases.has(parsed.hostname)) {
      return urls
    }

    for (const hostname of localAliases) {
      if (hostname === parsed.hostname) {
        continue
      }
      const next = new URL(baseUrl)
      next.hostname = hostname
      urls.push(next.toString())
    }
  } catch {
    return urls
  }

  return Array.from(new Set(urls))
}

async function getCompanionProfileSummary(profile) {
  const contractsPath = path.join(COMPANION_ROOT, 'src', 'lib', 'contracts.js')
  const chainsPath = path.join(COMPANION_ROOT, 'src', 'config', 'chains.js')
  const contractsSource = fs.existsSync(contractsPath) ? fs.readFileSync(contractsPath, 'utf8') : ''
  const chainsSource = fs.existsSync(chainsPath) ? fs.readFileSync(chainsPath, 'utf8') : ''

  let running = false
  let title = ''
  let runtimeError = ''
  let resolvedUrl = profile.appUrl
  const probeUrls = buildCompanionProbeUrls(profile.appUrl)

  for (const probeUrl of probeUrls) {
    try {
      const response = await fetch(probeUrl, { signal: AbortSignal.timeout(1800) })
      if (!response.ok) {
        runtimeError = `${probeUrl} returned HTTP ${response.status}`
        continue
      }

      const html = await response.text()
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
      title = titleMatch?.[1] || ''
      running = true
      resolvedUrl = probeUrl
      runtimeError = ''
      break
    } catch (error) {
      runtimeError = `${probeUrl}: ${String(error.message || error)}`
    }
  }

  return {
    id: profile.id,
    label: profile.label,
    description: profile.description || '',
    removeHint: profile.removeHint || '',
    workspaceName: profile.workspaceName || '',
    workspaceExists: !!(profile.workspaceName && fs.existsSync(path.join(WORKSPACE_ROOT, profile.workspaceName))),
    root: COMPANION_ROOT,
    url: profile.appUrl,
    resolvedUrl,
    running,
    title,
    runtimeError,
    files: profile.files || [],
    actions: Array.isArray(profile.actions) ? profile.actions : [],
    defaultWorkspace: Boolean(profile.defaultWorkspace),
    factoryAddressDefault:
      extractDefaultLiteral(contractsSource, 'FACTORY_ADDRESS') ||
      '0x0000000000000000000000000000000000000000',
    launchFeeDefault: extractDefaultLiteral(contractsSource, 'LAUNCH_FEE') || '100000000000000000',
    rpcDefault: extractDefaultLiteral(chainsSource, 'HYPEREVM_RPC_PRIMARY') || 'https://rpc.hyperliquid.xyz/evm',
  }
}

async function getCompanionProfilesSummary() {
  return await Promise.all(listCompanionProfiles().map((profile) => getCompanionProfileSummary(profile)))
}

function buildAssistantRuntimeContext({ workspaceName, network, companionApp, companionProfiles }) {
  const workspaceSummary = workspaceName ? summarizeWorkspace(getWorkspaceSummary(workspaceName)) : null
  return {
    activeWorkspace: workspaceSummary,
    selectedNetwork: network || null,
    latestDeployment: getLatestDeployment(workspaceSummary),
    companionApp,
    companionProfiles: companionProfiles || [],
  }
}

function resolveAssistantTarget(scope, workspaceName, relativePath) {
  const normalized = String(relativePath || '').replace(/^\/+/, '')
  if (!normalized) {
    throw new Error('Proposal path is required.')
  }

  if (scope === 'workspace') {
    if (!workspaceName) {
      throw new Error('Workspace proposals require an active workspace.')
    }
    const workspacePath = resolveWorkspacePath(workspaceName)
    const { filePath } = resolveWorkspaceFile(workspacePath, normalized)
    return {
      scope,
      workspaceName,
      normalized,
      filePath,
      absolutePath: filePath,
    }
  }

  if (scope === 'companion') {
    const filePath = path.resolve(COMPANION_ROOT, normalized)
    if (!filePath.startsWith(COMPANION_ROOT + path.sep)) {
      throw new Error('Invalid companion proposal path.')
    }
    if (filePath.startsWith(PROJECT_ROOT + path.sep)) {
      throw new Error('Companion proposals cannot target LiquidTruffle files.')
    }
    return {
      scope,
      workspaceName: null,
      normalized,
      filePath,
      absolutePath: filePath,
    }
  }

  throw new Error(`Unknown proposal scope: ${scope}`)
}

function buildUnifiedDiff(relativePath, beforeText, afterText) {
  if (beforeText === afterText) {
    return `--- a/${relativePath}\n+++ b/${relativePath}\n`
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liquidtruffle-diff-'))
  const beforePath = path.join(tempDir, 'before.txt')
  const afterPath = path.join(tempDir, 'after.txt')
  fs.writeFileSync(beforePath, beforeText, 'utf8')
  fs.writeFileSync(afterPath, afterText, 'utf8')

  try {
    const result = spawnSync(
      'diff',
      ['-u', '--label', `a/${relativePath}`, '--label', `b/${relativePath}`, beforePath, afterPath],
      { encoding: 'utf8' }
    )

    if (typeof result.stdout === 'string' && result.stdout.trim()) {
      return result.stdout
    }

    if (typeof result.stderr === 'string' && result.stderr.trim()) {
      return result.stderr
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  return `--- a/${relativePath}\n+++ b/${relativePath}\n`
}

function serializeAssistantProposal(proposal) {
  return {
    id: proposal.id,
    scope: proposal.scope,
    workspaceName: proposal.workspaceName,
    path: proposal.path,
    absolutePath: proposal.absolutePath,
    reason: proposal.reason,
    status: proposal.status,
    changeType: proposal.changeType,
    diff: proposal.diff,
    createdAt: proposal.createdAt,
    appliedAt: proposal.appliedAt || null,
    discardedAt: proposal.discardedAt || null,
    error: proposal.error || '',
  }
}

function materializeAssistantProposals(session, proposals, workspaceName) {
  const sessionProposals = session.proposals || {}
  const materialized = []

  for (const proposal of proposals || []) {
    const record = {
      id: randomUUID(),
      scope: proposal.scope,
      workspaceName: proposal.scope === 'workspace' ? workspaceName : null,
      path: String(proposal.path || ''),
      absolutePath: '',
      reason: String(proposal.reason || ''),
      status: 'pending',
      changeType: 'modify',
      diff: '',
      createdAt: new Date().toISOString(),
      appliedAt: null,
      discardedAt: null,
      error: '',
      nextContent: String(proposal.content || ''),
    }

    try {
      const target = resolveAssistantTarget(proposal.scope, workspaceName, proposal.path || '')
      const currentContent = fs.existsSync(target.filePath)
        ? fs.readFileSync(target.filePath, 'utf8')
        : ''
      record.path = target.normalized
      record.absolutePath = target.absolutePath
      record.workspaceName = target.workspaceName
      record.changeType = fs.existsSync(target.filePath) ? 'modify' : 'create'
      record.diff = buildUnifiedDiff(target.normalized, currentContent, record.nextContent)
      if (currentContent === record.nextContent) {
        record.status = 'noop'
      }
    } catch (error) {
      record.status = 'rejected'
      record.error = String(error.message || error)
    }

    sessionProposals[record.id] = record
    materialized.push(serializeAssistantProposal(record))
  }

  session.proposals = sessionProposals
  return materialized
}

function getAssistantProposal(sessionId, proposalId) {
  const session = assistantSessions.get(sessionId)
  if (!session) {
    throw new Error(`Assistant session not found: ${sessionId}`)
  }

  const proposal = session.proposals?.[proposalId]
  if (!proposal) {
    throw new Error(`Assistant proposal not found: ${proposalId}`)
  }

  return { session, proposal }
}

function listWorkspaceFiles(workspacePath) {
  const files = []

  function walk(currentPath) {
    const stat = fs.statSync(currentPath)
    if (stat.isDirectory()) {
      const name = path.basename(currentPath)
      if (OMITTED_EDITOR_DIRS.has(name)) {
        return
      }

      for (const entry of fs.readdirSync(currentPath)) {
        walk(path.join(currentPath, entry))
      }
      return
    }

    files.push(path.relative(workspacePath, currentPath))
  }

  walk(workspacePath)
  return files.sort((left, right) => left.localeCompare(right))
}

function loadArtifact(workspacePath, relativePath) {
  const { filePath } = resolveWorkspaceFile(workspacePath, relativePath)
  if (!fs.existsSync(filePath)) {
    throw new Error(`Artifact not found: ${relativePath}`)
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (!Array.isArray(parsed.abi)) {
    throw new Error(`Invalid artifact: ${relativePath}`)
  }
  return parsed
}

function listArtifactSummaries(workspacePath) {
  const artifactsRoot = path.join(workspacePath, 'artifacts', 'contracts')
  if (!fs.existsSync(artifactsRoot)) {
    return []
  }

  const artifacts = []

  function walk(currentPath) {
    const stat = fs.statSync(currentPath)
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(currentPath)) {
        walk(path.join(currentPath, entry))
      }
      return
    }

    if (!currentPath.endsWith('.json') || currentPath.endsWith('.dbg.json')) {
      return
    }

    const parsed = JSON.parse(fs.readFileSync(currentPath, 'utf8'))
    if (!parsed.contractName || !Array.isArray(parsed.abi)) {
      return
    }

    artifacts.push({
      contractName: parsed.contractName,
      sourceName: parsed.sourceName,
      relativePath: path.relative(workspacePath, currentPath),
      abiEntries: parsed.abi.length,
      readFunctions: parsed.abi
        .filter((entry) => entry.type === 'function' && ['view', 'pure'].includes(entry.stateMutability))
        .map((entry) => entry.name),
      writeFunctions: parsed.abi
        .filter((entry) => entry.type === 'function' && !['view', 'pure'].includes(entry.stateMutability))
        .map((entry) => entry.name),
      bytecodeSize:
        typeof parsed.bytecode === 'string' && parsed.bytecode.startsWith('0x')
          ? Math.max(0, (parsed.bytecode.length - 2) / 2)
          : 0,
      deployedBytecodeSize:
        typeof parsed.deployedBytecode === 'string' && parsed.deployedBytecode.startsWith('0x')
          ? Math.max(0, (parsed.deployedBytecode.length - 2) / 2)
          : 0,
    })
  }

  walk(artifactsRoot)
  return artifacts.sort((left, right) => left.contractName.localeCompare(right.contractName))
}

function listDeployments(workspacePath) {
  const deploymentsRoot = path.join(workspacePath, 'deployments')
  if (!fs.existsSync(deploymentsRoot)) {
    return []
  }

  return fs
    .readdirSync(deploymentsRoot)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const parsed = JSON.parse(fs.readFileSync(path.join(deploymentsRoot, file), 'utf8'))
      return {
        network: parsed.network || file.replace(/\.json$/, ''),
        chainId: parsed.chainId || null,
        updatedAt: parsed.updatedAt || null,
        deployments: Array.isArray(parsed.deployments) ? parsed.deployments : [],
      }
    })
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
}

function getWorkspaceSummary(name) {
  const workspacePath = resolveWorkspacePath(name)
  if (!fs.existsSync(workspacePath)) {
    throw new Error(`Workspace not found: ${name}`)
  }

  const envPath = path.join(workspacePath, '.env')
  const env = parseEnvFile(envPath)
  const packageJsonPath = path.join(workspacePath, 'package.json')
  let packageJson = null
  if (fs.existsSync(packageJsonPath)) {
    try {
      packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    } catch {
      packageJson = null
    }
  }
  const usesSharedToolchain = fs.existsSync(path.join(PROJECT_ROOT, 'node_modules', 'hardhat'))

  return {
    name,
    path: workspacePath,
    files: listWorkspaceFiles(workspacePath),
    artifacts: listArtifactSummaries(workspacePath),
    deployments: listDeployments(workspacePath),
    commands: packageJson?.scripts || {},
    hasEnvFile: fs.existsSync(envPath),
    hasPrivateKey: hasValidPrivateKey(env.PRIVATE_KEY),
    hasPlaceholderPrivateKey: !hasValidPrivateKey(env.PRIVATE_KEY),
    toolchain: usesSharedToolchain
      ? 'shared'
      : fs.existsSync(path.join(workspacePath, 'node_modules', 'hardhat'))
        ? 'local'
        : 'missing',
  }
}

function listWorkspaceSummaries() {
  return fs
    .readdirSync(WORKSPACE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        const summary = getWorkspaceSummary(entry.name)
        return {
          name: summary.name,
          path: summary.path,
          fileCount: summary.files.length,
          artifactCount: summary.artifacts.length,
          deploymentCount: summary.deployments.reduce(
            (count, item) => count + item.deployments.length,
            0
          ),
          hasEnvFile: summary.hasEnvFile,
          hasPrivateKey: summary.hasPrivateKey && !summary.hasPlaceholderPrivateKey,
          toolchain: summary.toolchain,
        }
      } catch {
        const workspacePath = resolveWorkspacePath(entry.name)
        const envPath = path.join(workspacePath, '.env')
        const env = parseEnvFile(envPath)
        const usesSharedToolchain = fs.existsSync(path.join(PROJECT_ROOT, 'node_modules', 'hardhat'))
        return {
          name: entry.name,
          path: workspacePath,
          fileCount: 0,
          artifactCount: 0,
          deploymentCount: 0,
          hasEnvFile: fs.existsSync(envPath),
          hasPrivateKey: hasValidPrivateKey(env.PRIVATE_KEY),
          toolchain: usesSharedToolchain
            ? 'shared'
            : fs.existsSync(path.join(workspacePath, 'node_modules', 'hardhat'))
              ? 'local'
              : 'missing',
        }
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

function summarizeWorkspace(summary) {
  return {
    name: summary.name,
    path: summary.path,
    fileCount: summary.files.length,
    artifactCount: summary.artifacts.length,
    deploymentCount: summary.deployments.reduce(
      (count, entry) => count + (entry.deployments?.length || 0),
      0
    ),
    files: summary.files.slice(0, 120),
    artifacts: summary.artifacts.slice(0, 20),
    deployments: summary.deployments.slice(0, 10),
    hasEnvFile: summary.hasEnvFile,
    hasPrivateKey: summary.hasPrivateKey,
    hasPlaceholderPrivateKey: summary.hasPlaceholderPrivateKey,
    toolchain: summary.toolchain,
  }
}

function summarizeJob(job) {
  const snapshot = createJobSnapshot(job)
  return {
    ...snapshot,
    stdoutTail: snapshot.stdout.split('\n').slice(-20).join('\n'),
    stderrTail: snapshot.stderr.split('\n').slice(-20).join('\n'),
    outputTail: snapshot.output.split('\n').slice(-30).join('\n'),
  }
}

async function fetchInfo(payload) {
  const response = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(`Hyperliquid info error: ${response.status}`)
  }

  return response.json()
}

async function getHyperliquidOverview() {
  const [spotResponse, perpResponse] = await Promise.all([
    fetchInfo({ type: 'spotMetaAndAssetCtxs' }),
    fetchInfo({ type: 'metaAndAssetCtxs' }),
  ])

  const [spotMeta, spotCtxs] = spotResponse
  const [perpMeta, perpCtxs] = perpResponse

  return {
    updatedAt: new Date().toISOString(),
    spotMarketCount: (spotMeta.universe || []).length,
    tokenCount: (spotMeta.tokens || []).length,
    perpCount: (perpMeta.universe || []).length,
    tokens: (spotMeta.tokens || [])
      .filter((token) => token.evmContract?.address)
      .map((token) => ({
        name: token.name,
        fullName: token.fullName,
        address: token.evmContract.address,
        tokenId: token.tokenId,
        isCanonical: Boolean(token.isCanonical),
        weiDecimals: token.weiDecimals,
        szDecimals: token.szDecimals,
      }))
      .sort((left, right) => Number(right.isCanonical) - Number(left.isCanonical))
      .slice(0, 8),
    spotMarkets: (spotMeta.universe || [])
      .map((entry, index) => ({
        name: entry.name,
        isCanonical: Boolean(entry.isCanonical),
        dayNtlVlm: Number(spotCtxs[index]?.dayNtlVlm || 0),
        markPx: spotCtxs[index]?.markPx || '0',
        midPx: spotCtxs[index]?.midPx || '0',
        prevDayPx: spotCtxs[index]?.prevDayPx || '0',
      }))
      .sort((left, right) => right.dayNtlVlm - left.dayNtlVlm)
      .slice(0, 8),
    perps: (perpMeta.universe || [])
      .map((entry, index) => ({
        name: entry.name,
        maxLeverage: entry.maxLeverage,
        dayNtlVlm: Number(perpCtxs[index]?.dayNtlVlm || 0),
        markPx: perpCtxs[index]?.markPx || '0',
        funding: perpCtxs[index]?.funding || '0',
        openInterest: perpCtxs[index]?.openInterest || '0',
      }))
      .sort((left, right) => right.dayNtlVlm - left.dayNtlVlm)
      .slice(0, 8),
  }
}

async function getNetworkStatus(networkName) {
  try {
    const network = await resolveNetwork(networkName)
    const client = createPublicClient({
      transport: viemHttp(network.rpcUrl),
      chain: chainFromNetwork(network),
    })

    const [chainId, blockNumber, gasPrice, latestBlock, bigBlockGasPrice] = await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
      client.getGasPrice(),
      client.getBlock({ blockTag: 'latest' }),
      client.request({ method: 'eth_bigBlockGasPrice', params: [] }),
    ])

    return {
      key: network.key,
      label: network.key === 'hyperevm' ? 'Mainnet' : 'Testnet',
      name: network.name,
      rpcUrl: network.rpcUrl,
      rpcCandidates: network.rpcCandidates,
      fallbackActive: network.fallbackActive,
      chainId,
      wrappedNative: network.wrappedNative,
      state: 'ready',
      blockNumber: Number(blockNumber),
      gasPriceWei: gasPrice.toString(),
      gasPrice: `${Number(formatGwei(gasPrice)).toFixed(3)} gwei`,
      bigBlockGasPriceWei: BigInt(bigBlockGasPrice).toString(),
      bigBlockGasPrice: `${Number(formatGwei(BigInt(bigBlockGasPrice))).toFixed(3)} gwei`,
      blockGasLimit: latestBlock.gasLimit.toString(),
      blockGasUsed: latestBlock.gasUsed?.toString() || '0',
    }
  } catch (error) {
    const network = listNetworks().find((item) => item.key === networkName)
    return {
      key: network?.key || networkName,
      label: network?.key === 'hyperevm' ? 'Mainnet' : 'Testnet',
      name: network?.name || networkName,
      rpcUrl: network?.rpcUrl,
      rpcCandidates: network?.rpcCandidates || [],
      chainId: network?.chainId,
      wrappedNative: network?.wrappedNative,
      state: 'error',
      error: String(error.message || error),
    }
  }
}

async function inspectAddress(networkName, address) {
  if (!isAddress(address)) {
    throw new Error('Enter a valid EVM address.')
  }

  const network = await resolveNetwork(networkName)
  const client = createPublicClient({
    transport: viemHttp(network.rpcUrl),
    chain: chainFromNetwork(network),
  })

  const [balance, bytecode, nonce, usingBigBlocks] = await Promise.all([
    client.getBalance({ address }),
    client.getBytecode({ address }),
    client.getTransactionCount({ address }),
    client.request({ method: 'eth_usingBigBlocks', params: [address] }),
  ])

  return {
    address,
    rpcUrl: network.rpcUrl,
    fallbackActive: network.fallbackActive,
    balanceWei: balance.toString(),
    balance: `${Number(formatEther(balance)).toFixed(4)} HYPE`,
    nonce: nonce.toString(),
    isContract: Boolean(bytecode && bytecode !== '0x'),
    codeSize:
      bytecode && bytecode !== '0x' ? `${Math.max(0, (bytecode.length - 2) / 2)} bytes` : '0 bytes',
    usingBigBlocks: Boolean(usingBigBlocks),
  }
}

async function getWorkspacePreflight(name, networkName) {
  const summary = getWorkspaceSummary(name)
  const env = parseEnvFile(path.join(summary.path, '.env'))
  const network = await resolveNetwork(networkName, { env: { ...process.env, ...env } })

  const result = {
    network: network.name,
    rpcUrl: network.rpcUrl,
    rpcCandidates: network.rpcCandidates,
    fallbackActive: network.fallbackActive,
    privateKeyConfigured: hasValidPrivateKey(env.PRIVATE_KEY),
    deployer: null,
  }

  if (!result.privateKeyConfigured) {
    return result
  }

  const account = privateKeyToAccount(env.PRIVATE_KEY)
  const client = createPublicClient({
    transport: viemHttp(network.rpcUrl),
    chain: chainFromNetwork(network),
  })

  const [balance, nonce, usingBigBlocks, gasPrice, bigBlockGasPrice] = await Promise.all([
    client.getBalance({ address: account.address }),
    client.getTransactionCount({ address: account.address }),
    client.request({ method: 'eth_usingBigBlocks', params: [account.address] }),
    client.getGasPrice(),
    client.request({ method: 'eth_bigBlockGasPrice', params: [] }),
  ])

  result.deployer = {
    address: account.address,
    balance: `${Number(formatEther(balance)).toFixed(4)} HYPE`,
    nonce: nonce.toString(),
    usingBigBlocks: Boolean(usingBigBlocks),
    gasPrice: `${Number(formatGwei(gasPrice)).toFixed(3)} gwei`,
    bigBlockGasPrice: `${Number(formatGwei(BigInt(bigBlockGasPrice))).toFixed(3)} gwei`,
  }
  return result
}

function buildContractScaffold(name) {
  return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ${name} {
    uint256 public value;

    function setValue(uint256 nextValue) external {
        value = nextValue;
    }
}
`
}

function createWorkspace(name, template = 'bare-hyperevm') {
  const safeName = sanitizeWorkspaceName(name)
  const workspacePath = resolveWorkspacePath(safeName)
  if (fs.existsSync(workspacePath) && fs.readdirSync(workspacePath).length > 0) {
    throw new Error(`Workspace already exists: ${safeName}`)
  }

  copyTemplate(template, workspacePath)
  const envPath = path.join(workspacePath, '.env')
  if (!fs.existsSync(envPath)) {
    const examplePath = path.join(workspacePath, '.env.example')
    fs.writeFileSync(
      envPath,
      fs.existsSync(examplePath) ? fs.readFileSync(examplePath, 'utf8') : EMPTY_ENV,
      'utf8'
    )
  }

  return getWorkspaceSummary(safeName)
}

function createJobSnapshot(job) {
  return {
    id: job.id,
    workspace: job.workspace,
    action: job.action,
    network: job.network,
    command: job.command,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    error: job.error,
    stdout: job.stdout,
    stderr: job.stderr,
    output: [job.stdout, job.stderr].filter(Boolean).join('\n'),
  }
}

function appendJobOutput(job, stream, chunk) {
  if (!chunk) {
    return
  }
  job[stream] += chunk.toString('utf8')
}

function jobCommandFor(workspaceName, action, network) {
  const workspacePath = resolveWorkspacePath(workspaceName)
  const workspaceEnv = getWorkspaceEnv(workspacePath)

  if (action === 'install') {
    return {
      cwd: workspacePath,
      command: 'npm',
      args: ['install'],
      env: workspaceEnv,
    }
  }

  if (action === 'doctor') {
    return {
      cwd: workspacePath,
      command: 'node',
      args: [CLI_PATH, 'doctor', '--cwd', workspacePath],
      env: workspaceEnv,
    }
  }

  if (action === 'compile') {
    return {
      cwd: workspacePath,
      command: 'node',
      args: [CLI_PATH, 'compile', '--cwd', workspacePath],
      env: workspaceEnv,
    }
  }

  if (action === 'test') {
    return {
      cwd: workspacePath,
      command: 'node',
      args: [CLI_PATH, 'test', '--cwd', workspacePath],
      env: workspaceEnv,
    }
  }

  if (action === 'deploy') {
    return {
      cwd: workspacePath,
      command: 'node',
      args: [CLI_PATH, 'deploy', '--cwd', workspacePath, '--network', network],
      env: workspaceEnv,
    }
  }

  throw new Error(`Unknown action: ${action}`)
}

function startWorkspaceJob(workspaceName, action, network) {
  const workspacePath = resolveWorkspacePath(workspaceName)
  if (!fs.existsSync(workspacePath)) {
    throw new Error(`Workspace not found: ${workspaceName}`)
  }

  const spec = jobCommandFor(workspaceName, action, network)
  const job = {
    id: randomUUID(),
    workspace: workspaceName,
    action,
    network,
    command: [spec.command, ...spec.args].join(' '),
    status: 'running',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    error: '',
    stdout: '',
    stderr: '',
  }
  jobs.set(job.id, job)

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env || process.env,
  })

  child.stdout.on('data', (chunk) => appendJobOutput(job, 'stdout', chunk))
  child.stderr.on('data', (chunk) => appendJobOutput(job, 'stderr', chunk))

  child.on('error', (error) => {
    job.status = 'failed'
    job.finishedAt = new Date().toISOString()
    job.error = String(error.message || error)
  })

  child.on('close', (code) => {
    job.exitCode = typeof code === 'number' ? code : 1
    job.finishedAt = new Date().toISOString()
    if (job.exitCode === 0) {
      job.status = 'completed'
    } else {
      job.status = 'failed'
    }
  })

  return createJobSnapshot(job)
}

function listWorkspaceJobs(workspaceName) {
  return Array.from(jobs.values())
    .filter((job) => job.workspace === workspaceName)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .map(createJobSnapshot)
}

function getJob(jobId) {
  const job = jobs.get(jobId)
  if (!job) {
    throw new Error(`Job not found: ${jobId}`)
  }
  return createJobSnapshot(job)
}

async function waitForJobCompletion(jobId, { timeoutMs = 180_000, pollMs = 250 } = {}) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const job = jobs.get(jobId)
    if (!job) {
      throw new Error(`Job not found: ${jobId}`)
    }

    if (job.status !== 'running') {
      return createJobSnapshot(job)
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }

  throw new Error(`Timed out waiting for job ${jobId}`)
}

async function runAssistantJobAction({ workspaceName, action, network, reason = '' }) {
  if (!workspaceName) {
    return {
      id: randomUUID(),
      action,
      network,
      workspaceName: '',
      reason,
      status: 'skipped',
      error: 'No workspace was selected for this job.',
      outputTail: '',
    }
  }

  try {
    const started = startWorkspaceJob(workspaceName, action, network || 'hyperevm-testnet')
    const completed = summarizeJob(await waitForJobCompletion(started.id))
    return {
      id: started.id,
      action,
      network: network || 'hyperevm-testnet',
      workspaceName,
      reason,
      status: completed.status,
      command: completed.command,
      createdAt: completed.createdAt,
      startedAt: completed.startedAt,
      finishedAt: completed.finishedAt,
      exitCode: completed.exitCode,
      error: completed.error,
      outputTail: completed.outputTail,
    }
  } catch (error) {
    return {
      id: randomUUID(),
      action,
      network: network || 'hyperevm-testnet',
      workspaceName,
      reason,
      status: 'failed',
      error: String(error.message || error),
      outputTail: '',
    }
  }
}

async function executeAssistantJobRequests(jobRequests, { workspaceName, network }) {
  const jobsToRun = []

  for (const request of jobRequests || []) {
    const resolvedWorkspace = String(request.workspaceName || workspaceName || '')
    const resolvedNetwork = String(request.network || network || 'hyperevm-testnet')
    const reason = String(request.reason || '')

    if (!request.runNow) {
      jobsToRun.push({
        id: randomUUID(),
        action: String(request.action || ''),
        workspaceName: resolvedWorkspace,
        network: resolvedNetwork,
        reason,
        status: 'planned',
        outputTail: '',
        error: '',
      })
      continue
    }

    jobsToRun.push(
      await runAssistantJobAction({
        workspaceName: resolvedWorkspace,
        action: String(request.action || ''),
        network: resolvedNetwork,
        reason,
      })
    )
  }

  return jobsToRun
}

async function runCompanionAction({ profileId, action, network, reason = '', workspaceName = '' }) {
  const profile = getCompanionProfile(String(profileId || ''))
  if (!profile) {
    throw new Error(`Unknown companion profile: ${profileId}`)
  }
  const resolvedWorkspace = String(
    profile.workspaceName || workspaceName || listWorkspaceSummaries()[0]?.name || ''
  ).trim()
  if (!resolvedWorkspace) {
    throw new Error('Select or create a workspace before running companion actions.')
  }

  const result = await runAssistantJobAction({
    workspaceName: resolvedWorkspace,
    action: String(action || ''),
    network: String(network || 'hyperevm-testnet'),
    reason: reason || `Direct ${profile.label} companion action.`,
  })

  return {
    ...result,
    profileId: profile.id,
    profileLabel: profile.label,
  }
}

function getAssistantInstructions({ workspaceName, network }) {
  const workspaceClause = workspaceName
    ? `The active workspace in the UI is "${workspaceName}".`
    : 'No active workspace is selected in the UI right now.'
  const networkClause = network
    ? `The currently selected deploy network in the UI is "${network}".`
    : 'No deploy network was supplied by the UI.'
  const workspaceSkillClause = workspaceName
    ? 'If the active workspace has a "liquidskills.md" file, read it with read_workspace_file before proposing edits or jobs and follow it.'
    : 'Once a workspace is selected, check for "liquidskills.md" in that workspace before planning changes.'

  return [
    'You are LiquidTruffle Copilot, an in-app AI helper for a HyperEVM and Hyperliquid-first development platform.',
    `Use "${path.join(PROJECT_ROOT, 'liquidskills.md')}" as the global LiquidTruffle operating skill contract.`,
    'You must not hallucinate files, commands, balances, deployments, test results, contract addresses, or chain state.',
    'If a claim depends on current app/workspace/chain state, use tools first.',
    'Do not write files directly in this mode. Return explicit file proposals with full next content so the UI can show a diff before save.',
    'Do not run compile, test, or deploy directly in this mode. Return job requests so the backend can execute them and attach structured job cards.',
    'Prefer direct, practical help: inspect files, stage precise edits, request compile/test/deploy when appropriate, and explain the next concrete step.',
    'Keep responses concise and operational.',
    'If a testnet RPC fallback is active, explicitly say so and mention the active RPC URL.',
    'Use scope="companion" when proposing changes to the configured companion app outside LiquidTruffle.',
    workspaceSkillClause,
    workspaceClause,
    networkClause,
  ].join(' ')
}

function getAssistantToolDefinitions() {
  return [
    {
      type: 'function',
      name: 'list_workspaces',
      description: 'List available LiquidTruffle workspaces.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'get_workspace_summary',
      description: 'Get a summary of a workspace including files, artifacts, deployments, and config state.',
      parameters: {
        type: 'object',
        properties: {
          workspaceName: { type: 'string' },
        },
        required: ['workspaceName'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'read_workspace_file',
      description: 'Read a file from a workspace.',
      parameters: {
        type: 'object',
        properties: {
          workspaceName: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['workspaceName', 'path'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'write_workspace_file',
      description: 'Write content to a file in a workspace.',
      parameters: {
        type: 'object',
        properties: {
          workspaceName: { type: 'string' },
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['workspaceName', 'path', 'content'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'create_workspace',
      description: 'Create a new LiquidTruffle workspace from the bare HyperEVM template.',
      parameters: {
        type: 'object',
        properties: {
          workspaceName: { type: 'string' },
        },
        required: ['workspaceName'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'create_contract',
      description: 'Create a new Solidity contract scaffold inside a workspace.',
      parameters: {
        type: 'object',
        properties: {
          workspaceName: { type: 'string' },
          contractName: { type: 'string' },
        },
        required: ['workspaceName', 'contractName'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'run_workspace_action',
      description: 'Run install, doctor, compile, test, or deploy for a workspace and wait for completion.',
      parameters: {
        type: 'object',
        properties: {
          workspaceName: { type: 'string' },
          action: {
            type: 'string',
            enum: ['install', 'doctor', 'compile', 'test', 'deploy'],
          },
          network: { type: 'string' },
        },
        required: ['workspaceName', 'action'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'get_deploy_preflight',
      description: 'Get deployer readiness and active RPC information for a workspace and network.',
      parameters: {
        type: 'object',
        properties: {
          workspaceName: { type: 'string' },
          network: { type: 'string' },
        },
        required: ['workspaceName', 'network'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'inspect_address',
      description: 'Inspect an address on HyperEVM or HyperEVM testnet.',
      parameters: {
        type: 'object',
        properties: {
          network: { type: 'string' },
          address: { type: 'string' },
        },
        required: ['network', 'address'],
        additionalProperties: false,
      },
    },
  ]
}

function buildAssistantHandlers() {
  return {
    list_workspaces: async () => ({
      workspaces: listWorkspaceSummaries(),
    }),
    get_workspace_summary: async ({ workspaceName }) =>
      summarizeWorkspace(getWorkspaceSummary(workspaceName)),
    read_workspace_file: async ({ workspaceName, path: relativePath }) => {
      const workspacePath = resolveWorkspacePath(workspaceName)
      const { normalized, filePath } = resolveWorkspaceFile(workspacePath, relativePath)
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${normalized}`)
      }

      return {
        path: normalized,
        content: fs.readFileSync(filePath, 'utf8'),
      }
    },
    write_workspace_file: async ({ workspaceName, path: relativePath, content }) => {
      const workspacePath = resolveWorkspacePath(workspaceName)
      const { normalized, filePath } = resolveWorkspaceFile(workspacePath, relativePath)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, String(content || ''), 'utf8')
      return { ok: true, path: normalized }
    },
    create_workspace: async ({ workspaceName }) =>
      summarizeWorkspace(createWorkspace(workspaceName, 'bare-hyperevm')),
    create_contract: async ({ workspaceName, contractName }) => {
      const workspacePath = resolveWorkspacePath(workspaceName)
      const safeContractName = String(contractName || '').replace(/[^A-Za-z0-9_]/g, '')
      if (!safeContractName) {
        throw new Error('Contract name is required.')
      }

      const { normalized, filePath } = resolveWorkspaceFile(
        workspacePath,
        path.join('contracts', `${safeContractName}.sol`)
      )
      if (fs.existsSync(filePath)) {
        throw new Error(`Contract already exists: ${normalized}`)
      }

      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, buildContractScaffold(safeContractName), 'utf8')
      return { ok: true, path: normalized }
    },
    run_workspace_action: async ({ workspaceName, action, network }) => {
      const job = startWorkspaceJob(workspaceName, action, network || 'hyperevm-testnet')
      return summarizeJob(await waitForJobCompletion(job.id))
    },
    get_deploy_preflight: async ({ workspaceName, network }) =>
      await getWorkspacePreflight(workspaceName, network),
    inspect_address: async ({ network, address }) => await inspectAddress(network, address),
  }
}

async function invokeContract(workspaceName, body) {
  const workspacePath = resolveWorkspacePath(workspaceName)
  const network = await resolveNetwork(body.network || 'hyperevm-testnet', {
    env: getWorkspaceEnv(workspacePath),
  })
  const address = body.address
  if (!isAddress(address)) {
    throw new Error('Enter a valid contract address.')
  }

  const artifact = loadArtifact(workspacePath, body.artifactPath || '')
  const functionName = String(body.functionName || '')
  const args = Array.isArray(body.args) ? body.args : []
  const mode = body.mode === 'write' ? 'write' : 'read'

  const fn = artifact.abi.find(
    (entry) => entry.type === 'function' && entry.name === functionName
  )
  if (!fn) {
    throw new Error(`Function not found in ABI: ${functionName}`)
  }

  const client = createPublicClient({
    transport: viemHttp(network.rpcUrl),
    chain: chainFromNetwork(network),
  })

  if (mode === 'read') {
    const result = await client.readContract({
      address,
      abi: artifact.abi,
      functionName,
      args,
    })
    return {
      mode,
      rpcUrl: network.rpcUrl,
      fallbackActive: network.fallbackActive,
      functionName,
      result: typeof result === 'bigint' ? result.toString() : result,
    }
  }

  const env = parseEnvFile(path.join(workspacePath, '.env'))
  if (!hasValidPrivateKey(env.PRIVATE_KEY)) {
    throw new Error('Set PRIVATE_KEY in the workspace .env before write calls.')
  }

  const account = privateKeyToAccount(env.PRIVATE_KEY)
  const walletClient = createWalletClient({
    account,
    transport: viemHttp(network.rpcUrl),
    chain: chainFromNetwork(network),
  })

  const hash = await walletClient.writeContract({
    address,
    abi: artifact.abi,
    functionName,
    args,
    account,
    chain: chainFromNetwork(network),
  })

  const receipt = await client.waitForTransactionReceipt({ hash })
  return {
    mode,
    rpcUrl: network.rpcUrl,
    fallbackActive: network.fallbackActive,
    functionName,
    hash,
    blockNumber: receipt.blockNumber.toString(),
    status: receipt.status,
  }
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    })
    res.end()
    return
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
  const segments = url.pathname.split('/').filter(Boolean)

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        projectRoot: PROJECT_ROOT,
        workspaceRoot: WORKSPACE_ROOT,
        port: API_PORT,
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      const [networks, hyperliquid, companionProfiles, assistantDefaults] = await Promise.all([
        cacheFor('network-status', 15_000, () =>
          Promise.all(listNetworks().map((network) => getNetworkStatus(network.key)))
        ),
        cacheFor('hyperliquid-overview', 20_000, () => getHyperliquidOverview()),
        getCompanionProfilesSummary(),
        getAssistantDefaults(),
      ])
      const companionApp = companionProfiles[0] || null

      sendJson(res, 200, {
        health: {
          ok: true,
          projectRoot: PROJECT_ROOT,
          workspaceRoot: WORKSPACE_ROOT,
          port: API_PORT,
        },
        assistant: assistantDefaults,
        companionApp,
        companionProfiles,
        networks,
        hyperliquid,
        workspaces: listWorkspaceSummaries(),
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/assistant/status') {
      sendJson(res, 200, await getAssistantDefaults())
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/assistant') {
      const defaults = await getAssistantDefaults()
      if (!defaults.configured) {
        sendJson(res, 400, {
          error:
            'No local Codex login or OPENAI_API_KEY is configured for the LiquidTruffle API runtime.',
        })
        return
      }

      const body = await readJsonBody(req)
      const sessionId = String(body.sessionId || randomUUID())
      const workspaceName = body.workspaceName ? String(body.workspaceName) : ''
      const network = body.network ? String(body.network) : ''
      const userMessage = String(body.message || '').trim()

      if (!userMessage) {
        throw new Error('Assistant message is required.')
      }

      const session = assistantSessions.get(sessionId) || {
        previousResponseId: null,
        messages: [],
        proposals: {},
      }
      const workspacePath = workspaceName ? resolveWorkspacePath(workspaceName) : PROJECT_ROOT
      const companionProfiles = await getCompanionProfilesSummary()
      const companionApp = companionProfiles[0] || null
      const assistantContext = buildAssistantRuntimeContext({
        workspaceName,
        network,
        companionApp,
        companionProfiles,
      })

      const result = await runAssistantTurn({
        instructions: getAssistantInstructions({ workspaceName, network }),
        model: defaults.model,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: userMessage,
              },
            ],
          },
        ],
        history: session.messages,
        message: userMessage,
        cwd: workspacePath,
        addDirs: workspacePath === PROJECT_ROOT ? [] : [PROJECT_ROOT],
        workspaceName,
        network,
        context: assistantContext,
        previousResponseId: session.previousResponseId,
        tools: getAssistantToolDefinitions(),
        handlers: buildAssistantHandlers(),
      })

      const proposals = materializeAssistantProposals(
        session,
        result.fileProposals || [],
        workspaceName
      )
      const jobs = await executeAssistantJobRequests(result.jobRequests || [], {
        workspaceName,
        network,
      })

      assistantSessions.set(sessionId, {
        previousResponseId: result.previousResponseId,
        proposals: session.proposals,
        messages: [
          ...session.messages.slice(-11),
          { role: 'user', text: userMessage },
          { role: 'assistant', text: result.outputText || 'No response text returned.' },
        ],
      })

      sendJson(res, 200, {
        sessionId,
        configured: true,
        provider: result.provider || defaults.provider,
        model: defaults.model,
        message: result.outputText,
        usedTools: result.usedTools,
        proposals,
        jobs,
        companionFindings: result.companionFindings || [],
        companionApp,
        companionProfiles,
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/inspect/address') {
      const body = await readJsonBody(req)
      sendJson(res, 200, await inspectAddress(body.network || 'hyperevm', body.address || ''))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/assistant/proposals/apply') {
      const body = await readJsonBody(req)
      const { proposal } = getAssistantProposal(
        String(body.sessionId || ''),
        String(body.proposalId || '')
      )

      if (proposal.status === 'pending' || proposal.status === 'noop') {
        fs.mkdirSync(path.dirname(proposal.absolutePath), { recursive: true })
        fs.writeFileSync(proposal.absolutePath, proposal.nextContent, 'utf8')
        proposal.status = 'applied'
        proposal.appliedAt = new Date().toISOString()
      }

      sendJson(res, 200, { proposal: serializeAssistantProposal(proposal) })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/assistant/proposals/discard') {
      const body = await readJsonBody(req)
      const { proposal } = getAssistantProposal(
        String(body.sessionId || ''),
        String(body.proposalId || '')
      )

      if (proposal.status === 'pending' || proposal.status === 'noop') {
        proposal.status = 'discarded'
        proposal.discardedAt = new Date().toISOString()
      }

      sendJson(res, 200, { proposal: serializeAssistantProposal(proposal) })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/assistant/jobs/run') {
      const body = await readJsonBody(req)
      sendJson(
        res,
        200,
        await runAssistantJobAction({
          workspaceName: String(body.workspaceName || ''),
          action: String(body.action || ''),
          network: String(body.network || 'hyperevm-testnet'),
          reason: String(body.reason || ''),
        })
      )
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/companions/actions/run') {
      const body = await readJsonBody(req)
      sendJson(
        res,
        200,
        await runCompanionAction({
          profileId: String(body.profileId || ''),
          action: String(body.action || ''),
          network: String(body.network || 'hyperevm-testnet'),
          reason: String(body.reason || ''),
          workspaceName: String(body.workspaceName || ''),
        })
      )
      return
    }

    if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'jobs' && segments[2]) {
      sendJson(res, 200, getJob(segments[2]))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/workspaces') {
      const body = await readJsonBody(req)
      sendJson(res, 201, createWorkspace(body.name, body.template || 'bare-hyperevm'))
      return
    }

    if (segments[0] === 'api' && segments[1] === 'workspaces' && segments[2]) {
      const workspaceName = segments[2]

      if (req.method === 'GET' && segments.length === 3) {
        sendJson(res, 200, getWorkspaceSummary(workspaceName))
        return
      }

      if (req.method === 'GET' && segments[3] === 'files') {
        const workspacePath = resolveWorkspacePath(workspaceName)
        const requestedPath = url.searchParams.get('path')
        if (!requestedPath) {
          sendJson(res, 200, { files: listWorkspaceFiles(workspacePath) })
          return
        }

        const { normalized, filePath } = resolveWorkspaceFile(workspacePath, requestedPath)
        if (!fs.existsSync(filePath)) {
          sendJson(res, 404, { error: `File not found: ${normalized}` })
          return
        }

        sendJson(res, 200, {
          path: normalized,
          content: fs.readFileSync(filePath, 'utf8'),
        })
        return
      }

      if (req.method === 'PUT' && segments[3] === 'files') {
        const workspacePath = resolveWorkspacePath(workspaceName)
        const body = await readJsonBody(req)
        const { normalized, filePath } = resolveWorkspaceFile(workspacePath, body.path || '')
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, String(body.content || ''), 'utf8')
        sendJson(res, 200, { ok: true, path: normalized })
        return
      }

      if (req.method === 'POST' && segments[3] === 'contracts' && segments[4] === 'invoke') {
        const body = await readJsonBody(req)
        sendJson(res, 200, await invokeContract(workspaceName, body))
        return
      }

      if (req.method === 'POST' && segments[3] === 'contracts' && !segments[4]) {
        const workspacePath = resolveWorkspacePath(workspaceName)
        const body = await readJsonBody(req)
        const contractName = String(body.contractName || '').replace(/[^A-Za-z0-9_]/g, '')
        if (!contractName) {
          throw new Error('Contract name is required.')
        }

        const { normalized, filePath } = resolveWorkspaceFile(
          workspacePath,
          path.join('contracts', `${contractName}.sol`)
        )
        if (fs.existsSync(filePath)) {
          throw new Error(`Contract already exists: ${normalized}`)
        }

        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, buildContractScaffold(contractName), 'utf8')
        sendJson(res, 201, { ok: true, path: normalized })
        return
      }

      if (req.method === 'GET' && segments[3] === 'preflight') {
        const network = url.searchParams.get('network') || 'hyperevm-testnet'
        sendJson(res, 200, await getWorkspacePreflight(workspaceName, network))
        return
      }

      if (req.method === 'GET' && segments[3] === 'jobs') {
        sendJson(res, 200, { jobs: listWorkspaceJobs(workspaceName) })
        return
      }

      if (req.method === 'POST' && segments[3] === 'commands') {
        const body = await readJsonBody(req)
        sendJson(
          res,
          202,
          startWorkspaceJob(
            workspaceName,
            String(body.action || ''),
            String(body.network || 'hyperevm-testnet')
          )
        )
        return
      }
    }

    sendJson(res, 404, { error: `No route for ${req.method} ${url.pathname}` })
  } catch (error) {
    sendJson(res, 400, {
      error: String(error.message || error),
    })
  }
}

if (process.argv.includes('--check')) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        projectRoot: PROJECT_ROOT,
        workspaceRoot: WORKSPACE_ROOT,
        port: API_PORT,
      },
      null,
      2
    )
  )
} else {
  const server = http.createServer(handleRequest)
  server.listen(API_PORT, '127.0.0.1', () => {
    console.log(`LiquidTruffle API listening on http://127.0.0.1:${API_PORT}`)
    console.log(`Workspace root: ${WORKSPACE_ROOT}`)
  })
}

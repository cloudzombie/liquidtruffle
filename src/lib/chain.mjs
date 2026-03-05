const RPC_RESOLUTION_TTL_MS = 30_000
const resolutionCache = new Map()

const NETWORK_DEFINITIONS = {
  hyperevm: {
    key: 'hyperevm',
    name: 'HyperEVM Mainnet',
    chainId: 999,
    envKey: 'HYPEREVM_RPC',
    fallbackEnvKey: 'HYPEREVM_RPC_FALLBACKS',
    defaultRpcUrls: ['https://rpc.hyperliquid.xyz/evm'],
    wrappedNative: '0x5555555555555555555555555555555555555555',
  },
  'hyperevm-testnet': {
    key: 'hyperevm-testnet',
    name: 'HyperEVM Testnet',
    chainId: 998,
    envKey: 'HYPEREVM_TESTNET_RPC',
    fallbackEnvKey: 'HYPEREVM_TESTNET_RPC_FALLBACKS',
    defaultRpcUrls: ['https://rpc.hyperliquid-testnet.xyz/evm'],
    builtInFallbackRpcUrls: ['https://998.rpc.thirdweb.com'],
    wrappedNative: null,
  },
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function cacheKeyForNetwork(network) {
  return JSON.stringify([network.key, network.rpcCandidates])
}

function normalizeChainId(value) {
  if (typeof value === 'string' && value.startsWith('0x')) {
    return Number.parseInt(value, 16)
  }
  return Number(value)
}

export function getNetwork(name = 'hyperevm', { env = process.env } = {}) {
  const definition = NETWORK_DEFINITIONS[name]
  if (!definition) {
    const known = Object.keys(NETWORK_DEFINITIONS).join(', ')
    throw new Error(`Unknown network "${name}". Known networks: ${known}`)
  }

  const configuredPrimary = String(env[definition.envKey] || '').trim()
  const configuredFallbacks = splitCsv(env[definition.fallbackEnvKey])
  const useImplicitCandidates = !configuredPrimary && configuredFallbacks.length === 0
  const rpcCandidates = unique([
    configuredPrimary,
    ...configuredFallbacks,
    ...(useImplicitCandidates ? definition.defaultRpcUrls || [] : []),
    ...(useImplicitCandidates ? definition.builtInFallbackRpcUrls || [] : []),
  ])

  return {
    ...definition,
    rpcUrl: rpcCandidates[0],
    configuredRpcUrl: rpcCandidates[0],
    rpcCandidates,
  }
}

export function listNetworks(options = {}) {
  return Object.keys(NETWORK_DEFINITIONS).map((name) => getNetwork(name, options))
}

export async function probeRpcUrl(
  rpcUrl,
  expectedChainId,
  { fetchImpl = globalThis.fetch, timeoutMs = 4_000 } = {}
) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available in this runtime')
  }

  const response = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_chainId',
      params: [],
    }),
    signal: AbortSignal?.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  const payload = await response.json()
  if (payload?.error) {
    throw new Error(payload.error.message || JSON.stringify(payload.error))
  }

  const chainId = normalizeChainId(payload?.result)
  if (chainId !== expectedChainId) {
    throw new Error(`expected chain ${expectedChainId}, received ${chainId}`)
  }

  return {
    rpcUrl,
    chainId,
  }
}

export async function resolveNetwork(
  name = 'hyperevm',
  { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 4_000, cacheTtlMs = RPC_RESOLUTION_TTL_MS } = {}
) {
  const network = getNetwork(name, { env })
  const cacheKey = cacheKeyForNetwork(network)
  const cached = resolutionCache.get(cacheKey)
  const now = Date.now()

  if (cached && cached.expiresAt > now) {
    return cached.value
  }

  const attempts = []

  for (const [index, rpcUrl] of network.rpcCandidates.entries()) {
    try {
      await probeRpcUrl(rpcUrl, network.chainId, { fetchImpl, timeoutMs })
      const resolved = {
        ...network,
        rpcUrl,
        activeRpcUrl: rpcUrl,
        activeRpcIndex: index,
        fallbackActive: index > 0,
        rpcAttempts: attempts,
      }

      resolutionCache.set(cacheKey, {
        value: resolved,
        expiresAt: now + cacheTtlMs,
      })
      return resolved
    } catch (error) {
      attempts.push({
        rpcUrl,
        error: String(error.message || error),
      })
    }
  }

  const failure = new Error(
    `No reachable RPC for ${network.name}. Tried ${network.rpcCandidates.length} candidate${network.rpcCandidates.length === 1 ? '' : 's'}.`
  )
  failure.attempts = attempts
  throw failure
}

export function getRpcEnvOverrides(network) {
  return {
    [network.envKey]: network.rpcUrl,
  }
}

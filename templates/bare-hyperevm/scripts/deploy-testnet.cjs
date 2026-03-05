const { execFileSync, spawnSync } = require('node:child_process')

const CHAIN_ID = 998
const CANDIDATES = [
  process.env.HYPEREVM_TESTNET_RPC,
  ...String(process.env.HYPEREVM_TESTNET_RPC_FALLBACKS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
  'https://rpc.hyperliquid-testnet.xyz/evm',
  'https://998.rpc.thirdweb.com',
].filter(Boolean)

function unique(values) {
  return [...new Set(values)]
}

function resolveTestnetRpc() {
  const candidates = unique(CANDIDATES)

  for (const rpcUrl of candidates) {
    try {
      const output = execFileSync(
        process.execPath,
        [
          '-e',
          `
            ;(async () => {
              const rpcUrl = process.env.LT_RPC_URL
              const expected = Number(process.env.LT_CHAIN_ID)
              const response = await fetch(rpcUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: 1,
                  method: 'eth_chainId',
                  params: [],
                }),
                signal: AbortSignal.timeout(4000),
              })
              if (!response.ok) process.exit(1)
              const payload = await response.json()
              const chainId = typeof payload.result === 'string' && payload.result.startsWith('0x')
                ? parseInt(payload.result, 16)
                : Number(payload.result)
              if (chainId !== expected) process.exit(1)
              process.stdout.write(rpcUrl)
            })().catch(() => process.exit(1))
          `,
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          env: {
            ...process.env,
            LT_RPC_URL: rpcUrl,
            LT_CHAIN_ID: String(CHAIN_ID),
          },
        }
      )

      return output.trim() || rpcUrl
    } catch {}
  }

  return candidates[0]
}

const resolvedRpc = resolveTestnetRpc()
const primaryRpc = unique(CANDIDATES)[0]

if (resolvedRpc && primaryRpc && resolvedRpc !== primaryRpc) {
  console.log(`Using fallback HyperEVM testnet RPC: ${resolvedRpc}`)
}

const result = spawnSync(
  'npx',
  ['hardhat', 'run', 'scripts/deploy.cjs', '--network', 'hyperevm-testnet'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      HYPEREVM_TESTNET_RPC: resolvedRpc,
    },
  }
)

process.exit(typeof result.status === 'number' ? result.status : 1)

require('@nomicfoundation/hardhat-toolbox')
require('dotenv').config()

const PRIVATE_KEY = process.env.PRIVATE_KEY
const ACCOUNTS = /^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY || '') ? [PRIVATE_KEY] : []

module.exports = {
  solidity: {
    version: '0.8.23',
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hyperevm: {
      url: process.env.HYPEREVM_RPC || 'https://rpc.hyperliquid.xyz/evm',
      chainId: 999,
      accounts: ACCOUNTS,
    },
    'hyperevm-testnet': {
      url: process.env.HYPEREVM_TESTNET_RPC || 'https://rpc.hyperliquid-testnet.xyz/evm',
      chainId: 998,
      accounts: ACCOUNTS,
    },
    hardhat: {
      chainId: 31337,
    },
  },
}

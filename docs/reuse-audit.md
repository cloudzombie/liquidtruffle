# Reuse Audit

This file separates three buckets:

1. What can be reused from Truffle conceptually or legally.
2. What Hyperliquid already provides.
3. What should not be ported in v1.

## Reuse from Truffle now

The archived Truffle repo is published on GitHub under MIT according to the repo page:

- <https://github.com/trufflesuite/truffle>

Safe to reuse at the product-design level:

- command taxonomy: `init`, `unbox`, `compile`, `test`, `console`, `deploy`
- starter-template mindset
- numbered migration mental model
- dashboard concept for browser-wallet signing
- docs information architecture: getting started, config, commands, deploy, test, debug

Potentially reusable with selective code copy, but only after review:

- small utility helpers from the archived CLI
- template layout ideas
- artifact naming conventions

Avoid direct carry-over unless there is a hard reason:

- old Web3.js contract abstraction layers
- Ganache assumptions
- debugger internals
- DB and decoder internals tied to Ethereum JSON-RPC/debug pipelines

## What Hyperliquid already built

Use directly:

- HyperEVM mainnet/testnet RPC and chain IDs
- Wrapped HYPE address on mainnet
- official docs for deployment constraints
- official local node for historical-state querying

Do not rebuild:

- the base chain
- raw JSON-RPC transport
- chain docs
- the big-block mechanism itself

## What the broader ecosystem already built

Use directly:

- Hardhat for compile/test/deploy scripts: <https://hardhat.org/>
- viem for RPC clients and console ergonomics: <https://viem.sh/>
- wagmi for wallet-facing frontend integrations: <https://wagmi.sh/>

The right V1 architecture is:

- Hyperliquid for chain facts and constraints
- Hardhat for dev workflow plumbing
- viem for runtime interaction
- `liquidtruffle` for Hyperliquid-specific defaults, templates, and guardrails

## What still needs to be built by `liquidtruffle`

- a HyperEVM-first project starter
- a clean CLI wrapper around Hardhat tasks
- a Hyperliquid-specific doctor/preflight command
- docs that explain big-block deployment and RPC method gaps
- eventually, a browser-wallet dashboard and richer deployment UX

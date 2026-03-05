# Truffle vs HyperEVM Build Matrix

This matrix answers two questions:

1. What did Truffle actually provide?
2. What does a Hyperliquid-native replacement need to ship first?

## Core matrix

| Truffle surface | Official evidence | Needed for Hyperliquid | Reuse instead of rebuild | `liquidtruffle` decision |
|---|---|---|---|---|
| Project bootstrap: `truffle init` | [Command line docs](https://archive.trufflesuite.com/docs/truffle/reference/command-line-options/) | Yes | Copy template-driven scaffolding pattern | Build now |
| Starter apps: `truffle unbox` + Boxes | [Boxes page](https://archive.trufflesuite.com/boxes/) | Yes | Curated HyperEVM templates | Build now, with one starter |
| Compile pipeline: `truffle compile` | [Command line docs](https://archive.trufflesuite.com/docs/truffle/reference/command-line-options/) | Yes | Hardhat compile | Reuse |
| Network config: `truffle-config.js` | [Configuration docs](https://archive.trufflesuite.com/docs/truffle/reference/configuration/) | Yes | Hardhat config + small `liquidtruffle` wrapper | Reuse and wrap |
| Deployments: `truffle migrate` / `truffle deploy` | [Migrate command docs](https://archive.trufflesuite.com/docs/truffle/reference/truffle-commands/#migrate) | Yes | Hardhat scripts | Reuse now; add numbered migrations later |
| Tests: `truffle test` | [Testing docs](https://archive.trufflesuite.com/docs/truffle/how-to/debug-test/test-your-contracts/) | Yes | Hardhat test | Reuse |
| REPL: `truffle console` | [Command line docs](https://archive.trufflesuite.com/docs/truffle/reference/command-line-options/) | Yes | viem-backed REPL | Build now |
| Debugger: `truffle debug` | [Debugger docs](https://archive.trufflesuite.com/docs/truffle/how-to/debug-test/debugging-your-contracts/) | Valuable but blocked | HyperEVM omits `debug_*` JSON-RPC methods per docs | Defer |
| Browser-wallet deployment via Dashboard | [Dashboard docs](https://archive.trufflesuite.com/docs/truffle/how-to/running-contracts/interact-with-your-contracts-via-truffle-dashboard/) | Useful | wagmi + EIP-1193 wallet flows | Defer |
| Contract abstractions and artifact schema | [Contract abstractions docs](https://archive.trufflesuite.com/docs/truffle/how-to/contracts/run-an-external-script/) | Useful | Hardhat artifacts + viem clients | Adapt later |
| Truffle DB | [DB docs](https://archive.trufflesuite.com/docs/truffle/db/overview/) | Optional | Indexer or Postgres later | Skip v1 |
| Ganache integration | [Ganache docs hub](https://archive.trufflesuite.com/docs/ganache/) | No | Hardhat Network / Anvil for local tests | Do not rebuild |

## HyperEVM-specific requirements not present in classic Truffle

| HyperEVM requirement | Official evidence | Impact on tool design |
|---|---|---|
| Mainnet/testnet chain IDs and RPCs differ from Ethereum defaults | [HyperEVM quickstart](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) | Template must ship first-class HyperEVM network presets |
| HyperEVM supports most JSON-RPC but omits `debug_*`, `admin_*`, `engine_*`, `txpool_*`, and `sign*` | [HyperEVM quickstart](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) | No credible `truffle debug` clone in v1 |
| Contracts above the default 2M gas core block limit may need the big-block flow | [Deploying contracts](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/deploying-contracts) | Tooling needs a deploy preflight and docs for big blocks |
| HyperEVM has no official frontend libs/components | [Using HyperEVM in frontend apps](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hyperevm) | Frontend dashboard/UI should reuse wagmi or other third-party tools |
| HyperEVM local node exists for historical state query | [Local node](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/nodes/local-node) | Good for read-side workflows, not a Ganache replacement |

## V1 product cut

Build first:

- `init`
- `unbox`
- `compile`
- `test`
- `deploy`
- `console`
- `doctor`
- signer preflight visibility in UI (breathing key-status light in header + copilot surfaces)

Delay until the chain workflow is proven:

- debugger
- dashboard
- DB/indexing product
- plugin system
- migration compatibility layer for legacy Truffle projects

## Why Hardhat + viem is the right reuse path

- Hardhat already covers the compile/test/run/deploy path Truffle used to own.
- viem is a better modern primitive for a HyperEVM console than reviving `@truffle/contract`.
- Hyperliquid docs explicitly point frontend developers to third-party libraries instead of official EVM UI kits.

That means `liquidtruffle` should be a thin Hyperliquid opinion layer, not a full monolith.

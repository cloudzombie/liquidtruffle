const fs = require('node:fs')
const path = require('node:path')
const hre = require('hardhat')

async function main() {
  const { ethers, network } = hre
  const [deployer] = await ethers.getSigners()
  const providerNetwork = await ethers.provider.getNetwork()

  console.log('Deploying with:', deployer.address)
  console.log('Network:', network.name)
  console.log('Chain ID:', providerNetwork.chainId.toString())

  const Factory = await ethers.getContractFactory('Counter')
  const contract = await Factory.deploy()
  const deploymentTx = contract.deploymentTransaction()

  if (deploymentTx) {
    console.log('Deployment tx:', deploymentTx.hash)
  }

  await contract.waitForDeployment()

  const address = await contract.getAddress()
  const receipt = deploymentTx ? await deploymentTx.wait() : null
  console.log('Counter deployed at:', address)

  const deploymentsDir = path.join(process.cwd(), 'deployments')
  fs.mkdirSync(deploymentsDir, { recursive: true })

  const deploymentPath = path.join(deploymentsDir, `${network.name}.json`)
  const existing = fs.existsSync(deploymentPath)
    ? JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))
    : {
        network: network.name,
        chainId: providerNetwork.chainId.toString(),
        deployments: [],
      }

  existing.updatedAt = new Date().toISOString()
  existing.network = network.name
  existing.chainId = providerNetwork.chainId.toString()
  existing.deployments = Array.isArray(existing.deployments) ? existing.deployments : []
  existing.deployments.push({
    contractName: 'Counter',
    address,
    deployer: deployer.address,
    txHash: deploymentTx ? deploymentTx.hash : null,
    blockNumber: receipt?.blockNumber?.toString() || null,
    deployedAt: new Date().toISOString(),
  })

  fs.writeFileSync(deploymentPath, JSON.stringify(existing, null, 2))
  console.log('Deployment metadata written to:', deploymentPath)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

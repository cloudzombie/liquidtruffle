const { expect } = require('chai')
const { ethers } = require('hardhat')

describe('Counter', function () {
  it('increments', async function () {
    const Factory = await ethers.getContractFactory('Counter')
    const counter = await Factory.deploy()
    await counter.waitForDeployment()

    await counter.increment()
    expect(await counter.number()).to.equal(1n)
  })
})

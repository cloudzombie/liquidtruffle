// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Counter {
    uint256 public number;

    function increment() external {
        number += 1;
    }

    function setNumber(uint256 newNumber) external {
        number = newNumber;
    }
}

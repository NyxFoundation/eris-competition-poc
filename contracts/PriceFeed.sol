// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PriceFeed
/// @notice 環境（coordinator）が毎ブロック fair price を書き込む専用配布コントラクト（ADR 0006 §3）。
///         observation の stdin push を廃止した後、agent はこれを読んで fair price を知る。
///         uniswap pool 価格との乖離が裁定シグナル、という構図は不変。
///         書込は owner（環境の admin ウォレット）のみ。agent による改竄を防ぐ。
contract PriceFeed {
    address public immutable owner;
    int256 private _answer; // USDC per WETH（8 桁固定小数。例: $3000 -> 3000_00000000）
    uint256 private _updatedAtBlock;

    uint8 public constant decimals = 8;

    event PriceUpdated(int256 answer, uint256 blockNumber);

    constructor(int256 initialAnswer) {
        owner = msg.sender;
        _answer = initialAnswer;
        _updatedAtBlock = block.number;
    }

    function setPrice(int256 answer) external {
        require(msg.sender == owner, "PriceFeed: not owner");
        _answer = answer;
        _updatedAtBlock = block.number;
        emit PriceUpdated(answer, block.number);
    }

    function latestAnswer() external view returns (int256) {
        return _answer;
    }

    function updatedAtBlock() external view returns (uint256) {
        return _updatedAtBlock;
    }
}

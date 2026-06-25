// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PriceFeed
/// @notice 環境（coordinator）が毎ブロック fair price を書き込む専用配布コントラクト（ADR 0006 §3）。
///         observation の stdin push を廃止した後、agent はこれを読んで fair price を知る。
///         uniswap pool 価格との乖離が裁定シグナル、という構図は不変。
///         書込は owner（環境の admin ウォレット）のみ。agent による改竄を防ぐ。
///
///         ADR 0013（マルチアセット化）: WETH 価格は従来どおり _answer(slot 0) に置き、
///         latestAnswer/setPrice/updatedAtBlock の互換 API・storage slot を維持する。追加 base
///         （WBTC 等）は _answers マッピング(slot 2)に置き、setPriceFor/answerOf で読み書きする。
///         storage 直書き(ADR 0011)の slot 0/1 は不変なので economic-gas 経路も無改修。
contract PriceFeed {
    address public immutable owner;
    int256 private _answer; // WETH。USDC per WETH（8 桁固定小数。例: $3000 -> 3000_00000000）。slot 0
    uint256 private _updatedAtBlock; // slot 1
    mapping(address => int256) private _answers; // ADR 0013: 追加 base の USD 価格。slot 2
    mapping(address => uint256) private _answerUpdatedAtBlock; // slot 3

    uint8 public constant decimals = 8;

    event PriceUpdated(int256 answer, uint256 blockNumber);
    event PriceUpdatedFor(
        address indexed token,
        int256 answer,
        uint256 blockNumber
    );

    constructor(int256 initialAnswer) {
        owner = msg.sender;
        _answer = initialAnswer;
        _updatedAtBlock = block.number;
    }

    // ---- WETH（後方互換 API。slot 0/1）----
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

    // ---- 追加 base（ADR 0013。slot 2 マッピング）----
    function setPriceFor(address token, int256 answer) external {
        require(msg.sender == owner, "PriceFeed: not owner");
        _answers[token] = answer;
        _answerUpdatedAtBlock[token] = block.number;
        emit PriceUpdatedFor(token, answer, block.number);
    }

    function answerOf(address token) external view returns (int256) {
        return _answers[token];
    }

    function answerUpdatedAtBlockOf(
        address token
    ) external view returns (uint256) {
        return _answerUpdatedAtBlock[token];
    }
}

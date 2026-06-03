// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockAggregator
/// @notice Aave V3 の AaveOracle が呼ぶ Chainlink 互換アグリゲータのモック。
///         AaveOracle.getAssetPrice は source.latestAnswer() を呼ぶだけなので、
///         setAnswer で任意の USD 価格（8 桁）を注入できる「制御可能オラクル」。
contract MockAggregator {
    int256 private _answer;
    uint8 public constant decimals = 8;
    uint80 private _roundId;
    uint256 private _updatedAt;

    event AnswerUpdated(int256 indexed answer, uint256 updatedAt);

    constructor(int256 initialAnswer) {
        _set(initialAnswer);
    }

    /// @notice 価格を設定（USD・8 桁。例: $3000 -> 3000_00000000）。
    function setAnswer(int256 answer) external {
        _set(answer);
    }

    function _set(int256 answer) internal {
        _answer = answer;
        _roundId += 1;
        _updatedAt = block.timestamp;
        emit AnswerUpdated(answer, block.timestamp);
    }

    function latestAnswer() external view returns (int256) {
        return _answer;
    }

    function latestTimestamp() external view returns (uint256) {
        return _updatedAt;
    }

    function latestRound() external view returns (uint256) {
        return _roundId;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }
}

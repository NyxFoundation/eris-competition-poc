// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// GMX v2 (gmx-synthetics) のオラクル関連型の最小ローカル定義。
// struct のフィールド順・型、および関数セレクタを本番コントラクトと一致させる必要がある。
// 参照: gmx-io/gmx-synthetics contracts/oracle/OracleUtils.sol, IOracleProvider.sol

library OracleUtils {
    struct ValidatedPrice {
        address token;
        uint256 min;
        uint256 max;
        uint256 timestamp;
        address provider;
    }
}

interface IOracleProvider {
    function getOraclePrice(
        address token,
        bytes memory data
    ) external returns (OracleUtils.ValidatedPrice memory);

    function shouldAdjustTimestamp() external pure returns (bool);

    function isChainlinkOnChainProvider() external pure returns (bool);
}

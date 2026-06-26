// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// GMX v2 (gmx-synthetics) のオラクル関連型の最小ローカル定義。
// struct のフィールド順・型、および関数セレクタを本番コントラクトと一致させる必要がある。
// 参照: vendor/gmx-src/contracts/oracle/OracleUtils.sol, IOracleProvider.sol

library OracleUtils {
    // Oracle が provider から受け取る検証済み価格。
    // フィールド順・型は vendor と完全一致させること。
    struct ValidatedPrice {
        address token;
        uint256 min;
        uint256 max;
        uint256 timestamp;
        address provider;
    }
}

// GMX v2 の Oracle がトークン価格を取得するために呼ぶプロバイダインターフェース。
interface IOracleProvider {
    function getOraclePrice(address token, bytes memory data) external returns (OracleUtils.ValidatedPrice memory);

    // ChainlinkPriceFeedProvider 以外は false を返す (タイムスタンプ調整の有無)。
    function shouldAdjustTimestamp() external pure returns (bool);

    // ChainlinkPriceFeedProvider のみ true。true だと参照価格乖離チェックがスキップされる。
    function isChainlinkOnChainProvider() external pure returns (bool);
}

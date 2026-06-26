// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IOracleProvider, OracleUtils} from "./interfaces/IGmxOracle.sol";

/// @title MockOracleProvider
/// @notice GMX v2 の IOracleProvider 実装。価格をオンチェーンに保持し、検証者が任意の値に
///         書き換えられる「制御可能オラクル」。anvil 上で DataStore に登録して使う。
/// @dev    getOraclePrice は data 引数を無視し、setPrice で保存された値を返す。
///         timestamp は block.timestamp を返すため鮮度チェックは常に通過する。
contract MockOracleProvider is IOracleProvider {
    struct Price {
        uint256 min; // GMX スケール: 実価格(USD) * 10^(30 - tokenDecimals)
        uint256 max;
        bool set;
    }

    mapping(address token => Price) public prices;

    event PriceSet(address indexed token, uint256 min, uint256 max);

    /// @notice トークン価格を設定 (min == max でスプレッド無し)。
    function setPrice(address token, uint256 min, uint256 max) external {
        require(min <= max, "min>max");
        prices[token] = Price({min: min, max: max, set: true});
        emit PriceSet(token, min, max);
    }

    /// @notice 単一価格を設定するショートカット (min == max)。
    function setPrice(address token, uint256 price) external {
        prices[token] = Price({min: price, max: price, set: true});
        emit PriceSet(token, price, price);
    }

    /// @inheritdoc IOracleProvider
    function getOraclePrice(
        address token,
        bytes memory /* data */
    )
        external
        view
        returns (OracleUtils.ValidatedPrice memory)
    {
        Price memory p = prices[token];
        require(p.set, "MockOracleProvider: price not set");

        return OracleUtils.ValidatedPrice({
            token: token, min: p.min, max: p.max, timestamp: block.timestamp, provider: address(this)
        });
    }

    /// @inheritdoc IOracleProvider
    function shouldAdjustTimestamp() external pure returns (bool) {
        return false;
    }

    /// @inheritdoc IOracleProvider
    function isChainlinkOnChainProvider() external pure returns (bool) {
        return false;
    }
}

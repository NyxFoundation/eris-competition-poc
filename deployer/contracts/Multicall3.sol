// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Multicall3
/// @notice canonical Multicall3 (0xcA11bde0...) と機能互換の最小実装。
/// poc の採点 reconstruct (viem multicall = aggregate3) と getEthBalance を満たす。
/// 本家はガス最適化のため assembly を使うが、ここでは可読性優先の plain Solidity で
/// 同じ戻り値 (Result[] = {success, returnData}) を返す。
contract Multicall3 {
    struct Call {
        address target;
        bytes callData;
    }

    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Call3Value {
        address target;
        bool allowFailure;
        uint256 value;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate(Call[] calldata calls)
        public
        payable
        returns (uint256 blockNumber, bytes[] memory returnData)
    {
        blockNumber = block.number;
        uint256 length = calls.length;
        returnData = new bytes[](length);
        for (uint256 i = 0; i < length; ) {
            (bool success, bytes memory ret) = calls[i].target.call(
                calls[i].callData
            );
            require(success, "Multicall3: call failed");
            returnData[i] = ret;
            unchecked {
                ++i;
            }
        }
    }

    function tryAggregate(bool requireSuccess, Call[] calldata calls)
        public
        payable
        returns (Result[] memory returnData)
    {
        uint256 length = calls.length;
        returnData = new Result[](length);
        for (uint256 i = 0; i < length; ) {
            (bool success, bytes memory ret) = calls[i].target.call(
                calls[i].callData
            );
            if (requireSuccess) {
                require(success, "Multicall3: call failed");
            }
            returnData[i] = Result(success, ret);
            unchecked {
                ++i;
            }
        }
    }

    function tryBlockAndAggregate(bool requireSuccess, Call[] calldata calls)
        public
        payable
        returns (
            uint256 blockNumber,
            bytes32 blockHash,
            Result[] memory returnData
        )
    {
        blockNumber = block.number;
        blockHash = blockhash(block.number);
        returnData = tryAggregate(requireSuccess, calls);
    }

    function blockAndAggregate(Call[] calldata calls)
        public
        payable
        returns (
            uint256 blockNumber,
            bytes32 blockHash,
            Result[] memory returnData
        )
    {
        (blockNumber, blockHash, returnData) = tryBlockAndAggregate(
            true,
            calls
        );
    }

    function aggregate3(Call3[] calldata calls)
        public
        payable
        returns (Result[] memory returnData)
    {
        uint256 length = calls.length;
        returnData = new Result[](length);
        for (uint256 i = 0; i < length; ) {
            Call3 calldata calli = calls[i];
            (bool success, bytes memory ret) = calli.target.call(
                calli.callData
            );
            if (!calli.allowFailure) {
                require(success, "Multicall3: call failed");
            }
            returnData[i] = Result(success, ret);
            unchecked {
                ++i;
            }
        }
    }

    function aggregate3Value(Call3Value[] calldata calls)
        public
        payable
        returns (Result[] memory returnData)
    {
        uint256 length = calls.length;
        returnData = new Result[](length);
        for (uint256 i = 0; i < length; ) {
            Call3Value calldata calli = calls[i];
            (bool success, bytes memory ret) = calli.target.call{
                value: calli.value
            }(calli.callData);
            if (!calli.allowFailure) {
                require(success, "Multicall3: call failed");
            }
            returnData[i] = Result(success, ret);
            unchecked {
                ++i;
            }
        }
    }

    function getBlockHash(uint256 blockNumber)
        public
        view
        returns (bytes32 blockHash)
    {
        blockHash = blockhash(blockNumber);
    }

    function getBlockNumber() public view returns (uint256 blockNumber) {
        blockNumber = block.number;
    }

    function getCurrentBlockCoinbase() public view returns (address coinbase) {
        coinbase = block.coinbase;
    }

    function getCurrentBlockGasLimit() public view returns (uint256 gaslimit) {
        gaslimit = block.gaslimit;
    }

    function getCurrentBlockTimestamp()
        public
        view
        returns (uint256 timestamp)
    {
        timestamp = block.timestamp;
    }

    function getEthBalance(address addr) public view returns (uint256 balance) {
        balance = addr.balance;
    }

    function getLastBlockHash() public view returns (bytes32 blockHash) {
        unchecked {
            blockHash = blockhash(block.number - 1);
        }
    }

    function getBasefee() public view returns (uint256 basefee) {
        basefee = block.basefee;
    }

    function getChainId() public view returns (uint256 chainid) {
        chainid = block.chainid;
    }
}

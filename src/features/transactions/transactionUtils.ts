import * as SwapContract from "@airswap/swap-erc20/build/contracts/SwapERC20.sol/SwapERC20.json";
import * as WrapperContract from "@airswap/wrapper/build/contracts/Wrapper.sol/Wrapper.json";
import { Interface } from "@ethersproject/abi";
import { Web3Provider } from "@ethersproject/providers";
import { Action, Dispatch } from "@reduxjs/toolkit";

import { Event as EthersEvent, BigNumber as EthersBigNumber } from "ethers";

import { mineTransaction, revertTransaction } from "./transactionActions";
import { SubmittedTransaction } from "./transactionsSlice";

const wrapperInterface = new Interface(WrapperContract.abi);
const swapInterface = new Interface(SwapContract.abi);

// Event from interface for reference.
// event Swap(
//   uint256 indexed nonce,
//   uint256 timestamp,
//   address indexed signerWallet,
//   address signerToken,
//   uint256 signerAmount,
//   uint256 protocolFee,
//   address indexed senderWallet,
//   address senderToken,
//   uint256 senderAmount
// );

export type SwapEventArgs = {
  nonce: EthersBigNumber;
  timestamp: EthersBigNumber;
  signerWallet: string;
  signerToken: string;
  signerAmount: EthersBigNumber;
  protocolFee: EthersBigNumber;
  senderWallet: string;
  senderToken: string;
  senderAmount: EthersBigNumber;
};

/**
 * When swapping using the wrapper (i.e. when making a swap to/from ETH and not
 * WETH), the `senderWallet` will be the address of the wrapper contract. This
 * function finds the `WrappedSwapFor` log which is also emitted and contains
 * the 'true' sender.
 * @param log The `Swap` log with wrapper as senderWallet
 * @returns Promise<String> The original senderWallet
 */
const getSenderWalletForWrapperSwapLog: (
  log: EthersEvent
) => Promise<string> = async (log) => {
  const receipt = await log.getTransactionReceipt();
  // Find the `WrappedSwapFor` log that must have been emitted too.
  for (let i = 0; i < receipt.logs.length; i++) {
    try {
      const parsedLog = wrapperInterface.parseLog(receipt.logs[i]);
      if (parsedLog.name === "WrappedSwapFor") {
        return parsedLog.args.senderWallet.toLowerCase();
      }
    } catch (e) {
      // Most likely trying to decode logs from other contract, e.g. ERC20
      // We can ignore the error and check the next log.
      continue;
    }
  }
  throw new Error(
    `Could not find WrappedSwapFor event in tx with hash: ${log.transactionHash}`
  );
};

const getSwapArgsFromWrappedSwapForLog: (
  log: EthersEvent
) => Promise<SwapEventArgs> = async (log: EthersEvent) => {
  const receipt = await log.getTransactionReceipt();
  // Find the `Swap` log that must have been emitted too.
  for (let i = 0; i < receipt.logs.length; i++) {
    try {
      const parsedLog = swapInterface.parseLog(receipt.logs[i]);
      if (parsedLog.name === "Swap") {
        return parsedLog.args as unknown as SwapEventArgs;
      }
    } catch (e) {
      // Most likely trying to decode logs from other contract, e.g. ERC20
      // We can ignore the error and check the next log.
      continue;
    }
  }
  throw new Error(
    `Could not find Swap event in tx with hash: ${log.transactionHash}`
  );
};

/**
 * if pending, call getTransaction to see if it was a success/failure/pending
 * update accordingly. if pending: wait() and poll at a sensible interval.
 * this is only good for request-for-quote orders
 * @param transactionInState
 * @param walletHasChanged
 * @param dispatch
 * @param library
 */
async function checkPendingTransactionState(
  transactionInState: SubmittedTransaction,
  dispatch: Dispatch<Action>,
  library: Web3Provider
) {
  try {
    if (transactionInState.status === "processing" && transactionInState.hash) {
      let receipt = await library.getTransactionReceipt(
        transactionInState.hash
      );
      if (receipt !== null) {
        const status = receipt.status;
        if (status === 1)
          dispatch(mineTransaction({ hash: transactionInState.hash }));
        // success
        else if (status === 0)
          dispatch(
            revertTransaction({
              hash: transactionInState.hash,
              reason: "Reverted",
            })
          ); // reverted
        return;
        // Orders will automatically be picked up by swapEventSubscriber
      } else if (transactionInState.type !== "Order") {
        // Receipt was null, so the transaction is incomplete
        // Try to get a reference to the transaction in the mem pool - this
        // can sometimes also return null (e.g. gas price too low or tx only
        // recently sent) depending on backend.
        const transaction = await library.getTransaction(
          transactionInState.hash
        );
        if (transaction) {
          try {
            await transaction.wait(1);
            dispatch(mineTransaction({ hash: transactionInState.hash })); // success
          } catch (err) {
            console.error(err);
            dispatch(
              revertTransaction({
                hash: transactionInState.hash,
                reason: "Reverted",
              })
            );
          }
          return;
        } else {
          // if transaction === null, we poll at intervals
          // assume failed after 30 mins
          const assumedFailureTime = Date.now() + 30 * 60 * 1000;
          while (receipt === null && Date.now() <= assumedFailureTime) {
            // wait 30 seconds
            await new Promise((res) => setTimeout(res, 30000));
            receipt = await library!.getTransactionReceipt(
              transactionInState.hash
            );
          }
          if (!receipt || receipt.status === 0) {
            dispatch(
              revertTransaction({
                hash: transactionInState.hash,
                reason: "Reverted",
              })
            );
          } else {
            dispatch(mineTransaction({ hash: transactionInState.hash })); // success
          }
        }
      }
    }
  } catch (e: any) {
    // If the network changes, calling functions on an old transaction will fail
    // but we no longer care because it's not for our chain.
    if (e?.code === "NETWORK_ERROR") return;
    throw e;
  }
}

export {
  getSenderWalletForWrapperSwapLog,
  getSwapArgsFromWrappedSwapForLog,
  checkPendingTransactionState,
};

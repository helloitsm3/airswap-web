import { Signature, UnsignedOrderERC20 } from "@airswap/typescript";
import { createOrderERC20Signature as airswapCreateSwapSignature } from "@airswap/utils";
import { JsonRpcSigner } from "@ethersproject/providers/src.ts/json-rpc-provider";

import { AppError } from "../errors/appError";
import transformUnknownErrorToAppError from "../errors/transformUnknownErrorToAppError";

export const createOrderERC20Signature = (
  unsignedOrder: UnsignedOrderERC20,
  signer: JsonRpcSigner,
  swapContract: string,
  chainId: number
): Promise<Signature | AppError> => {
  return new Promise<Signature | AppError>(async (resolve) => {
    try {
      const signature = await airswapCreateSwapSignature(
        unsignedOrder,
        // @ts-ignore
        signer,
        swapContract,
        chainId
      );
      resolve(signature);
    } catch (error: unknown) {
      console.error(error);
      resolve(transformUnknownErrorToAppError(error));
    }
  });
};

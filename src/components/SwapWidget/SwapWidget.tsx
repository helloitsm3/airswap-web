import React, { FC, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHistory } from "react-router-dom";

import { wrappedTokenAddresses } from "@airswap/constants";
import { MakerRegistry, Wrapper } from "@airswap/libraries";
import { OrderERC20, Pricing } from "@airswap/typescript";
import { Web3Provider } from "@ethersproject/providers";
import { unwrapResult } from "@reduxjs/toolkit";
import { UnsupportedChainIdError, useWeb3React } from "@web3-react/core";

import { BigNumber } from "bignumber.js";

import { useAppDispatch, useAppSelector } from "../../app/hooks";
import {
  transformAddressToAddressAlias,
  transformAddressAliasToAddress,
} from "../../constants/addressAliases";
import {
  ADDITIONAL_QUOTE_BUFFER,
  RECEIVE_QUOTE_TIMEOUT_MS,
} from "../../constants/configParams";
import nativeCurrency, {
  nativeCurrencyAddress,
  nativeCurrencySafeTransactionFee,
} from "../../constants/nativeCurrency";
import { InterfaceContext } from "../../contexts/interface/Interface";
import { LastLookContext } from "../../contexts/lastLook/LastLook";
import { AppErrorType } from "../../errors/appError";
import transformUnknownErrorToAppError from "../../errors/transformUnknownErrorToAppError";
import {
  selectAllowances,
  selectBalances,
} from "../../features/balances/balancesSlice";
import {
  selectActiveTokens,
  selectAllTokenInfo,
} from "../../features/metadata/metadataSlice";
import { check } from "../../features/orders/orderApi";
import {
  approve,
  clear,
  deposit,
  request,
  resetOrders,
  selectBestOption,
  selectBestOrder,
  selectOrdersErrors,
  selectOrdersStatus,
  setErrors,
  take,
  withdraw,
} from "../../features/orders/ordersSlice";
import { selectAllSupportedTokens } from "../../features/registry/registrySlice";
import {
  clearTradeTerms,
  clearTradeTermsQuoteAmount,
  selectTradeTerms,
  setTradeTerms,
  setTradeTermsQuoteAmount,
} from "../../features/tradeTerms/tradeTermsSlice";
import {
  declineTransaction,
  revertTransaction,
} from "../../features/transactions/transactionActions";
import {
  ProtocolType,
  selectTransactions,
} from "../../features/transactions/transactionsSlice";
import {
  setUserTokens,
  selectUserTokens,
} from "../../features/userSettings/userSettingsSlice";
import stringToSignificantDecimals from "../../helpers/stringToSignificantDecimals";
import switchToEthereumChain from "../../helpers/switchToEthereumChain";
import useAppRouteParams from "../../hooks/useAppRouteParams";
import useApprovalPending from "../../hooks/useApprovalPending";
import useInsufficientBalance from "../../hooks/useInsufficientBalance";
import useMaxAmount from "../../hooks/useMaxAmount";
import useReferencePriceSubscriber from "../../hooks/useReferencePriceSubscriber";
import useSwapType from "../../hooks/useSwapType";
import useTokenAddress from "../../hooks/useTokenAddress";
import useTokenInfo from "../../hooks/useTokenInfo";
import { AppRoutes } from "../../routes";
import { TokenSelectModalTypes } from "../../types/tokenSelectModalTypes";
import { ErrorList } from "../ErrorList/ErrorList";
import GasFreeSwapsModal from "../InformationModals/subcomponents/GasFreeSwapsModal/GasFreeSwapsModal";
import ProtocolFeeModal from "../InformationModals/subcomponents/ProtocolFeeModal/ProtocolFeeModal";
import Overlay from "../Overlay/Overlay";
import SwapInputs from "../SwapInputs/SwapInputs";
import {
  notifyError,
  notifyRejectedByUserError,
} from "../Toasts/ToastController";
import TokenList from "../TokenList/TokenList";
import StyledSwapWidget, {
  ButtonContainer,
  HugeTicks,
  InfoContainer,
} from "./SwapWidget.styles";
import getTokenPairs from "./helpers/getTokenPairs";
import ActionButtons, {
  ButtonActions,
} from "./subcomponents/ActionButtons/ActionButtons";
import InfoSection from "./subcomponents/InfoSection/InfoSection";
import SwapWidgetHeader from "./subcomponents/SwapWidgetHeader/SwapWidgetHeader";

const initialBaseAmount = "";

const SwapWidget: FC = () => {
  // Redux
  const dispatch = useAppDispatch();
  const history = useHistory();
  const balances = useAppSelector(selectBalances);
  const allowances = useAppSelector(selectAllowances);
  const bestRfqOrder = useAppSelector(selectBestOrder);
  const ordersStatus = useAppSelector(selectOrdersStatus);
  const ordersErrors = useAppSelector(selectOrdersErrors);
  const bestTradeOption = useAppSelector(selectBestOption);
  const activeTokens = useAppSelector(selectActiveTokens);
  const allTokens = useAppSelector(selectAllTokenInfo);
  const supportedTokens = useAppSelector(selectAllSupportedTokens);
  const tradeTerms = useAppSelector(selectTradeTerms);
  const userTokens = useAppSelector(selectUserTokens);
  const lastTransaction = useAppSelector(selectTransactions)[0];

  // Contexts
  const LastLook = useContext(LastLookContext);
  const {
    isConnecting,
    transactionsTabIsOpen,
    setShowWalletList,
    setTransactionsTabIsOpen,
  } = useContext(InterfaceContext);

  // Input states
  const appRouteParams = useAppRouteParams();
  const [tokenFrom, setTokenFrom] = useState<string | undefined>();
  const [tokenTo, setTokenTo] = useState<string | undefined>();
  const [baseAmount, setBaseAmount] = useState(initialBaseAmount);

  // Pricing
  const {
    subscribeToGasPrice,
    subscribeToTokenPrice,
    unsubscribeFromGasPrice,
    unsubscribeFromTokenPrice,
  } = useReferencePriceSubscriber();

  // Modals
  const [showOrderSubmitted, setShowOrderSubmitted] = useState<boolean>(false);
  const [showTokenSelectModalFor, setShowTokenSelectModalFor] =
    useState<TokenSelectModalTypes | null>(null);
  const [showGasFeeInfo, setShowGasFeeInfo] = useState(false);
  const [protocolFeeInfo, setProtocolFeeInfo] = useState(false);

  // Loading states
  const [isApproving, setIsApproving] = useState(false);
  const [isSwapping, setIsSwapping] = useState(false);
  const [isWrapping, setIsWrapping] = useState(false);
  const [isRequestingQuotes, setIsRequestingQuotes] = useState(false);

  // Error states
  const [pairUnavailable, setPairUnavailable] = useState(false);
  const [allowanceFetchFailed, setAllowanceFetchFailed] =
    useState<boolean>(false);

  const { t } = useTranslation();

  const {
    chainId,
    account,
    library,
    active,
    error: web3Error,
  } = useWeb3React<Web3Provider>();

  const defaultBaseTokenAddress = useTokenAddress("USDT");
  const defaultQuoteTokenAddress = nativeCurrency[chainId!]?.address;

  // Use default tokens only if neither are specified in the URL or store.
  const baseToken = tokenFrom
    ? tokenFrom
    : tokenTo
    ? null
    : userTokens.tokenFrom || defaultBaseTokenAddress;
  const quoteToken = tokenTo
    ? tokenTo
    : tokenFrom
    ? null
    : userTokens.tokenTo || defaultQuoteTokenAddress;

  const baseTokenInfo = useTokenInfo(baseToken);
  const quoteTokenInfo = useTokenInfo(quoteToken);

  const hasApprovalPending = useApprovalPending(baseToken);
  const maxAmount = useMaxAmount(baseToken);
  const showMaxButton = !!maxAmount && baseAmount !== maxAmount;
  const showMaxInfoButton =
    !!maxAmount &&
    baseTokenInfo?.address === nativeCurrencyAddress &&
    !!nativeCurrencySafeTransactionFee[baseTokenInfo.chainId];

  useEffect(() => {
    setAllowanceFetchFailed(false);
    setBaseAmount(initialBaseAmount);
    dispatch(clearTradeTerms());
    unsubscribeFromGasPrice();
    unsubscribeFromTokenPrice();
    dispatch(clear());
    LastLook.unsubscribeAllMakers();
  }, [
    chainId,
    dispatch,
    LastLook,
    unsubscribeFromGasPrice,
    unsubscribeFromTokenPrice,
  ]);

  useEffect(() => {
    setTokenFrom(appRouteParams.tokenFrom);
    setTokenTo(appRouteParams.tokenTo);
  }, [appRouteParams]);

  useEffect(() => {
    if (ordersStatus === "reset") {
      setIsApproving(false);
      setIsSwapping(false);
      setIsWrapping(false);
      setIsRequestingQuotes(false);
      setAllowanceFetchFailed(false);
      setPairUnavailable(false);
      setProtocolFeeInfo(false);
      setShowGasFeeInfo(false);
      setBaseAmount(initialBaseAmount);
      LastLook.unsubscribeAllMakers();
    }
  }, [ordersStatus, LastLook, dispatch]);

  // Reset when the chainId changes.
  useEffect(() => {
    if (chainId) {
      dispatch(resetOrders());
    }
  }, [chainId, dispatch]);

  useEffect(() => {
    setAllowanceFetchFailed(
      allowances.swap.status === "failed" ||
        allowances.wrapper.status === "failed"
    );
  }, [allowances.swap.status, allowances.wrapper.status]);

  const swapType = useSwapType(baseTokenInfo, quoteTokenInfo);
  const quoteAmount =
    swapType === "wrapOrUnwrap"
      ? baseAmount
      : tradeTerms.quoteAmount || bestTradeOption?.quoteAmount || "";
  const formattedQuoteAmount = useMemo(
    () => stringToSignificantDecimals(quoteAmount),
    [quoteAmount]
  );

  const hasSufficientAllowance = (tokenAddress: string | undefined) => {
    if (tokenAddress === nativeCurrency[chainId || 1].address) return true;
    if (!tokenAddress) return false;
    if (
      allowances[swapType === "swapWithWrap" ? "wrapper" : "swap"].values[
        tokenAddress
      ] === undefined
    ) {
      // We don't currently know what the user's allowance is, this is an error
      // state we shouldn't repeatedly hit, so we'll prompt a reload.
      if (!allowanceFetchFailed) setAllowanceFetchFailed(true);
      // safter to return true here (has allowance) as validator will catch the
      // missing allowance, so the user won't swap, and they won't pay
      // unnecessary gas for an approval they may not need.
      return true;
    }
    return new BigNumber(
      allowances[swapType === "swapWithWrap" ? "wrapper" : "swap"].values[
        tokenAddress
      ]!
    )
      .div(10 ** (baseTokenInfo?.decimals || 18))
      .gte(baseAmount);
  };

  const handleSetToken = (type: TokenSelectModalTypes, value: string) => {
    const baseRoute = `/${AppRoutes.swap}`;
    const tokenPairs = getTokenPairs(type, value, quoteToken, baseToken);
    const tokenFrom = transformAddressAliasToAddress(tokenPairs.tokenFrom!);
    const tokenTo = transformAddressAliasToAddress(tokenPairs.tokenTo!);
    const tokenFromAlias = transformAddressToAddressAlias(tokenFrom);
    const tokenToAlias = transformAddressToAddressAlias(tokenTo);

    if (type === "base") {
      setBaseAmount("");
    }

    if (tokenFrom && tokenTo) {
      dispatch(setUserTokens({ tokenFrom, tokenTo }));
    }
    history.push({
      pathname: `${baseRoute}/${tokenFromAlias || tokenFrom}/${
        tokenToAlias || tokenTo
      }`,
    });
  };

  const insufficientBalance = useInsufficientBalance(baseTokenInfo, baseAmount);

  const handleRemoveActiveToken = (address: string) => {
    if (address === baseToken) {
      history.push({ pathname: `/${AppRoutes.swap}/-/${quoteToken || "-"}` });
      setBaseAmount(initialBaseAmount);
    } else if (address === quoteToken) {
      history.push({ pathname: `/${AppRoutes.swap}/${baseToken || "-"}/-` });
    }
  };

  const requestQuotes = async () => {
    if (swapType === "wrapOrUnwrap") {
      // This will re-render with a 1:1 price and a take button.
      setIsWrapping(true);
      return;
    }
    setIsRequestingQuotes(true);

    const usesWrapper = swapType === "swapWithWrap";
    const weth = wrappedTokenAddresses[chainId!];
    const eth = nativeCurrency[chainId!];
    const _quoteToken = quoteToken === eth.address ? weth : quoteToken!;
    const _baseToken = baseToken === eth.address ? weth : baseToken!;

    let rfqMakers, lastLookMakers;
    try {
      try {
        const makers = await new MakerRegistry(
          chainId,
          // @ts-ignore provider type mismatch
          library
        ).getMakers(_quoteToken, _baseToken, {
          initializeTimeout: 10 * 1000,
        });

        rfqMakers = makers.filter((s) =>
          s.supportsProtocol("request-for-quote")
        );

        lastLookMakers = makers.filter((s) => s.supportsProtocol("last-look"));
      } catch (e) {
        console.error("Error requesting orders:", e);
        throw new Error("error requesting orders");
      }

      let rfqPromise: Promise<OrderERC20[]> | null = null,
        lastLookPromises: Promise<Pricing>[] | null = null;

      if (rfqMakers.length) {
        let rfqDispatchResult = dispatch(
          request({
            makers: rfqMakers,
            senderToken: _baseToken,
            senderAmount: baseAmount,
            signerToken: _quoteToken,
            senderTokenDecimals: baseTokenInfo!.decimals,
            senderWallet: usesWrapper ? Wrapper.getAddress(chainId) : account!,
          })
        );
        rfqPromise = rfqDispatchResult
          .then((result) => {
            return unwrapResult(result);
          })
          .then((orders) => {
            if (!orders.length) throw new Error("no valid orders");
            return orders;
          });
      }

      if (lastLookMakers.length) {
        if (usesWrapper) {
          lastLookMakers.forEach((s) => s.disconnect());
        } else {
          lastLookPromises = LastLook.subscribeAllMakers(lastLookMakers, {
            baseToken: baseToken!,
            quoteToken: quoteToken!,
          });
        }
      }

      let orderPromises: Promise<OrderERC20[] | Pricing>[] = [];
      if (rfqPromise) orderPromises.push(rfqPromise);
      if (lastLookPromises) {
        orderPromises = orderPromises.concat(lastLookPromises);
      }

      // This promise times out if _no_ orders are received before the timeout
      // but resolves if _any_ are.
      const timeoutOnNoOrdersPromise = Promise.race<any>([
        Promise.any(orderPromises),
        new Promise((_, reject) =>
          setTimeout(() => {
            reject("no valid orders");
          }, RECEIVE_QUOTE_TIMEOUT_MS)
        ),
      ]);

      // This promise resolves either when all orders are received or X seconds
      // after the first order is received.
      const waitExtraForAllOrdersPromise = Promise.race<any>([
        Promise.allSettled(orderPromises),
        Promise.any(orderPromises).then(
          () =>
            new Promise((resolve) =>
              setTimeout(resolve, ADDITIONAL_QUOTE_BUFFER)
            )
        ),
      ]);

      await Promise.all([
        waitExtraForAllOrdersPromise,
        timeoutOnNoOrdersPromise,
      ]);
    } catch (e: any) {
      switch (e.message) {
        case "error requesting orders": {
          notifyError({
            heading: t("orders.errorRequesting"),
            cta: t("orders.errorRequestingCta"),
          });
          break;
        }

        default: {
          console.error(e);
          setPairUnavailable(true);
        }
      }
    } finally {
      setIsRequestingQuotes(false);
    }
  };

  const swapWithRequestForQuote = async () => {
    try {
      const errors = await check(
        bestTradeOption!.order!,
        swapType === "swapWithWrap" ? Wrapper.getAddress(chainId) : account!,
        chainId || 1,
        library?.getSigner()
      );

      if (errors.length) {
        dispatch(setErrors(errors));
        setIsSwapping(false);
        return;
      }
      LastLook.unsubscribeAllMakers();

      const result = await dispatch(
        take({
          order: bestTradeOption!.order!,
          library,
          contractType: swapType === "swapWithWrap" ? "Wrapper" : "Swap",
          onExpired: () => {
            notifyError({
              heading: t("orders.swapExpired"),
              cta: t("orders.swapExpiredCallToAction"),
            });
          },
        })
      );
      setIsSwapping(false);
      await unwrapResult(result);
      setShowOrderSubmitted(true);
    } catch (e) {
      console.error("Error taking order:", e);
    }
  };

  const swapWithLastLook = async () => {
    let order: OrderERC20 | null = null;

    try {
      setIsSwapping(true);
      // Setting quote amount prevents the UI from updating if pricing changes
      dispatch(setTradeTermsQuoteAmount(bestTradeOption!.quoteAmount));
      // Last look order.
      const { order: lastLookOrder, senderWallet } =
        await LastLook.getSignedOrder({
          locator: bestTradeOption!.pricing!.locator,
          terms: { ...tradeTerms, quoteAmount: bestTradeOption!.quoteAmount },
        });
      order = lastLookOrder;

      const errors = await check(
        order,
        senderWallet,
        chainId || 1,
        library?.getSigner()
      );

      if (errors.length) {
        dispatch(setErrors(errors));
        setIsSwapping(false);
        return;
      }
      const accepted = await LastLook.sendOrderForConsideration({
        locator: bestTradeOption!.pricing!.locator,
        order: order,
      });
      setIsSwapping(false);
      if (accepted) {
        setShowOrderSubmitted(true);
        LastLook.unsubscribeAllMakers();
      } else {
        notifyError({
          heading: t("orders.swapRejected"),
          cta: t("orders.swapRejectedCallToAction"),
        });

        dispatch(
          declineTransaction({
            signerWallet: order.signerWallet,
            nonce: order.nonce,
            reason: "Pricing expired",
          })
        );
      }
    } catch (e: any) {
      setIsSwapping(false);
      dispatch(clearTradeTermsQuoteAmount());

      const appError = transformUnknownErrorToAppError(e);
      if (appError.type === AppErrorType.rejectedByUser) {
        notifyRejectedByUserError();
        dispatch(
          revertTransaction({
            signerWallet: order?.signerWallet,
            nonce: order?.nonce,
            reason: e.message,
          })
        );
      } else {
        dispatch(setErrors([appError]));
      }

      console.error("Error taking order:", e);
    }
  };

  const takeBestOption = async () => {
    if (bestTradeOption!.protocol === "request-for-quote") {
      await swapWithRequestForQuote();
    } else {
      await swapWithLastLook();
    }
  };

  const doWrap = async () => {
    const method =
      baseTokenInfo === nativeCurrency[chainId!] ? deposit : withdraw;
    setIsSwapping(true);
    try {
      const result = await dispatch(
        method({
          chainId: chainId!,
          senderAmount: baseAmount,
          senderTokenDecimals: baseTokenInfo!.decimals,
          provider: library!,
        })
      );
      await unwrapResult(result);
      setIsSwapping(false);
      setIsWrapping(false);
      setShowOrderSubmitted(true);
    } catch (e) {
      // user cancelled metamask dialog
      setIsSwapping(false);
      setIsWrapping(false);
    }
  };

  const handleActionButtonClick = async (action: ButtonActions) => {
    switch (action) {
      case ButtonActions.goBack:
        setIsWrapping(false);
        setPairUnavailable(false);
        dispatch(clearTradeTerms());
        dispatch(clear());
        unsubscribeFromGasPrice();
        unsubscribeFromTokenPrice();
        LastLook.unsubscribeAllMakers();
        break;

      case ButtonActions.restart:
        setShowOrderSubmitted(false);
        // setValidatorErrors([]);
        dispatch(clearTradeTerms());
        dispatch(clear());
        unsubscribeFromGasPrice();
        unsubscribeFromTokenPrice();
        LastLook.unsubscribeAllMakers();
        setBaseAmount(initialBaseAmount);
        break;

      case ButtonActions.reloadPage:
        window.location.reload();
        break;

      case ButtonActions.connectWallet:
        setShowWalletList(true);
        break;

      case ButtonActions.switchNetwork:
        switchToEthereumChain();
        break;

      case ButtonActions.requestQuotes:
        dispatch(
          setTradeTerms({
            baseToken: {
              address: baseToken!,
              decimals: baseTokenInfo!.decimals,
            },
            baseAmount: baseAmount,
            quoteToken: {
              address: quoteToken!,
              decimals: quoteTokenInfo!.decimals,
            },
            quoteAmount: null,
            side: "sell",
          })
        );
        subscribeToGasPrice();
        subscribeToTokenPrice(
          quoteTokenInfo!,
          // @ts-ignore
          library!,
          chainId!
        );
        await requestQuotes();

        break;

      case ButtonActions.approve:
        setIsApproving(true);
        await dispatch(
          approve({
            token: baseToken!,
            library,
            contractType: swapType === "swapWithWrap" ? "Wrapper" : "Swap",
            chainId: chainId!,
          })
        );
        setIsApproving(false);
        break;

      case ButtonActions.takeQuote:
        if (["swap", "swapWithWrap"].includes(swapType)) {
          await takeBestOption();
        } else if (swapType === "wrapOrUnwrap") {
          await doWrap();
        }
        break;

      case ButtonActions.trackTransaction:
        setTransactionsTabIsOpen(true);
        break;

      default:
      // Do nothing.
    }
  };

  return (
    <>
      <StyledSwapWidget>
        <SwapWidgetHeader
          title={isApproving ? t("orders.approve") : t("common.swap")}
          isQuote={!isRequestingQuotes && !showOrderSubmitted}
          onGasFreeTradeButtonClick={() => setShowGasFeeInfo(true)}
          protocol={bestTradeOption?.protocol as ProtocolType}
          expiry={bestTradeOption?.order?.expiry}
        />
        {showOrderSubmitted ? (
          <HugeTicks />
        ) : isApproving || isSwapping ? (
          <></>
        ) : (
          <SwapInputs
            baseAmount={baseAmount}
            onBaseAmountChange={setBaseAmount}
            baseTokenInfo={baseTokenInfo}
            quoteTokenInfo={quoteTokenInfo}
            onChangeTokenClick={setShowTokenSelectModalFor}
            onMaxButtonClick={() => setBaseAmount(maxAmount || "0")}
            side="sell"
            tradeNotAllowed={pairUnavailable}
            isRequesting={isRequestingQuotes}
            // Note that using the quoteAmount from tradeTerms will stop this
            // updating when the user clicks the take button.
            quoteAmount={formattedQuoteAmount}
            disabled={!active || (!!quoteAmount && allowanceFetchFailed)}
            readOnly={
              !!bestTradeOption ||
              isWrapping ||
              isRequestingQuotes ||
              pairUnavailable ||
              !active
            }
            showMaxButton={showMaxButton}
            showMaxInfoButton={showMaxInfoButton}
            maxAmount={maxAmount}
          />
        )}
        <InfoContainer>
          <InfoSection
            orderSubmitted={showOrderSubmitted}
            orderCompleted={
              showOrderSubmitted && lastTransaction?.status === "succeeded"
            }
            isConnected={active}
            isPairUnavailable={pairUnavailable}
            isFetchingOrders={isRequestingQuotes}
            isApproving={isApproving}
            isSwapping={isSwapping}
            failedToFetchAllowances={allowanceFetchFailed}
            // @ts-ignore
            bestTradeOption={bestTradeOption}
            requiresApproval={
              bestRfqOrder && !hasSufficientAllowance(baseToken!)
            }
            baseTokenInfo={baseTokenInfo}
            baseAmount={baseAmount}
            quoteTokenInfo={quoteTokenInfo}
            isWrapping={isWrapping}
            onFeeButtonClick={() => setProtocolFeeInfo(true)}
          />
        </InfoContainer>
        <ButtonContainer>
          {!isApproving && !isSwapping && (
            <ActionButtons
              walletIsActive={active}
              unsupportedNetwork={
                !!web3Error && web3Error instanceof UnsupportedChainIdError
              }
              requiresReload={allowanceFetchFailed}
              orderComplete={showOrderSubmitted}
              baseTokenInfo={baseTokenInfo}
              quoteTokenInfo={quoteTokenInfo}
              hasAmount={
                !!baseAmount.length && baseAmount !== "0" && baseAmount !== "."
              }
              hasQuote={
                !isRequestingQuotes && (!!bestTradeOption || isWrapping)
              }
              hasSufficientBalance={!insufficientBalance}
              needsApproval={!!baseToken && !hasSufficientAllowance(baseToken)}
              pairUnavailable={pairUnavailable}
              onButtonClicked={(action) => handleActionButtonClick(action)}
              isLoading={
                isConnecting ||
                isRequestingQuotes ||
                ["approving", "taking"].includes(ordersStatus) ||
                hasApprovalPending
              }
              transactionsTabOpen={transactionsTabIsOpen}
            />
          )}
        </ButtonContainer>
      </StyledSwapWidget>

      <Overlay
        onCloseButtonClick={() => setShowTokenSelectModalFor(null)}
        isHidden={!showTokenSelectModalFor}
      >
        <TokenList
          onSelectToken={(newTokenAddress) => {
            // e.g. handleSetToken("base", "0x123")
            handleSetToken(showTokenSelectModalFor, newTokenAddress);
            // Close the modal
            setShowTokenSelectModalFor(null);
          }}
          balances={balances}
          allTokens={allTokens}
          activeTokens={activeTokens}
          supportedTokenAddresses={supportedTokens}
          onAfterRemoveActiveToken={handleRemoveActiveToken}
        />
      </Overlay>
      <Overlay
        title={t("validatorErrors.unableSwap")}
        subTitle={t("validatorErrors.swapFail")}
        onCloseButtonClick={() =>
          handleActionButtonClick(ButtonActions.restart)
        }
        isHidden={!ordersErrors.length}
      >
        <ErrorList
          errors={ordersErrors}
          onBackButtonClick={() =>
            handleActionButtonClick(ButtonActions.restart)
          }
        />
      </Overlay>
      <Overlay
        title={t("information.gasFreeSwaps.title")}
        onCloseButtonClick={() => setShowGasFeeInfo(false)}
        isHidden={!showGasFeeInfo}
      >
        <GasFreeSwapsModal
          onCloseButtonClick={() => setShowGasFeeInfo(false)}
        />
      </Overlay>
      <Overlay
        title={t("information.protocolFee.title")}
        onCloseButtonClick={() => setProtocolFeeInfo(false)}
        isHidden={!protocolFeeInfo}
      >
        <ProtocolFeeModal
          onCloseButtonClick={() => setProtocolFeeInfo(false)}
        />
      </Overlay>
    </>
  );
};

export default SwapWidget;

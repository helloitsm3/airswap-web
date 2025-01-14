import { FC, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useHistory, useParams } from "react-router-dom";

import { FullOrderERC20 } from "@airswap/typescript";
import { Web3Provider } from "@ethersproject/providers";
import { useWeb3React } from "@web3-react/core";

import { useAppDispatch, useAppSelector } from "../../app/hooks";
import { cancelOrder } from "../../features/takeOtc/takeOtcActions";
import {
  selectTakeOtcReducer,
  setIsCancelSuccessFull,
} from "../../features/takeOtc/takeOtcSlice";
import useCancellationPending from "../../hooks/useCancellationPending";
import useCancellationSuccess from "../../hooks/useCancellationSuccess";
import { AppRoutes } from "../../routes";
import { OrderStatus } from "../../types/orderStatus";
import Icon from "../Icon/Icon";
import { useOrderStatus } from "../OrderDetailWidget/hooks/useOrderStatus";
import { Title } from "../Typography/Typography";
import { InfoSubHeading } from "../Typography/Typography";
import {
  Container,
  StyledInfoHeading,
  Header,
  InfoContainer,
  ButtonContainer,
  BackButton,
  CancelButton,
} from "./CancelWidget.styles";

interface CancelWidgetProps {
  library: Web3Provider;
  order: FullOrderERC20;
}

export const CancelWidget: FC<CancelWidgetProps> = ({ order, library }) => {
  const { t } = useTranslation();
  const history = useHistory();
  const { chainId } = useWeb3React();
  const dispatch = useAppDispatch();

  const { isCancelSuccessFull } = useAppSelector(selectTakeOtcReducer);

  const params = useParams<{ compressedOrder: string }>();
  const orderStatus = useOrderStatus(order);
  const isCancelSuccess = useCancellationSuccess(order.nonce);
  const isCancelInProgress = useCancellationPending(order.nonce);
  const isExpired = new Date().getTime() > parseInt(order.expiry) * 1000;

  const wrongChainId = useMemo(() => {
    return chainId?.toString() !== order.chainId;
  }, [chainId, order]);

  const handleBackButtonClick = () => {
    history.goBack();
  };

  useEffect(() => {
    if (isCancelSuccessFull && isCancelSuccess) {
      history.push({
        pathname: `/${AppRoutes.order}/${params.compressedOrder}`,
      });

      dispatch(setIsCancelSuccessFull(false));
    }
  }, [history, params, isCancelSuccessFull, isCancelSuccess, dispatch]);

  const handleCancelClick = async () => {
    await dispatch(
      cancelOrder({
        order,
        chainId: chainId!,
        library: library,
      })
    );
  };

  return (
    <Container>
      <Header>
        <Title type="h2" as="h1">
          {t("orders.cancelSwap")}
        </Title>
      </Header>
      <InfoContainer>
        <Icon name="close-circle-outline" iconSize={4.5} />
        <StyledInfoHeading>
          {t("orders.areYouSureYouWantToCancel")}
        </StyledInfoHeading>
        <InfoSubHeading>{t("orders.actionCannotBeReversed")}</InfoSubHeading>
      </InfoContainer>
      <ButtonContainer>
        <BackButton onClick={handleBackButtonClick}>
          {t("common.back")}
        </BackButton>
        <CancelButton
          intent={"primary"}
          onClick={handleCancelClick}
          disabled={
            orderStatus !== OrderStatus.open || wrongChainId || isExpired
          }
          loading={isCancelInProgress}
        >
          {t("orders.confirmCancel")}
        </CancelButton>
      </ButtonContainer>
    </Container>
  );
};

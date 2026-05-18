import { OrderType } from '../domain/Order.ts';

export enum OrderReason {
  Signal,
  RiskExit,
}

// The system has exactly two order types (see OrderType in Order.ts). For Signal
// reasons the type comes from the portal-driven `SIGNAL_ORDER_TYPE` knob (live-config);
// for RiskExit we always cross the spread immediately, regardless of how signals are
// configured — sitting on a limit during a stop-loss is the failure mode this enforces
// against.
export class OrderRouter {
  selectOrderType(reason: OrderReason, signalOrderType: OrderType): OrderType {
    return reason === OrderReason.RiskExit ? OrderType.Market : signalOrderType;
  }
}

export { OrderType } from '../domain/Order.ts';

export type OrderType     = 'limit' | 'market';
export type ExecutionMode = 't212' | 'unrestricted';
export type OrderReason   = 'signal' | 'risk_exit';

export class OrderRouter {
  selectOrderType(reason: OrderReason, executionMode: ExecutionMode): OrderType {
    if (reason === 'risk_exit') return 'market';    // urgent — fill at any price
    if (executionMode === 't212') return 'limit';   // spread matters — limit for all signals
    return 'market';                                 // unrestricted mode allows market orders
  }
}

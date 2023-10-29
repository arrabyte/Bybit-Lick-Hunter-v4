//  Copyright (C)2022 - Alessandro Arrabito - <arrabitoster@gmail.com> - Strambatax on TradingView

import { env } from 'process';

export async function createMarketOrder(linearClient, pair, side, size, take_profit = 0, stop_loss = 0) {

  var cfg = {
    category: "linear",
    side: side,
    orderType: "Market",
    symbol: pair,
    qty: size,
    timeInForce: "GTC",
    reduceOnly: false,
    closeOnTrigger: false,
    positionIdx: process.env.POSITION_MODE == "HEDGE" ? (side == "Buy" ? 1 : 2) : 0
  };

  if (take_profit != 0)
    cfg['takeProfit'] = take_profit;
  if (stop_loss != 0)
    cfg['stopLoss'] = stop_loss;

  // send order payload
  const order = await linearClient.submitOrder(cfg);
  return order;
}

export async function createLimitOrder(linearClient, pair, side, size, price, params = {}) {

  var cfg = {
    side: side,
    orderType: "Limit",
    symbol: pair,
    qty: size,
    timeInForce: "GTC",
    reduceOnly: false,
    closeOnTrigger: false,
    price: price,
    // if hedge mode
    positionIdx: process.env.POSITION_MODE == "HEDGE" ? (side == "Buy" ? 1 : 2) : 0,
    ...params
  };

  // send order payload
  const order = await linearClient.submitOrder(cfg);
  return order;
}

export async function cancelOrder(linearClient, pair) {
  return await linearClient.cancelAllOrders({'symbol': pair});
}
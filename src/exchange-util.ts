import axios from 'axios';

import * as coingeckoMapping from './coingecko-mapping.json';
import { BinanceUtil } from './binance-util';
import { NotificationUtil } from './notification-util';
import {
  filter,
  find,
  forEach,
  round,
  get,
  isNil,
  map,
  mapKeys,
  toPairs,
  values,
} from 'lodash';

export class ExchangeUtil {
  static calcSummaryFromOrders(currentPrice, pricePrecision, orders) {
    const buyOrders = filter(orders, { side: 'BUY' });
    const buyBudget = buyOrders.reduce(
      (sum, current) => sum + +current.price * +current.origQty,
      0
    );
    const buyQty = buyOrders.reduce(
      (sum, current) => sum + +current.origQty,
      0
    );
    const buyAvgPrice = buyBudget / buyQty;

    const sellOrders = filter(orders, { side: 'SELL' });
    const sellBudget = sellOrders.reduce(
      (sum, current) => sum + +current.price * +current.origQty,
      0
    );
    const sellQty = sellOrders.reduce(
      (sum, current) => sum + +current.origQty,
      0
    );
    const sellAvgPrice = sellBudget / sellQty;

    let profit;

    if (buyQty > sellQty) {
      const diffQty = buyQty - sellQty;
      const diffBudget = buyBudget - sellBudget;
      const budgetToBuyDiffQtyAtCurrentPrice = currentPrice * diffQty;
      profit = budgetToBuyDiffQtyAtCurrentPrice - diffBudget;
    } else {
      profit =
        buyQty * (sellAvgPrice - buyAvgPrice) +
        (sellQty - buyQty) * (sellAvgPrice - currentPrice);
    }

    return {
      buyBudget: round(buyBudget, 0),
      sellBudget: round(sellBudget, 0),
      buyAvgPrice: round(buyAvgPrice, pricePrecision),
      sellAvgPrice: round(sellAvgPrice, pricePrecision),
      buyQty: round(buyQty, 0),
      sellQty: round(sellQty, 0),
      profit: round(profit, 0),
    };
  }

  public static async getPrecisions() {
    try {
      const res = await BinanceUtil.getExchangeAxiosInstance().get(
        'exchangeInfo'
      );

      // console.log(JSON.stringify(find(res.data.symbols, { symbol: 'C98USDT'})))
      // process.exit(1)
      const obj = {};

      forEach(res.data.symbols, ({ symbol, filters }) => {
        const filter = find(
          filters,
          ({ filterType }) => filterType === 'LOT_SIZE'
        );

        let quantityPrecision;
        if (/\.(\d+)/.test(filter.minQty)) {
          const afterDot = filter.minQty.match(/\.(\d+)/)[1];
          quantityPrecision = afterDot.replace(/10+$/g, '1').length;
        } else {
          quantityPrecision = 0;
        }

        const priceFilter = find(
          filters,
          ({ filterType }) => filterType === 'PRICE_FILTER'
        );
        const pricePrecision = /\.(\d+1)/.test(priceFilter.tickSize)
          ? priceFilter.tickSize.match(/\.(\d+1)/)[1].length
          : 0;

        obj[symbol] = { pricePrecision, quantityPrecision };
      });

      return obj;
    } catch (err) {
      console.log(err);
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        return ExchangeUtil.getPrecisions();
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      throw err;
    }
  }

  public static async getPrice(symbol: string) {
    const url = `trades?symbol=${symbol}&limit=2`;

    try {
      const res = await BinanceUtil.getExchangeAxiosInstance().get(url);

      return (+res.data[0].price + +res.data[1].price) / 2;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.status === 504 ||
        err.response.data.code === -1021
      ) {
        await ExchangeUtil.sleep();
        return ExchangeUtil.getPrice(symbol);
      }

      // await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      // await NotificationUtil.sendMessage(`GET ${url}`);
      throw err;
    }
  }

  public static async getCoinGeckoPrices() {
    const symbolIds = map(
      filter(coingeckoMapping, ({ symbolId }) => symbolId),
      'symbolId'
    ).join(',');

    try {
      const { data } = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price',
        {
          params: { ids: symbolIds, vs_currencies: 'usd' },
        }
      );

      const rs = {};

      forEach(toPairs(data), ([symbolId, value]) => {
        rs[find(coingeckoMapping, { symbolId }).symbol] = get(value, 'usd');
      });

      // const missingSymbols = filter(coingeckoMapping, ({ symbolId }) =>
      //   isNil(symbolId)
      // );
      // for (const missingSymbol of missingSymbols) {
      //   rs[missingSymbol.symbol] = missingSymbol.price;
      // }

      return rs;
    } catch (err) {
      await ExchangeUtil.sleep();
      return ExchangeUtil.getCoinGeckoPrices();
    }
  }

  public static async getBalances(portfolioId) {
    const { queryString, signature } = BinanceUtil.completeParams(
      {},
      portfolioId
    );

    const url = `account?${queryString}&signature=${signature}`;

    try {
      const res = await BinanceUtil.getExchangeAxiosInstance(portfolioId).get(
        url
      );

      return res.data.balances;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021 ||
        err.response.data.code === -1001
      ) {
        await ExchangeUtil.sleep();
        return ExchangeUtil.getBalances(portfolioId);
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`GET ${url}`);
      throw err;
    }
  }

  public static async createStopLimitOrder(
    symbol: string,
    side: string,
    price: number,
    stopPrice: number,
    quantity: number
  ) {
    const { queryString, signature } = BinanceUtil.completeParams({
      symbol,
      side,
      type: 'STOP_LOSS_LIMIT',
      timeInForce: 'GTC',
      quantity,
      price,
      stopPrice,
    });

    const url = `order?${queryString}&signature=${signature}`;

    try {
      const { data } = await BinanceUtil.getExchangeAxiosInstance().post(url);
      return data;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        return ExchangeUtil.createStopLimitOrder(
          symbol,
          side,
          price,
          stopPrice,
          quantity
        );
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`POST ${url}`);
      throw err;
    }
  }

  public static async createLimitOrder(
    symbol: string,
    side: string,
    price: number,
    quantity: number,
    portfolioId = 1
  ) {
    const { queryString, signature } = BinanceUtil.completeParams(
      {
        symbol,
        side,
        type: 'LIMIT',
        timeInForce: 'GTC',
        quantity,
        price,
      },
      portfolioId
    );

    const url = `order?${queryString}&signature=${signature}`;

    try {
      const { data } = await BinanceUtil.getExchangeAxiosInstance(
        portfolioId
      ).post(url);
      return data;
    } catch (err) {
      console.log(err);
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        return ExchangeUtil.createLimitOrder(
          symbol,
          side,
          price,
          quantity,
          portfolioId
        );
      }

      if (err.response.data.code === -1013) {
        await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
        await NotificationUtil.sendMessage(`POST ${url}`);
        return;
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`POST ${url}`);
      throw err;
    }
  }

  public static async createMarketOrder(
    symbol: string,
    side: string,
    quantity: number,
    portfolioId = 1
  ) {
    const { queryString, signature } = BinanceUtil.completeParams(
      {
        symbol,
        side,
        type: 'MARKET',
        quantity,
        newOrderRespType: 'FULL',
      },
      portfolioId
    );

    const url = `order?${queryString}&signature=${signature}`;

    try {
      const { data } = await BinanceUtil.getExchangeAxiosInstance(
        portfolioId
      ).post(url);
      return data;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        return ExchangeUtil.createMarketOrder(
          symbol,
          side,
          quantity,
          portfolioId
        );
      }

      if (err.response.data.code === -1013) {
        await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
        await NotificationUtil.sendMessage(`POST ${url}`);
        return;
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`POST ${url}`);
      throw err;
    }
  }

  public static async getOpenOrders(symbol: string) {
    const { queryString, signature } = BinanceUtil.completeParams({ symbol });

    const url = `openOrders?${queryString}&signature=${signature}`;

    try {
      const res = await BinanceUtil.getExchangeAxiosInstance().get(url);

      return res.data;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        await ExchangeUtil.sleep();
        return ExchangeUtil.getOpenOrders(symbol);
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`GET ${url}`);
      throw err;
    }
  }

  public static async getOrder(symbol: string, orderId: number) {
    const { queryString, signature } = BinanceUtil.completeParams({
      symbol,
      orderId,
    });

    const url = `order?${queryString}&signature=${signature}`;

    try {
      const res = await BinanceUtil.getExchangeAxiosInstance().get(url);

      return res.data;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        await ExchangeUtil.sleep();
        return ExchangeUtil.getOrder(symbol, orderId);
      } else if (err.response.data.code === -2013) {
        const res2 = await ExchangeUtil.getOpenOrders(symbol);

        const rs = find(res2, { orderId });

        if (rs) {
          return rs;
        }

        return {};
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`GET ${url}`);
      throw err;
    }
  }

  public static async cancelOrder(symbol: string, orderId: number) {
    const { queryString, signature } = BinanceUtil.completeParams({
      symbol,
      orderId,
    });

    const url = `order?${queryString}&signature=${signature}`;

    try {
      const res = await BinanceUtil.getExchangeAxiosInstance().delete(url);

      return res.data.balances;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        await ExchangeUtil.sleep();
        return ExchangeUtil.cancelOrder(symbol, orderId);
      }

      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -2011
      ) {
        await NotificationUtil.sendMessage('UNKNOW ORDER TO DELETE');
        return;
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`DELETE ${url}`);
      throw err;
    }
  }

  public static async getAllOrders(symbol) {
    const { queryString, signature } = BinanceUtil.completeParams({
      symbol,
      limit: 1000,
      orderId: 0,
    });
    const url = `allOrders?${queryString}&signature=${signature}`;
    let orders = [];

    try {
      let res = await BinanceUtil.getExchangeAxiosInstance().get(url);
      orders = res.data;

      while (res.data.length === 1000) {
        await ExchangeUtil.sleep(1);

        const { queryString: q2, signature: s2 } = BinanceUtil.completeParams({
          symbol,
          limit: 1000,
          orderId: res.data[res.data.length - 1].orderId + 1,
        });
        const url2 = `allOrders?${q2}&signature=${s2}`;
        res = await BinanceUtil.getExchangeAxiosInstance().get(url2);
        orders.push(...res.data);
      }

      const rawOrders = filter(orders, { status: 'FILLED' });
      let result = [];
      for (const order of rawOrders) {
        if (order.type === 'MARKET') {
          result.push({
            ...order,
            price: +order.cummulativeQuoteQty / +order.executedQty,
          });
        } else {
          result.push(order);
        }
      }

      return result;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        await ExchangeUtil.sleep();
        return ExchangeUtil.getAllOrders(symbol);
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`GET ${url}`);
      throw err;
    }
  }

  //   public static async createOrder(symbol, side, quantity, price) {
  //     const { queryString, signature } = BinanceUtil.completeParams({
  //       symbol,
  //       side,
  //       type: 'LIMIT',
  //       quantity,
  //       price,
  //       timeInForce: 'GTC',
  //     });

  //     const url = `order?${queryString}&signature=${signature}`;

  //     try {
  //       const res = await BinanceUtil.getFutureAxiosInstance().post(url);

  //       return res.data;
  //     } catch (err) {
  //       if (
  //         !err.response ||
  //         err.response.status === 502 ||
  //         err.response.data.code === -1021
  //       ) {
  //         await FutureUtil.sleep();
  //         return FutureUtil.createOrder(symbol, side, quantity, price);
  //       }

  //       await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
  //       await NotificationUtil.sendMessage(`POST ${url}`);
  //       throw err;
  //     }
  //   }

  //   public static async createMarketOrder(symbol, side, quantity) {
  //     const { queryString, signature } = BinanceUtil.completeParams({
  //       symbol,
  //       side,
  //       type: 'MARKET',
  //       quantity,
  //     });

  //     const url = `order?${queryString}&signature=${signature}`;

  //     try {
  //       const res = await BinanceUtil.getFutureAxiosInstance().post(url);

  //       return res.data;
  //     } catch (err) {
  //       if (
  //         !err.response ||
  //         err.response.status === 502 ||
  //         err.response.data.code === -1021
  //       ) {
  //         await FutureUtil.sleep();
  //         return FutureUtil.createMarketOrder(symbol, side, quantity);
  //       }

  //       await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
  //       await NotificationUtil.sendMessage(`POST ${url}`);
  //       throw err;
  //     }
  //   }

  //   public static async cancelAllOrders(symbol: string) {
  //     const { queryString, signature } = BinanceUtil.completeParams({
  //       symbol,
  //     });

  //     const url = `allOpenOrders?${queryString}&signature=${signature}`;

  //     try {
  //       await BinanceUtil.getFutureAxiosInstance().delete(url);
  //     } catch (err) {
  //       if (
  //         !err.response ||
  //         err.response.status === 502 ||
  //         err.response.data.code === -1021
  //       ) {
  //         console.log('Failed to cancel orders');
  //       }

  //       await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
  //       await NotificationUtil.sendMessage(`DELETE ${url}`);
  //       throw err;
  //     }
  //   }

  //   public static async getPositions() {
  //     const { queryString, signature } = BinanceUtil.completeParams({});

  //     const url = `positionRisk?${queryString}&signature=${signature}`;

  //     try {
  //       const res = await BinanceUtil.getFutureAxiosInstance().get(url);

  //       return res.data;
  //     } catch (err) {
  //       if (
  //         !err.response ||
  //         err.response.status === 502 ||
  //         err.response.data.code === -1021
  //       ) {
  //         await FutureUtil.sleep();
  //         console.log('Failed to get positions');
  //         return FutureUtil.getPositions();
  //       }

  //       await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
  //       await NotificationUtil.sendMessage(`GET ${url}`);
  //       throw err;
  //     }
  //   }

  //   public static async cancelPosition() {
  //     const positions = await FutureUtil.getPositions();
  //     await Promise.all(
  //       map(positions, async (position) => {
  //         const side = +position.positionAmt > 0 ? 'SELL' : 'BUY';

  //         await FutureUtil.createMarketOrder(
  //           position.symbol,
  //           side,
  //           +position.positionAmt
  //         );
  //       })
  //     );
  //   }

  //   public static async getOrderBooks(symbol: string) {
  //     const { queryString, signature } = BinanceUtil.completeParams({
  //       symbol,
  //       limit: 5,
  //     });

  //     const url = `depth?${queryString}&signature=${signature}`;

  //     try {
  //       const res = await BinanceUtil.getFutureAxiosInstance().get(url);

  //       return res.data;
  //     } catch (err) {
  //       if (
  //         !err.response ||
  //         err.response.status === 502 ||
  //         err.response.data.code === -1021
  //       ) {
  //         await FutureUtil.sleep();
  //         console.log('Failed to get positions');
  //         return FutureUtil.getOrderBooks(symbol);
  //       }

  //       await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
  //       await NotificationUtil.sendMessage(`GET ${url}`);
  //       throw err;
  //     }
  //   }

  //   public static async getPriceChange() {
  //     const url = 'ticker/24hr';

  //     try {
  //       const res = await BinanceUtil.getFutureAxiosInstance().get(url);

  //       return res.data;
  //     } catch (err) {
  //       if (
  //         !err.response ||
  //         err.response.status === 502 ||
  //         err.response.data.code === -1021
  //       ) {
  //         await FutureUtil.sleep();
  //         console.log('Failed to get price change');
  //         return FutureUtil.getPriceChange();
  //       }

  //       await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
  //       await NotificationUtil.sendMessage(`GET ${url}`);
  //       throw err;
  //     }
  //   }

  //   public static async getPrice(symbol: string) {
  //     const { queryString, signature } = BinanceUtil.completeParams({
  //       symbol,
  //     });

  //     const url = `ticker/price?${queryString}&signature=${signature}`;

  //     try {
  //       const res = await BinanceUtil.getFutureAxiosInstance().get(url);

  //       return +res.data.price;
  //     } catch (err) {
  //       if (
  //         !err.response ||
  //         err.response.status === 502 ||
  //         err.response.data.code === -1021
  //       ) {
  //         console.log('Failed to get price');
  //         await FutureUtil.sleep();
  //         return FutureUtil.getPrice(symbol);
  //       }

  //       await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
  //       await NotificationUtil.sendMessage(`GET ${url}`);
  //       throw err;
  //     }
  //   }

  //   public static async cancelOrder(orderId: number, symbol: string) {
  //     const { queryString, signature } = BinanceUtil.completeParams({
  //       symbol,
  //       orderId,
  //     });

  //     const url = `order?${queryString}&signature=${signature}`;

  //     try {
  //       await BinanceUtil.getFutureAxiosInstance().delete(url);
  //     } catch (err) {
  //       if (
  //         !err.response ||
  //         err.response.status === 502 ||
  //         err.response.data.code === -1021 ||
  //         err.response.data.code === -2011
  //       ) {
  //         console.log('Failed to cancel order');
  //         return;
  //       }

  //       await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
  //       await NotificationUtil.sendMessage(`DELETE ${url}`);
  //       throw err;
  //     }
  //   }

  //   public static async createStopOrder(symbol, side, quantity, stopPrice) {
  //     const { queryString, signature } = BinanceUtil.completeParams({
  //       symbol,
  //       side,
  //       type: 'STOP_MARKET',
  //       quantity,
  //       stopPrice,
  //     });

  //     const url = `order?${queryString}&signature=${signature}`;

  //     try {
  //       const res = await BinanceUtil.getFutureAxiosInstance().post(url);

  //       return res.data;
  //     } catch (err) {
  //       if (
  //         !err.response ||
  //         err.response.status === 502 ||
  //         err.response.data.code === -1021
  //       ) {
  //         await FutureUtil.sleep();
  //         return FutureUtil.createStopOrder(symbol, side, quantity, stopPrice);
  //       }

  //       await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
  //       await NotificationUtil.sendMessage(`POST ${url}`);
  //       throw err;
  //     }
  //   }

  static async sleep(time = 1) {
    return new Promise((res, rej) => setTimeout(res, time * 1000));
  }
}

import { find, forEach, isEmpty, round } from 'lodash';
import map = require('lodash/map');
import { BinanceUtil } from './binance-util';
import { NotificationUtil } from './notification-util';

export class FutureUtil {
  public static async getPrecisions() {
    const { queryString, signature } = BinanceUtil.completeParams({});

    try {
      const res = await BinanceUtil.getFutureAxiosInstance().get(
        `exchangeInfo?${queryString}&signature=${signature}`
      );

      const obj = {};

      forEach(res.data.symbols, ({ symbol, pricePrecision, filters }) => {
        const filter = find(
          filters,
          ({ filterType }) => filterType === 'LOT_SIZE'
        );
        const quantityPrecision = /\.(\d+)/.test(filter.minQty)
          ? filter.minQty.match(/\.(\d+)/)[1].length
          : 0;

        obj[symbol] = { pricePrecision, quantityPrecision };
      });

      return obj;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        return FutureUtil.getBalance();
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      throw err;
    }
  }

  public static async getBalance() {
    const { queryString, signature } = BinanceUtil.completeParams({});

    try {
      const res = await BinanceUtil.getFutureV2AxiosInstance().get(
        `balance?${queryString}&signature=${signature}`
      );

      return res.data;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        return FutureUtil.getBalance();
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      throw err;
    }
  }

  public static async getOrder(symbol, orderId) {
    const { queryString, signature } = BinanceUtil.completeParams({
      symbol,
      orderId,
    });

    const url = `order?${queryString}&signature=${signature}`;

    try {
      const res = await BinanceUtil.getFutureAxiosInstance().get(url);

      return res.data;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        await FutureUtil.sleep();
        return FutureUtil.getOrder(symbol, orderId);
      } else if (err.response.data.code === -2013) {
        const res2 = await FutureUtil.getAllOrders(symbol);

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

  public static async getOrders(symbol) {
    const { queryString, signature } = BinanceUtil.completeParams({ symbol });
    const url = `allOrders?${queryString}&signature=${signature}`;

    try {
      const res = await BinanceUtil.getFutureAxiosInstance().get(url);

      return res.data;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        await FutureUtil.sleep();
        return FutureUtil.getOrders(symbol);
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`GET ${url}`);
      throw err;
    }
  }

  public static async getAllOrders(symbol) {
    const { queryString, signature } = BinanceUtil.completeParams({ symbol });
    const url = `openOrders?${queryString}&signature=${signature}`;

    try {
      const res = await BinanceUtil.getFutureAxiosInstance().get(url);

      return res.data;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        await FutureUtil.sleep();
        return FutureUtil.getAllOrders(symbol);
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`GET ${url}`);
      throw err;
    }
  }

  public static async createOrder(symbol, side, quantity, price) {
    const { queryString, signature } = BinanceUtil.completeParams({
      symbol,
      side,
      type: 'LIMIT',
      quantity,
      price,
      timeInForce: 'GTC',
    });

    const url = `order?${queryString}&signature=${signature}`;

    try {
      const res = await BinanceUtil.getFutureAxiosInstance().post(url);

      return res.data;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        await FutureUtil.sleep();
        return FutureUtil.createOrder(symbol, side, quantity, price);
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`POST ${url}`);
      throw err;
    }
  }

  public static async createMarketOrder(symbol, side, quantity) {
    const { queryString, signature } = BinanceUtil.completeParams({
      symbol,
      side,
      type: 'MARKET',
      quantity,
      newOrderRespType: 'RESULT',
    });

    const url = `order?${queryString}&signature=${signature}`;

    try {
      const res = await BinanceUtil.getFutureAxiosInstance().post(url);

      return res.data;
    } catch (err) {
      console.log(err);
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        await FutureUtil.sleep();
        return FutureUtil.createMarketOrder(symbol, side, quantity);
      }

      if (err?.response?.data?.code === -4164) {
        NotificationUtil.sendMessage(`Go close ${symbol} normally`);
        return;
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`POST ${url}`);
      throw err;
    }
  }

  public static async cancelAllOrders(symbol: string) {
    const { queryString, signature } = BinanceUtil.completeParams({
      symbol,
    });

    const url = `allOpenOrders?${queryString}&signature=${signature}`;

    try {
      await BinanceUtil.getFutureAxiosInstance().delete(url);
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        console.log('Failed to cancel orders');
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`DELETE ${url}`);
      throw err;
    }
  }

  public static async getPositions() {
    const { queryString, signature } = BinanceUtil.completeParams({});

    const url = `positionRisk?${queryString}&signature=${signature}`;

    try {
      const res = await BinanceUtil.getFutureAxiosInstance().get(url);

      return res.data;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        await FutureUtil.sleep();
        console.log('Failed to get positions');
        return FutureUtil.getPositions();
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`GET ${url}`);
      throw err;
    }
  }

  public static async cancelPosition() {
    const positions = await FutureUtil.getPositions();
    await Promise.all(
      map(positions, async (position) => {
        const side = +position.positionAmt > 0 ? 'SELL' : 'BUY';

        await FutureUtil.createMarketOrder(
          position.symbol,
          side,
          +position.positionAmt
        );
      })
    );
  }

  public static async getOrderBooks(symbol: string) {
    const { queryString, signature } = BinanceUtil.completeParams({
      symbol,
      limit: 5,
    });

    const url = `depth?${queryString}&signature=${signature}`;

    try {
      const res = await BinanceUtil.getFutureAxiosInstance().get(url);

      return res.data;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        await FutureUtil.sleep();
        console.log('Failed to get positions');
        return FutureUtil.getOrderBooks(symbol);
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`GET ${url}`);
      throw err;
    }
  }

  public static async getPriceChange() {
    const url = 'ticker/24hr';

    try {
      const res = await BinanceUtil.getFutureAxiosInstance().get(url);

      return res.data;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        await FutureUtil.sleep();
        console.log('Failed to get price change');
        return FutureUtil.getPriceChange();
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`GET ${url}`);
      throw err;
    }
  }

  public static async getPrice(symbol: string) {
    try {
      const orderBooks = await FutureUtil.getOrderBooks(symbol);
      const bidPrice = orderBooks.bids[0][0];
      const askPrice = orderBooks.asks[0][0];
      const pricePrecision = bidPrice.match(/\.(\d+)/)[1].length;
      return round((+bidPrice + +askPrice) / 2, pricePrecision);
      // const { queryString, signature } = BinanceUtil.completeParams({
      //   symbol,
      // });

      // const url = `ticker/price?${queryString}&signature=${signature}`;

      // try {
      //   const res = await BinanceUtil.getFutureAxiosInstance().get(url);

      //   return +res.data.price;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        console.log('Failed to get price');
        await FutureUtil.sleep();
        return FutureUtil.getPrice(symbol);
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      // await NotificationUtil.sendMessage(`GET ${url}`);
      throw err;
    }
  }

  public static async cancelOrder(orderId: number, symbol: string) {
    const { queryString, signature } = BinanceUtil.completeParams({
      symbol,
      orderId,
    });

    const url = `order?${queryString}&signature=${signature}`;

    try {
      await BinanceUtil.getFutureAxiosInstance().delete(url);
      return true;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021 ||
        err.response.data.code === -2011
      ) {
        // console.log(err);
        console.log(symbol)

        console.log('Failed to cancel order');
        return false;
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`DELETE ${url}`);
      throw err;
    }
  }

  public static async createStopOrder(
    symbol,
    side,
    quantity,
    stopPrice,
    closePosition = false
  ) {
    const { queryString, signature } = BinanceUtil.completeParams({
      symbol,
      side,
      type: 'STOP_MARKET',
      quantity: closePosition ? undefined : quantity,
      stopPrice,
      closePosition,
    });

    const url = `order?${queryString}&signature=${signature}`;

    try {
      const res = await BinanceUtil.getFutureAxiosInstance().post(url);

      return res.data;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        await FutureUtil.sleep();
        return FutureUtil.createStopOrder(
          symbol,
          side,
          quantity,
          stopPrice,
          closePosition
        );
      }

      if (err?.response?.data?.code !== -2021) {
        await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
        await NotificationUtil.sendMessage(`POST ${url}`);
      }

      throw err;
    }
  }

  static async sleep(time = 1) {
    return new Promise((res, rej) => setTimeout(res, time * 1000));
  }

  static async getPrecision(symbol: string) {
    const orderBooks = await FutureUtil.getOrderBooks(symbol);

    const price = orderBooks.bids[0][0];
    const qty = orderBooks.bids[0][1];

    return {
      pricePrecision: /\.(\d+)/.test(price)
        ? price.match(/\.(\d+)/)[1].length
        : 0,
      quantityPrecision: /\.(\d+)/.test(qty)
        ? qty.match(/\.(\d+)/)[1].length
        : 0,
    };
  }

  static async getAvgPrice(symbol: string) {
    const positions = await FutureUtil.getPositions();

    return +find(positions, { symbol }).entryPrice;
  }

  static async closePosition(symbol: string) {
    await FutureUtil.cancelAllOrders(symbol);

    const positions = await FutureUtil.getPositions();

    const position = find(positions, { symbol });
    if (+position.positionAmt > 0) {
      await FutureUtil.createMarketOrder(
        symbol,
        'SELL',
        Math.abs(+position.positionAmt)
      );
    } else if (+position.positionAmt < 0) {
      await FutureUtil.createMarketOrder(
        symbol,
        'BUY',
        Math.abs(+position.positionAmt)
      );
    }
  }
}

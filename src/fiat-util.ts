import { BinanceUtil } from './binance-util';
import { NotificationUtil } from './notification-util';

export class FiatUtil {
  public static async getOrders(
    tradeType = 'BUY',
    orders = [],
    startTime = new Date().getTime() - 2000000000,
    endTime = new Date().getTime()
  ) {
    const { queryString, signature } = BinanceUtil.completeParams({
      startTimestamp: startTime,
      endTimestamp: endTime,
      tradeType,
      recvWindow: 60000,
    });

    try {
      const res = await BinanceUtil.getFiatAxiosInstance().get(
        `orderMatch/listUserOrderHistory?${queryString}&signature=${signature}`
      );

      const o = res.data.data;

      if (startTime < new Date('2020-01-01').getTime()) {
        return orders;
      }

      return o.concat(
        await FiatUtil.getOrders(
          tradeType,
          o,
          startTime - 2000000000,
          startTime
        )
      );
    } catch (err) {
      console.log(err);
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021
      ) {
        return FiatUtil.getOrders();
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      throw err;
    }
  }
}

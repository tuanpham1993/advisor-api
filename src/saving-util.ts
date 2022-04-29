import { BinanceUtil } from './binance-util';
import { ExchangeUtil } from './exchange-util';
import { NotificationUtil } from './notification-util';

export class SavingUtil {
  public static async getPosition(asset, portfolioId = 1) {
      console.log(asset)
    const { queryString, signature } = BinanceUtil.completeParams(
      { asset:'CAKE' },
      portfolioId
    );

    const url = `project/position/list?${queryString}&signature=${signature}`;
    console.log(url)
    try {
      const res = await BinanceUtil.getSavingAxiosInstance().get(url);
        console.log(res.data)
      return res.data;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021 ||
        err.response.data.code === -1001
      ) {
        await ExchangeUtil.sleep();
        return SavingUtil.getPosition(portfolioId);
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`GET ${url}`);
      throw err;
    }
  }
}

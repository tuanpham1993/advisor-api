import { BinanceUtil } from './binance-util';
import { ExchangeUtil } from './exchange-util';
import { NotificationUtil } from './notification-util';

export class MarginUtil {
  public static async getBalances(portfolioId) {
    const { queryString, signature } = BinanceUtil.completeParams(
      {},
      portfolioId
    );

    const url = `account?${queryString}&signature=${signature}`;

    try {
      const res = await BinanceUtil.getMarginAxiosInstance().get(url);

      return res.data.userAssets;
    } catch (err) {
      if (
        !err.response ||
        err.response.status === 502 ||
        err.response.data.code === -1021 ||
        err.response.data.code === -1001
      ) {
        await ExchangeUtil.sleep();
        return MarginUtil.getBalances(portfolioId);
      }

      await NotificationUtil.sendMessage(JSON.stringify(err.response.data));
      await NotificationUtil.sendMessage(`GET ${url}`);
      throw err;
    }
  }
}

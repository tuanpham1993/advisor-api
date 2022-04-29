import axios from 'axios';
import crypto = require('crypto');
import querystring = require('querystring');

export class BinanceUtil {
  public static getFutureV2AxiosInstance() {
    return axios.create({
      baseURL: 'https://fapi.binance.com/fapi/v2',
      headers: {
        'X-MBX-APIKEY': process.env.BNB_API_KEY,
      },
    });
  }

  public static getFutureAxiosInstance() {
    return axios.create({
      baseURL: 'https://fapi.binance.com/fapi/v1',
      headers: {
        'X-MBX-APIKEY': process.env.BNB_API_KEY,
      },
    });
  }

  public static getFiatAxiosInstance() {
    return axios.create({
      baseURL: 'https://api.binance.com/sapi/v1/c2c',
      headers: {
        'X-MBX-APIKEY': process.env.BNB_API_KEY,
      },
    });
  }

  public static getExchangeAxiosInstance(portfolioId = 1) {
    return axios.create({
      baseURL: 'https://api.binance.com/api/v3',
      headers: {
        'X-MBX-APIKEY': process.env[`BNB_API_KEY_${portfolioId}`],
      },
    });
  }

  public static getMarginAxiosInstance() {
    return axios.create({
      baseURL: 'https://api.binance.com/sapi/v1/margin',
      headers: {
        'X-MBX-APIKEY': process.env.BNB_API_KEY,
      },
    });
  }

  public static getSavingAxiosInstance() {
    return axios.create({
      baseURL: 'https://api.binance.com/sapi/v1/lending',
      headers: {
        'X-MBX-APIKEY': process.env.BNB_API_KEY,
      },
    });
  }

  public static completeParams(param, portfolioId = 1) {
    const appendedTimestamp = {
      ...JSON.parse(JSON.stringify(param)),
      timestamp: new Date().getTime(),
    };

    const queryString = querystring.stringify(appendedTimestamp);
    const signature = BinanceUtil.sign(queryString, portfolioId);

    return {
      signature,
      queryString,
    };
  }

  public static sign(text, portfolioId = 1) {
    return crypto
      .createHmac('sha256', process.env[`BNB_API_SECRET_${portfolioId}`])
      .update(text)
      .digest('hex');
  }
}

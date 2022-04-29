import WebSocket = require('ws');
import { FutureUtil } from './future-util';
import round = require('lodash/round');
import { NotificationUtil } from './notification-util';
import {
  ceil,
  filter,
  max,
  min,
  orderBy,
  reduce,
  some,
  sortBy,
  take,
} from 'lodash';
import { Pool } from 'pg';

const usedSymbols = [
  // 'ETHUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOTUSDT',
  'LTCUSDT',
  'UNIUSDT',
  'XLMUSDT',
  'LINKUSDT',
  'BCHUSDT',
  // 'THETAUSDT',
  // 'FILUSDT',
  'ETCUSDT',
];
const unusedSymbols = [
  'BTCUSDT',
  'ETHUSDT',
  'BTCBUSD',
  'YFIUSDT',
  'MKRUSDT',
  'DEFIUSDT',
  'YFIIUSDT',
  'ETHUSDT',
  'UNIUSDT',
  'AXSUSDT',
  // 'CTKUSDT',
  'KNSUSDT',
  'RSRUSDT',
  'HNTUSDT',
  'SOLUSDT',
];

let now = Date.now();
let btcPrices = [];
let downTrend = false;
let recentPrices = [];
let priceChanges;
const pool = new Pool();

let orderCache = {
  time: null,
};

let active = false;

export default class Bot {
  public static now() {
    return now;
  }

  public static config = {
    normalMaxRiskyLongPositions: 10,
    normalMaxRiskyShortPositions: 1,
    downtrendMaxRiskyLongPositions: 15,
    normalMaxRiskyVolume: 600,
    downtrendMaxRiskyVolume: 1000,
    positionVolume: 30,
    takeProfitOrderBudget: 10,
    cutOrderBudget: 15,
    dcaBudgets: [20, 30, 40],
    dcaPercentages: [0.05, 0.1, 0.15],
  };

  static clearOrderCache() {
    const current = Date.now();

    if (orderCache.time && current - orderCache.time > 30 * 1000) {
      orderCache.time = null;
    }
  }

  public static async toTheMoon() {
    const currentPositions = await Bot.getSnapshot();
    const riskyPositions = filter(
      currentPositions,
      ({ status, side }) => status !== 2 && side === 'LONG'
    );
    const riskyVol = reduce(
      riskyPositions,
      (accum, position) =>
        accum + +position.position.markPrice * +position.position.positionAmt,
      0
    );

    if (
      riskyPositions.length >= Bot.config.normalMaxRiskyLongPositions ||
      riskyVol >= Bot.config.normalMaxRiskyVolume
    ) {
      return;
    }

    if (orderCache.time) {
      return;
    }

    const longItems = take(
      sortBy(
        filter(
          priceChanges,
          (t) =>
            !currentPositions.some((p) => p && p.symbol === t.symbol) &&
            !unusedSymbols.includes(t.symbol) &&
            // usedSymbols.includes(t.symbol) &&
            +t.priceChangePercent < 5 &&
            !/BTCBUSD/.test(t.symbol) &&
            !/BTCUSDT/.test(t.symbol) &&
            !/ETHUSDT/.test(t.symbol)
        ),
        (item) => +item.priceChangePercent
      ),
      1
    );

    if (longItems.length > 0) {
      orderCache.time = Date.now();

      const item = longItems[0];

      const cPrice = await FutureUtil.getPrice(item.symbol);

      const { quantityPrecision } = await FutureUtil.getPrecision(item.symbol);

      NotificationUtil.sendMessage(`LONG ${item.symbol}`);

      await FutureUtil.createMarketOrder(
        item.symbol,
        'BUY',
        ceil(Bot.config.positionVolume / cPrice, quantityPrecision)
      );
    }
  }

  public static async toTheEarth() {
    const currentPositions = await Bot.getSnapshot();
    const riskyPositions = filter(
      currentPositions,
      ({ status, side }) => status !== 2 && side === 'SHORT'
    );

    if (riskyPositions.length >= Bot.config.normalMaxRiskyShortPositions) {
      return;
    }

    if (orderCache.time) {
      return;
    }

    const shortItems = take(
      orderBy(
        filter(
          priceChanges,
          (t) =>
            !currentPositions.some((p) => p && p.symbol === t.symbol) &&
            !unusedSymbols.includes(t.symbol) &&
            // usedSymbols.includes(t.symbol) &&
            +t.priceChangePercent > 5 &&
            !/BTCBUSD/.test(t.symbol) &&
            !/BTCUSDT/.test(t.symbol) &&
            !/ETHUSDT/.test(t.symbol)
        ),
        (item) => +item.priceChangePercent,
        'desc'
      ),
      1
    );

    if (shortItems.length > 0) {
      orderCache.time = Date.now();

      const item = shortItems[0];

      const cPrice = await FutureUtil.getPrice(item.symbol);

      const { quantityPrecision } = await FutureUtil.getPrecision(item.symbol);

      NotificationUtil.sendMessage(`SHORT ${item.symbol}`);

      await FutureUtil.createMarketOrder(
        item.symbol,
        'SELL',
        ceil(Bot.config.positionVolume / cPrice, quantityPrecision)
      );
    }
  }

  public static async updateConfig() {
    const { rows } = await pool.query('SELECT * FROM future_config LIMIT 1');
    console.log(rows)

    Bot.config = rows[0].config;
  }

  public static async saveConfig(config) {
    await pool.query(
      `UPDATE future_config SET config = '${JSON.stringify(config)}'`
    );
  }

  public static async updatePriceChanges() {
    priceChanges = await FutureUtil.getPriceChange();
  }

  public static async init() {
    await Bot.updateConfig();

    setInterval(async () => {
      Bot.clearOrderCache();
      await Bot.updatePriceChanges();
      await Bot.toTheMoon();
      await Bot.toTheEarth();
    }, 10000);

    const ws = new WebSocket(
      `wss://fstream.binance.com/ws/btcusdt@markPrice@1s`
    );

    ws.on('message', async function incoming(data) {
      now = Date.now();

      try {
        const price = +JSON.parse(data).p;
        btcPrices.push(price);
        if (btcPrices.length > 60) {
          btcPrices.shift();
        }

        if (downTrend) {
          recentPrices.push(price);

          if (recentPrices.length > 3) {
            if (
              recentPrices[recentPrices.length - 1] >
              max(recentPrices) * 0.9998
            ) {
              const oldPrice = max(btcPrices);
              const ratio = ((oldPrice - price) / oldPrice) * 100;

              if (!active) {
                active = true;
                await Bot.long(ratio);

                setTimeout(() => {
                  active = false;
                }, 30000);

                return;
              }

              downTrend = false;
              recentPrices = [];
              btcPrices = [];
            } else {
              recentPrices.shift();
            }
          }
        } else {
          if (some(btcPrices, (oldPrice) => price < oldPrice * 0.99)) {
            downTrend = true;
          }
        }
      } catch (err) {
        console.log(err);
      }
    });

    ws.on('close', function clear() {
      this.terminate();
      Bot.init();
    });
  }

  static async getSnapshot() {
    const { rows } = await pool.query('SELECT * FROM snap LIMIT 1');
    return rows?.[0]?.positions;
  }

  static async long(ratio) {
    if (ratio < 1) {
      ratio = 1;
    }

    const priceChanges = await FutureUtil.getPriceChange();
    const currentPositions = await Bot.getSnapshot();
    const riskyPositions = filter(
      currentPositions,
      ({ status, side }) => status !== 2 && side === 'LONG'
    );
    const riskyVol = reduce(
      riskyPositions,
      (accum, position) =>
        accum + +position.position.markPrice * +position.position.positionAmt,
      0
    );

    if (
      riskyPositions.length >= Bot.config.downtrendMaxRiskyLongPositions ||
      riskyVol >= Bot.config.downtrendMaxRiskyVolume
    ) {
      NotificationUtil.sendMessage('Long signal but too risky');
      return;
    }

    // let realQty = 0;
    // if (qty + currentPositions.length < maxPositions) {
    //   realQty = qty;
    // } else {
    //   realQty = maxPositions - currentPositions.length;
    // }

    // if (realQty <= 0) {
    //   return;
    // }

    const longItems = take(
      sortBy(
        filter(
          priceChanges,
          (t) =>
            !currentPositions.some((p) => p && p.symbol === t.symbol) &&
            !unusedSymbols.includes(t.symbol) &&
            // usedSymbols.includes(t.symbol) &&
            +t.priceChangePercent < 0 &&
            !/BTCBUSD/.test(t.symbol) &&
            !/BTCUSDT/.test(t.symbol) &&
            !/ETHUSDT/.test(t.symbol)
        ),
        (item) => +item.priceChangePercent
      ),
      1
    );

    // if (longItems.length > 0) {
    const item = longItems[0];
    const cPrice = await FutureUtil.getPrice(item.symbol);

    const { quantityPrecision } = await FutureUtil.getPrecision(item.symbol);

    NotificationUtil.sendMessage(`LONG ${item.symbol}, ratio = ${ratio}`);

    await FutureUtil.createMarketOrder(
      item.symbol,
      'BUY',
      ceil((Bot.config.positionVolume * ratio) / cPrice, quantityPrecision)
    );
    // }
  }
}

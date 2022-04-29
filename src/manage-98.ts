import { ExchangeUtil } from './exchange-util';
import {
  filter,
  map,
  isEmpty,
  round,
  floor,
  some,
  replace,
  max,
  min,
  reduce,
  find,
  isNil,
  groupBy,
  toPairs,
  forEach,
  cloneDeep,
  sortBy,
  reverse,
  includes,
  mean,
} from 'lodash';
import axios from 'axios';
import { NotificationUtil } from './notification-util';

import { Pool } from 'pg';
import { FutureUtil } from './future-util';
import { MarginUtil } from './margin-util';
import { SavingUtil } from './saving-util';
const pool = new Pool();

let selledCache = [];
let targetCache = [];
let now = Date.now();
let precisions;

export class Manage98 {
  public static assets;

  public static now() {
    return now;
  }

  static async init() {
    precisions = await ExchangeUtil.getPrecisions();
    await Manage98.updateConfig();
    await Manage98.update();
  }

  static async updateConfig() {
    const { rows: assets } = await pool.query(
      'SELECT * FROM assets WHERE enabled IS TRUE'
    );

    Manage98.assets = assets;
  }

  static async update() {
    now = Date.now();

    const prices = await ExchangeUtil.getCoinGeckoPrices();

    const exBalances = await ExchangeUtil.getBalances(1);
    const marginBalances = await MarginUtil.getBalances(1);

    const balances = await Promise.all(
      map(exBalances, async (balance) => {
        const marginBalance = find(marginBalances, { asset: balance.asset });

        return {
          ...balance,
          free: +balance.free + (+marginBalance?.free || 0),
          locked: +balance.locked + (+marginBalance?.locked || 0),
        };
      })
    );

    const assets = await Promise.all(
      map(Manage98.assets, async (asset) => {
        const symbol = `${asset.name}${asset.pair}`;
        if (precisions[symbol]) {
          const { pricePrecision, quantityPrecision } = precisions[symbol];
          asset.pricePrecision = pricePrecision;
          asset.quantityPrecision = quantityPrecision;
        }

        try {
          asset.currentPrice = round(
            await ExchangeUtil.getPrice(symbol),
            asset.pricePrecision
          );
        } catch (err) {
          asset.currentPrice = prices[symbol];
        }

        /* 
            Notify when price change 5%
        */
        if (!asset.prevCurrentPrice) {
          asset.prevCurrentPrice = asset.currentPrice;
        }
        const change = round(
          (asset.currentPrice / asset.prevCurrentPrice - 1) * 100,
          1
        );
        if (Math.abs(change) >= 5) {
          NotificationUtil.sendMessage(
            `${asset.name} ${
              change > 0 ? `increase` : `decrease`
            } ${change}%, current ${asset.currentPrice}`
          );
          asset.prevCurrentPrice = asset.currentPrice;
        }

        /*
            Notify when price change -25%
        */
        if (asset.setpointPrice) {
          asset.change = round(
            (asset.currentPrice / asset.setpointPrice - 1) * 100,
            0
          );

          if (asset.change <= -25) {
            // NotificationUtil.sendMessage(
            //   `${asset.name} decrease ${asset.change}%, current ${asset.currentPrice}`
            // );
          }
        }

        /*
            Create SL when price change
        */
        // if (
        //   !isEmpty(asset.buyPrices) &&
        //   (isNil(asset.externalQty) || asset.externalQty === 0)
        // ) {
        //   const entryQty = reduce(
        //     asset.buyPrices,
        //     (qty, price) => qty + 100 / price,
        //     0
        //   );
        //   const avgBuyPrice = round(
        //     (100 * asset.buyPrices.length) / entryQty,
        //     asset.pricePrecision
        //   );
        //   asset.avgBuyPrice = avgBuyPrice;

        //   if (asset.currentPrice / avgBuyPrice >= 3.1) {
        //     const slPrice = round(avgBuyPrice * 3, asset.pricePrecision);

        //     if (!asset.slPrice || asset.slPrice < slPrice) {
        //       NotificationUtil.sendMessage(`${asset.name} create SL at 300%`);
        //       asset.slPrice = slPrice;
        //       await pool.query(
        //         `UPDATE assets SET "slPrice" = ${slPrice} WHERE name = '${asset.name}'`
        //       );
        //     }
        //   } else if (asset.currentPrice / avgBuyPrice >= 2.6) {
        //     const slPrice = round(avgBuyPrice * 2.5, asset.pricePrecision);

        //     if (!asset.slPrice || asset.slPrice < slPrice) {
        //       NotificationUtil.sendMessage(`${asset.name} create SL at 250%`);
        //       asset.slPrice = slPrice;
        //       await pool.query(
        //         `UPDATE assets SET "slPrice" = ${slPrice} WHERE name = '${asset.name}'`
        //       );
        //     }
        //   } else if (asset.currentPrice / avgBuyPrice >= 2.1) {
        //     const slPrice = round(avgBuyPrice * 2, asset.pricePrecision);

        //     if (!asset.slPrice || asset.slPrice < slPrice) {
        //       NotificationUtil.sendMessage(`${asset.name} create SL at 200%`);
        //       asset.slPrice = slPrice;
        //       await pool.query(
        //         `UPDATE assets SET "slPrice" = ${slPrice} WHERE name = '${asset.name}'`
        //       );
        //     }
        //   } else if (asset.currentPrice / avgBuyPrice >= 1.6) {
        //     const slPrice = round(avgBuyPrice * 1.5, asset.pricePrecision);

        //     if (!asset.slPrice || asset.slPrice < slPrice) {
        //       NotificationUtil.sendMessage(`${asset.name} create SL at 150%`);
        //       asset.slPrice = slPrice;
        //       await pool.query(
        //         `UPDATE assets SET "slPrice" = ${slPrice} WHERE name = '${asset.name}'`
        //       );
        //     }
        //   } else if (asset.currentPrice / avgBuyPrice >= 1.2) {
        //     const slPrice = round(avgBuyPrice * 1.1, asset.pricePrecision);

        //     if (!asset.slPrice || asset.slPrice < slPrice) {
        //       NotificationUtil.sendMessage(`${asset.name} create SL at 110%`);
        //       asset.slPrice = slPrice;
        //       await pool.query(
        //         `UPDATE assets SET "slPrice" = ${slPrice} WHERE name = '${asset.name}'`
        //       );
        //     }
        //   }

        //   if (asset.slPrice && asset.currentPrice < asset.slPrice) {
        //     NotificationUtil.sendMessage(`${asset.nname} SL hit`);

        //     const sellQty = round(
        //       asset.budget / asset.slPrice,
        //       asset.quantityPrecision
        //     );
        //     await ExchangeUtil.createMarketOrder(
        //       `${asset.name}USDT`,
        //       'SELL',
        //       sellQty
        //     );
        //     await pool.query(
        //       `UPDATE assets SET "budget" = 0, "buyPrices" = '[]', "setpointPrice" = ${asset.currentPrice}, "slPrice" = NULL WHERE name = '${asset.name}'`
        //     );
        //     asset.slPrice = null;
        //     asset.buyPrices = [];
        //     asset.budget = 0;
        //     asset.setpointPrice = asset.currentPrice;
        //   }
        // }

        if (some(balances, { asset: asset.name })) {
          const exBalance = find(balances, { asset: asset.name });
          asset.quantity = round(
            +exBalance.free + +exBalance.locked,
            asset.quantityPrecision
          );
          await pool.query(
            `UPDATE assets SET "quantity" = ${asset.quantity} WHERE name = '${asset.name}'`
          );
        }

        asset.qty = asset.quantity + asset.externalQty;

        if (precisions[symbol]) {
          asset.qty = round(asset.qty, asset.quantityPrecision);
        }
        asset.totalBudget = round(asset.currentPrice * asset.qty);

        if (asset.name === 'BUSD') {
          console.log(asset)
        }

        return asset;
      })
    );

    Manage98.assets = reverse(
      sortBy(
        filter(assets, (asset) => !isNil(asset)),
        'totalBudget'
      )
    );

    await FutureUtil.sleep(5);
    Manage98.update();
  }

  static async calcSymbolSummary(pair) {
    let symbol = replace(pair, 'BUSD', '');
    symbol = replace(symbol, 'USDT', '');

    const usdtOrders = await ExchangeUtil.getAllOrders(`${symbol}USDT`);
    const busdOrders = await ExchangeUtil.getAllOrders(`${symbol}BUSD`);
    const allOrders = usdtOrders.concat(busdOrders);

    const currentPrice = await ExchangeUtil.getPrice(`${symbol}BUSD`);
    const { pricePrecision } = precisions[`${symbol}BUSD`];

    return ExchangeUtil.calcSummaryFromOrders(
      currentPrice,
      pricePrecision,
      allOrders
    );
  }
}

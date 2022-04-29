import { Pool } from 'pg';
import { FutureUtil } from './future-util';
import { NotificationUtil } from './notification-util';
import { v4 as uuidv4 } from 'uuid';
import WebSocket = require('ws');
import {
  cloneDeep,
  differenceBy,
  isEmpty,
  map,
  max,
  min,
  find,
  round,
  ceil,
  isNil,
  filter,
  orderBy,
  split,
  sortBy,
  some,
  floor,
  reverse,
  take,
  takeRight,
  findLast,
  get,
} from 'lodash';

let precisions;
const profitRatio = 0.0075;
const minProfit = 0.05;
const minProfitAfterDca = 0.05;
const stopPriceLimitPriceDistance = 0.01; // from stop price to price
const stopPricesDistance = 0.01; // from stop price to other stop price
const maxEntryBudgetDiffAllow = 5;
const increaseVolParam = 0.5;
let currentPrices = [];

const pool = new Pool();

const minBudget = 6; // min amount to determine a position

enum Statuses {
  START,
  DCA,
  PROFIT,
  DONE,
}

let now = Date.now();

const baseBudget = +process.env.BASE_BUDGET || 7;
const dcaBaseBudget = +process.env.DCA_BASE_BUDGET || 7;

export class ManageFuture {
  public static config = {
    baseBudget,
    dcaBudgets: [dcaBaseBudget, dcaBaseBudget, dcaBaseBudget],
    dcaPercentages: map(process.env.DCA_RATIOS.split(','), (r) => +r),

    usd: 0,
    longNumPos: +process.env.NUM_OF_LONG,
    shortNumPos: +process.env.NUM_OF_SHORT,
  };

  static toManual = null;
  static sl = {};

  static allPositions = []; // positions get from bnc
  static positions = []; // managed positions
  static orders = [];
  static hasPendingSnapOrders = false;
  static btcPrice;
  static priceChanges = [];

  public static now() {
    return now;
  }

  static async start() {
    precisions = await FutureUtil.getPrecisions();

    const { positions, orders } = await ManageFuture.getSnapshot();

    ManageFuture.orders = orders;
    if (!isEmpty(positions)) {
      ManageFuture.positions = positions;
    }

    await ManageFuture.updateCurrentPrices();
    await ManageFuture.update();
  }

  static async updateBalance() {
    const bnbPrice = await FutureUtil.getPrice('BNBUSDT');
    const balances = await FutureUtil.getBalance();
    const usdtBalance = find(balances, { asset: 'USDT' });
    const bnbBalance = find(balances, { asset: 'BNB' });
    ManageFuture.config.usd = round(
      +usdtBalance.balance +
        +usdtBalance.crossUnPnl +
        +bnbBalance.balance * bnbPrice,
      1
    );
  }

  static async update() {
    await ManageFuture.updateBalance();
    await ManageFuture.removeDonePositions();
    await ManageFuture.addPos();
    await ManageFuture.updatePositions();
    await ManageFuture.monitorPositions();

    await ManageFuture.snap();
    await ManageFuture.snapOrders();

    await FutureUtil.sleep(5);

    now = Date.now();
    ManageFuture.update();
  }

  static async removeDonePositions() {
    ManageFuture.positions = filter(
      ManageFuture.positions,
      (position) => !isNil(position)
    );
  }

  static async updatePositions() {
    const allPositions = await FutureUtil.getPositions();

    ManageFuture.allPositions = allPositions;

    const activePositions = filter(
      allPositions,
      ({ positionAmt, markPrice }) =>
        +positionAmt !== 0 && Math.abs(+positionAmt * +markPrice) >= minBudget
    );

    const newPositions = differenceBy(
      activePositions,
      ManageFuture.positions,
      'symbol'
    );

    if (!isEmpty(newPositions)) {
      for (const newPosition of newPositions) {
        const { pricePrecision, quantityPrecision } =
          precisions[newPosition.symbol];

        const currentPrice = await FutureUtil.getPrice(newPosition.symbol);

        const side = +newPosition.positionAmt > 0 ? 'LONG' : 'SHORT';
        const dcaType = side === 'LONG' ? 'BUY' : 'SELL';
        const takeProfitType = side === 'LONG' ? 'SELL' : 'BUY';
        const dcaCount = 0;
        const manual =
          Math.abs(+newPosition.positionAmt * +newPosition.entryPrice) > 20;

        const avgPrice = ceil(+newPosition.entryPrice, pricePrecision);

        const dcaPrice = ManageFuture.calcDcaPrice({
          side,
          position: newPosition,
          pricePrecision,
          dcaCount,
          currentPrice,
        });

        ManageFuture.positions.push({
          id: uuidv4(),
          symbol: newPosition.symbol,
          side,
          dcaType,
          takeProfitType,
          pricePrecision,
          quantityPrecision,

          entryPrice: avgPrice,
          avgPrice,
          currentPrice,
          dcaPrice,
          dcaPriceFixed: dcaPrice,
          cutPrice: null,
          childDcaPrice: null,
          slPrice: null,

          entryQty: Math.abs(+newPosition.positionAmt),

          dcaOrder: null,
          childDcaOrder: null,
          cutOrder: null,
          filledDcaOrders: [],
          filledCutOrders: [],
          filledChildDcaOrders: [],

          profitRatio,
          dcaBudgets: ManageFuture.config.dcaBudgets,

          status: dcaCount === 0 ? Statuses.START : Statuses.DCA,

          dcaCount,
          cutMinusDca: 0,
          dcaPendingCounter: 0,
          cutPendingCounter: 0,
          childDcaPendingCounter: 0,

          manual,

          createdAt: Date.now(),
        });
      }
    }
  }

  static async monitorPositions() {
    ManageFuture.positions = await Promise.all(
      map(ManageFuture.positions, async (pos) => {
        return pos.manual
          ? ManageFuture.monitorManualPos(pos)
          : ManageFuture.monitorPosition(pos);
      })
    );
  }

  static async monitorPosition(cPosition) {
    let position = cloneDeep(cPosition);

    if (ManageFuture.toManual == position.symbol) {
      position.manual = true;
      ManageFuture.toManual = null;
      return position;
    }

    // const currentPrice = await FutureUtil.getPrice(position.symbol);
    const currentPrice = currentPrices[position.symbol];
    position.currentPrice = currentPrice;

    if (position) {
      position.position = find(ManageFuture.allPositions, {
        symbol: position.symbol,
      });

      if (
        (position?.position?.positionAmt < 0 && position.side === 'LONG') ||
        (position?.position?.positionAmt > 0 && position.side === 'SHORT')
      ) {
        position.error = true;
        NotificationUtil.sendMessage(`${position.symbol} error`);
      } else {
        position.error = false;
      }
    }

    ManageFuture.updateStop(position);
    ManageFuture.updatePositionUpDownDistance(position);

    // Close if position closed by user, move out
    if (+position.position.positionAmt === 0) {
      return null;
    }

    position.elapsedTime = ManageFuture.msToTime(
      Date.now() - position.createdAt
    );

    if (position.status === Statuses.START) {
      await ManageFuture.manageEntry(position);
    } else if (position.status === Statuses.DCA) {
      await ManageFuture.manageDca(position);
    } else if (position.status === Statuses.PROFIT) {
      const done = await ManageFuture.manageProfit(position);

      if (done) {
        // NotificationUtil.sendMessage(`${position.symbol} DONE`);
        return null;
      }
    }

    return position;
  }

  static async monitorManualPos(cPosition) {
    let position = cloneDeep(cPosition);
    // const currentPrice = await FutureUtil.getPrice(position.symbol);
    const currentPrice = currentPrices[position.symbol];
    position.currentPrice = currentPrice;

    if (position) {
      position.position = find(ManageFuture.allPositions, {
        symbol: position.symbol,
      });

      if (
        (position?.position?.positionAmt < 0 && position.side === 'LONG') ||
        (position?.position?.positionAmt > 0 && position.side === 'SHORT')
      ) {
        position.error = true;
        NotificationUtil.sendMessage(`${position.symbol} error`);
      } else {
        position.error = false;
      }
    }

    const orders = filter(
      await FutureUtil.getOrders(position.symbol),
      (order) => order.time > position.createdAt && order.status === 'FILLED'
    );

    if (
      ManageFuture.sl[position.symbol] &&
      ManageFuture.sl[position.symbol] != position.slPercentage
    ) {
      position.slPercentage = ManageFuture.sl[position.symbol];
      position.slPrice =
        position.side === 'LONG'
          ? round(
              position.avgPrice * (1 + position.slPercentage / 100),
              position.pricePrecision
            )
          : round(
              position.avgPrice * (1 - position.slPercentage / 100),
              position.pricePrecision
            );
      ManageFuture.sl[position.symbol] = undefined;
    }

    if (position.side === 'LONG') {
      if (position.slPrice && position.currentPrice < position.slPrice) {
        await FutureUtil.createMarketOrder(
          position.symbol,
          'SELL',
          round(+position.position.positionAmt, position.quantityPrecision)
        );

        return null;
      }

      const newOrders = differenceBy(
        orders,
        position.filledDcaOrders.concat(position.filledCutOrders),
        'orderId'
      );

      const newDcaOrders = filter(
        newOrders,
        (order) => get(order, 'side') === 'BUY'
      );
      if (!isEmpty(newDcaOrders)) {
        position.filledDcaOrders.push(...newDcaOrders);
        position.lastOrder =
          position.filledDcaOrders[position.filledDcaOrders.length - 1];
      }

      const newCutOrders = filter(
        newOrders,
        (order) => get(order, 'side') === 'SELL'
      );
      if (!isEmpty(newCutOrders)) {
        position.filledCutOrders.push(...newCutOrders);
        position.lastOrder =
          position.filledCutOrders[position.filledCutOrders.length - 1];
      }
    } else if (position.side === 'SHORT') {
      if (position.slPrice && position.currentPrice > position.slPrice) {
        await FutureUtil.createMarketOrder(
          position.symbol,
          'BUY',
          round(
            Math.abs(+position.position.positionAmt),
            position.quantityPrecision
          )
        );

        return null;
      }

      const newOrders = differenceBy(
        orders,
        position.filledDcaOrders.concat(position.filledCutOrders),
        'orderId'
      );

      const newDcaOrders = filter(
        newOrders,
        (order) => get(order, 'side') === 'SELL'
      );
      if (!isEmpty(newDcaOrders)) {
        position.filledDcaOrders.push(...newDcaOrders);
        position.lastOrder =
          position.filledDcaOrders[position.filledDcaOrders.length - 1];
      }

      const newCutOrders = filter(
        newOrders,
        (order) => get(order, 'side') === 'BUY'
      );
      if (!isEmpty(newCutOrders)) {
        position.filledCutOrders.push(...newCutOrders);
        position.lastOrder =
          position.filledCutOrders[position.filledCutOrders.length - 1];
      }
    }

    position.avgPrice = ManageFuture.calcAvgPrice(position);
    position.calcProfit = round(
      (position.currentPrice - position.avgPrice) *
        +position.position.positionAmt,
      1
    );
    position.priceChange = round(
      ((position.side === 'LONG'
        ? position.currentPrice / position.avgPrice
        : position.avgPrice / position.currentPrice) -
        1) *
        100,
      1
    );

    // Close if position closed by user, move out
    if (+position.position.positionAmt === 0) {
      return null;
    }

    position.elapsedTime = ManageFuture.msToTime(
      Date.now() - position.createdAt
    );

    return position;
  }

  static async manageDcaOrder(position) {
    // Monitor DCA order
    if (position.dcaOrder) {
      const dcaOrder = await FutureUtil.getOrder(
        position.symbol,
        position.dcaOrder.orderId
      );

      const dcaStatus = dcaOrder.status;

      if (isNil(dcaStatus)) {
        return;
      }

      // Dca order filled, move to DCA status
      if (dcaStatus === 'FILLED') {
        // NotificationUtil.sendMessage(
        //   `symbol ${position.symbol} DCA order filled`
        // );
        ManageFuture.addOrderToOrders(dcaOrder, 'dca');
        position.filledDcaOrders.push(dcaOrder);
        position.dcaPendingCounter = 0;
        position.dcaCount += 1;
        position.avgPrice = ManageFuture.calcAvgPrice(position);
        position.dcaPrice = ManageFuture.calcDcaPrice(position);
        position.dcaPriceFixed = position.dcaPrice;
        position.dcaOrder = null;

        position.cutPrice = ManageFuture.calcCutPrice(position);
        position.cutPriceFixed = position.cutPrice;

        position.status = Statuses.DCA;
      }

      // Dca order is not filled, but price dump (in case long), cancel & create new dca order
      else if (
        position.side === 'LONG' &&
        position.currentPrice <
          position.dcaPriceFixed *
            (1 - stopPriceLimitPriceDistance - stopPricesDistance)
      ) {
        if (dcaStatus !== 'CANCELED') {
          const cancelSuccess = await FutureUtil.cancelOrder(
            position.dcaOrder.orderId,
            position.symbol
          );

          if (!cancelSuccess) {
            return;
          }
        }

        position.dcaPrice *= 1 - position.profitRatio;
        position.dcaPriceFixed *= 1 - stopPricesDistance;

        position.dcaPendingCounter += 1;
        NotificationUtil.sendMessage(
          position.symbol + ': ' + position.dcaPendingCounter
        );
        position.dcaOrder = await ManageFuture.createStopOrder(
          position.symbol,
          position.dcaType,
          ManageFuture.calcDcaQty(position),
          round(position.dcaPrice, position.pricePrecision),
          false
        );

        // NotificationUtil.sendMessage(
        //   `${position.symbol} cancel and create new DCA`
        // );
      }

      // Dca order is not filled, but price pump (in case short), cancel & create new dca order
      else if (
        position.side === 'SHORT' &&
        position.currentPrice >
          position.dcaPriceFixed *
            (1 + stopPriceLimitPriceDistance + stopPricesDistance)
      ) {
        if (dcaStatus !== 'CANCELED') {
          const cancelSuccess = await FutureUtil.cancelOrder(
            position.dcaOrder.orderId,
            position.symbol
          );

          if (!cancelSuccess) {
            return;
          }
        }

        position.dcaPrice *= 1 + position.profitRatio;
        position.dcaPriceFixed *= 1 + stopPricesDistance;

        position.dcaPendingCounter += 1;
        position.dcaOrder = await ManageFuture.createStopOrder(
          position.symbol,
          position.dcaType,
          ManageFuture.calcDcaQty(position),
          round(position.dcaPrice, position.pricePrecision),
          false
        );

        // NotificationUtil.sendMessage(
        //   `${position.symbol} cancel and create new DCA`
        // );
      }
    }

    // else if (!position.dcaPrice) {
    //   position.dcaPrice = position.currentPrice * 95 / 100
    // }

    // Create DCA for LONG position
    else if (
      position.side === 'LONG' &&
      position.currentPrice <
        position.dcaPrice * (1 - stopPriceLimitPriceDistance)
    ) {
      // NotificationUtil.sendMessage(
      //   `symbol ${position.symbol} create DCA order`
      // );

      position.dcaOrder = await ManageFuture.createStopOrder(
        position.symbol,
        'BUY',
        ManageFuture.calcDcaQty(position),
        round(position.dcaPrice, position.pricePrecision),
        false
      );
    }

    // Create DCA for SHORT position
    else if (
      position.side === 'SHORT' &&
      position.currentPrice >
        position.dcaPrice * (1 + stopPriceLimitPriceDistance)
    ) {
      // NotificationUtil.sendMessage(
      //   `symbol ${position.symbol} create DCA order`
      // );

      position.dcaOrder = await ManageFuture.createStopOrder(
        position.symbol,
        'SELL',
        ManageFuture.calcDcaQty(position),
        round(position.dcaPrice, position.pricePrecision),
        false
      );
    }
  }

  static async manageCutOrderWhenNotHaveOrder(position) {
    // Create cut order when price go up above cut price and side is LONG
    if (
      position.side === 'LONG' &&
      position.currentPrice >
        position.cutPrice * (1 + stopPriceLimitPriceDistance)
    ) {
      // NotificationUtil.sendMessage(
      //   `Symbol ${position.symbol} create CUT order ---`
      // );

      position.cutOrder = await ManageFuture.createStopOrder(
        position.symbol,
        'SELL',
        ManageFuture.calcCutQty(position),
        round(position.cutPrice, position.pricePrecision),
        false
      );
    }

    // Create cut order when price go down under cut price and side is SHORT
    else if (
      position.side === 'SHORT' &&
      position.currentPrice <
        position.cutPrice * (1 - stopPriceLimitPriceDistance)
    ) {
      // NotificationUtil.sendMessage(
      //   `Symbol ${position.symbol} create CUT order ---`
      // );

      position.cutOrder = await ManageFuture.createStopOrder(
        position.symbol,
        'BUY',
        ManageFuture.calcCutQty(position),
        round(position.cutPrice, position.pricePrecision),
        false
      );
    }
  }

  static async manageCutOrderWhenCutOrderFilled(position, cutOrder) {
    // NotificationUtil.sendMessage(`Symbol ${position.symbol} CUT order filled`);
    ManageFuture.addOrderToOrders(cutOrder, 'cut');
    position.cutPendingCounter = 0;
    position.filledCutOrders.push(cutOrder);
    position.cutOrder = null;
    position.cutMinusDca += 1;
    position.avgPrice = ManageFuture.calcAvgPrice(position);

    position.cutPrice = ManageFuture.calcCutPrice(position);
    position.cutPriceFixed = position.cutPrice;
    position.childDcaPrice = ManageFuture.calcChildDcaPrice(position);
    position.childDcaPriceFixed = position.childDcaPrice;
  }

  static async manageCutOrderWhenCutOrderNotFilled(position, cutOrder) {
    if (
      position.side === 'LONG' &&
      position.currentPrice >
        position.cutPriceFixed *
          (1 + stopPriceLimitPriceDistance + stopPricesDistance)
    ) {
      // NotificationUtil.sendMessage(
      //   `Symbol ${position.symbol} update CUT order xxx`
      // );

      if (cutOrder.status !== 'CANCELED') {
        const cancelSuccess = await FutureUtil.cancelOrder(
          position.cutOrder.orderId,
          position.symbol
        );

        if (!cancelSuccess) {
          console.log(position.symbol);
          return;
        }
      }

      position.cutPrice = round(
        position.cutPrice * (1 + position.profitRatio),
        position.pricePrecision
      );
      position.cutPriceFixed = round(
        position.cutPriceFixed * (1 + stopPricesDistance),
        position.pricePrecision
      );

      position.cutPendingCounter += 1;
      position.cutOrder = await ManageFuture.createStopOrder(
        position.symbol,
        'SELL',
        ManageFuture.calcCutQty(position),
        round(position.cutPrice, position.pricePrecision),
        false
      );
    } else if (
      position.side === 'SHORT' &&
      position.currentPrice <
        position.cutPriceFixed *
          (1 - stopPriceLimitPriceDistance - stopPricesDistance)
    ) {
      if (cutOrder.status !== 'CANCELED') {
        const cancelSuccess = await FutureUtil.cancelOrder(
          position.cutOrder.orderId,
          position.symbol
        );

        if (!cancelSuccess) {
          return;
        }
      }

      position.cutPrice = round(
        position.cutPrice * (1 - position.profitRatio),
        position.pricePrecision
      );
      position.cutPriceFixed = round(
        position.cutPriceFixed * (1 - stopPricesDistance),
        position.pricePrecision
      );

      position.cutPendingCounter += 1;
      position.cutOrder = await ManageFuture.createStopOrder(
        position.symbol,
        'BUY',
        ManageFuture.calcCutQty(position),
        round(position.cutPrice, position.pricePrecision),
        false
      );
    }
  }

  static async manageCutOrder(position) {
    if (!position.cutOrder) {
      await ManageFuture.manageCutOrderWhenNotHaveOrder(position);
    } else {
      const cutOrder = await FutureUtil.getOrder(
        position.symbol,
        position.cutOrder.orderId
      );

      const cutStatus = cutOrder.status;

      if (isNil(cutStatus)) {
        return;
      }

      if (cutStatus === 'FILLED') {
        await ManageFuture.manageCutOrderWhenCutOrderFilled(position, cutOrder);
      } else {
        await ManageFuture.manageCutOrderWhenCutOrderNotFilled(
          position,
          cutOrder
        );
      }
    }
  }

  static async manageChildDcaOrderWhenNotHaveOrder(position) {
    if (
      position.side === 'LONG' &&
      position.currentPrice <
        position.childDcaPrice * (1 - stopPriceLimitPriceDistance)
    ) {
      // NotificationUtil.sendMessage(
      //   `Symbol ${position.symbol} create child DCA order ---`
      // );

      position.childDcaOrder = await ManageFuture.createStopOrder(
        position.symbol,
        'BUY',
        ManageFuture.calcChildDcaQty(position),
        round(position.childDcaPrice, position.pricePrecision),
        false
      );
    } else if (
      position.side === 'SHORT' &&
      position.currentPrice >
        position.childDcaPrice * (1 + stopPriceLimitPriceDistance)
    ) {
      // NotificationUtil.sendMessage(
      //   `Symbol ${position.symbol} create child DCA order ---`
      // );

      position.childDcaOrder = await ManageFuture.createStopOrder(
        position.symbol,
        'SELL',
        ManageFuture.calcChildDcaQty(position),
        round(position.childDcaPrice, position.pricePrecision),
        false
      );
    }
  }

  static async manageChildDcaOrderWhenChildDcaOrderFilled(
    position,
    childDcaOrder
  ) {
    // NotificationUtil.sendMessage(
    //   `Symbol ${position.symbol} child DCA order filled ---`
    // );
    ManageFuture.addOrderToOrders(childDcaOrder, 'childDca');
    position.childDcaPendingCounter = 0;
    position.filledChildDcaOrders.push(childDcaOrder);
    position.childDcaOrder = null;
    position.cutMinusDca -= 1;
    position.avgPrice = ManageFuture.calcAvgPrice(position);

    position.cutPrice = ManageFuture.calcCutPrice(position);
    position.cutPriceFixed = position.cutPrice;
    position.childDcaPrice = ManageFuture.calcChildDcaPrice(position);
    position.childDcaPriceFixed = position.childDcaPrice;
  }

  static async manageChildDcaOrderWhenChildDcaOrderNotFilled(
    position,
    childDcaOrder
  ) {
    if (
      position.side === 'LONG' &&
      position.currentPrice <
        position.childDcaPriceFixed *
          (1 - stopPriceLimitPriceDistance - stopPricesDistance)
    ) {
      // NotificationUtil.sendMessage(
      //   `Symbol ${position.symbol} update child DCA order ---`
      // );

      if (childDcaOrder.status !== 'CANCELED') {
        const cancelSuccess = await FutureUtil.cancelOrder(
          position.childDcaOrder.orderId,
          position.symbol
        );

        if (!cancelSuccess) {
          console.log(position.symbol);

          return;
        }
      }

      position.childDcaPrice = round(
        position.childDcaPrice * (1 - position.profitRatio),
        position.pricePrecision
      );
      position.childDcaPriceFixed = round(
        position.childDcaPriceFixed * (1 - stopPricesDistance),
        position.pricePrecision
      );

      position.childDcaPendingCounter += 1;
      position.childDcaOrder = await ManageFuture.createStopOrder(
        position.symbol,
        'BUY',
        ManageFuture.calcChildDcaQty(position),
        round(position.childDcaPrice, position.pricePrecision),
        false
      );
    } else if (
      position.side === 'SHORT' &&
      position.currentPrice >
        position.childDcaPriceFixed *
          (1 + stopPriceLimitPriceDistance + stopPricesDistance)
    ) {
      // NotificationUtil.sendMessage(
      //   `Symbol ${position.symbol} update child DCA order ---`
      // );

      if (childDcaOrder.status !== 'CANCELED') {
        const cancelSuccess = await FutureUtil.cancelOrder(
          position.childDcaOrder.orderId,
          position.symbol
        );

        if (!cancelSuccess) {
          return;
        }
      }

      position.childDcaPrice = round(
        position.childDcaPrice * (1 + position.profitRatio),
        position.pricePrecision
      );
      position.childDcaPriceFixed = round(
        position.childDcaPriceFixed * (1 + stopPricesDistance),
        position.pricePrecision
      );

      position.childDcaPendingCounter += 1;
      position.childDcaOrder = await ManageFuture.createStopOrder(
        position.symbol,
        'BUY',
        ManageFuture.calcChildDcaQty(position),
        round(position.childDcaPrice, position.pricePrecision),
        false
      );
    }
  }

  static async manageChildDcaOrder(position) {
    if (!position.childDcaOrder && position.cutMinusDca > 0) {
      await ManageFuture.manageChildDcaOrderWhenNotHaveOrder(position);
    } else if (position.childDcaOrder) {
      const childDcaOrder = await FutureUtil.getOrder(
        position.symbol,
        position.childDcaOrder.orderId
      );

      const childDcaStatus = childDcaOrder.status;
      if (isNil(childDcaStatus)) {
        return position;
      }

      if (childDcaStatus === 'FILLED') {
        await this.manageChildDcaOrderWhenChildDcaOrderFilled(
          position,
          childDcaOrder
        );
      } else {
        await this.manageChildDcaOrderWhenChildDcaOrderNotFilled(
          position,
          childDcaOrder
        );
      }
    }
  }

  static async manageEntry(position) {
    // Check if go to PROFIT
    if (ManageFuture.upToProfit(position)) {
      // await NotificationUtil.sendMessage(
      //   `Symbol ${position.symbol} from start to profit, current price ${position.currentPrice}`
      // );

      position.slPrice =
        position.side === 'LONG'
          ? round(position.avgPrice * (1 + minProfit), position.pricePrecision)
          : round(position.avgPrice * (1 - minProfit), position.pricePrecision);
      position.maxPrice = position.currentPrice;
      position.status = Statuses.PROFIT;

      return;
    }

    ManageFuture.manageDcaOrder(position);
  }

  static async manageProfit(position): Promise<Boolean> {
    // Update max & SL price if price go up (for long) or down (for short)
    if (
      position.side === 'LONG' &&
      position.currentPrice >
        position.maxPrice * (1 + stopPriceLimitPriceDistance)
    ) {
      position.maxPrice = position.currentPrice;
      position.slPrice = position.slPrice * (1 + position.profitRatio);
    } else if (
      position.side === 'SHORT' &&
      position.currentPrice <
        position.maxPrice * (1 - stopPriceLimitPriceDistance)
    ) {
      position.maxPrice = position.currentPrice;
      position.slPrice = position.slPrice * (1 - position.profitRatio);
    }

    // Close position if SL hit

    if (position.side == 'LONG' && position.slPrice > position.currentPrice) {
      const profitOrder = await FutureUtil.createMarketOrder(
        position.symbol,
        'SELL',
        round(+position.position.positionAmt, position.quantityPrecision)
      );
      position.profitOrder = profitOrder;
      const profit = await ManageFuture.calcProfit(position);
      ManageFuture.addOrderToOrders(profitOrder, 'profit', profit);
      // NotificationUtil.sendMessage(JSON.stringify(position));

      return true;
    }

    if (position.side == 'SHORT' && position.slPrice < position.currentPrice) {
      const profitOrder = await FutureUtil.createMarketOrder(
        position.symbol,
        'BUY',
        round(-position.position.positionAmt, position.quantityPrecision)
      );
      position.profitOrder = profitOrder;
      const profit = await ManageFuture.calcProfit(position);
      ManageFuture.addOrderToOrders(profitOrder, 'profit', profit);
      // NotificationUtil.sendMessage(JSON.stringify(position));

      return true;
    }

    return false;
  }

  static async manageDca(position) {
    if (ManageFuture.upToProfit(position)) {
      // await NotificationUtil.sendMessage(
      //   `Symbol ${position.symbol} from dca to profit, current price ${position.currentPrice}, avg price ${position.avgPrice}`
      // );

      position.maxPrice = position.currentPrice;
      position.slPrice =
        position.side === 'LONG'
          ? round(
              position.avgPrice * (1 + minProfitAfterDca),
              position.pricePrecision
            )
          : round(
              position.avgPrice * (1 - minProfitAfterDca),
              position.pricePrecision
            );
      position.status = Statuses.PROFIT;

      return;
    }

    ManageFuture.manageDcaOrder(position);
    ManageFuture.manageCutOrder(position);
    ManageFuture.manageChildDcaOrder(position);
  }

  static async snap() {
    await pool.query(
      `UPDATE snap SET "longPositions" = '${JSON.stringify(
        ManageFuture.positions
      )}'`
    );
  }

  static async snapOrders() {
    if (ManageFuture.hasPendingSnapOrders) {
      ManageFuture.hasPendingSnapOrders = false;

      if (ManageFuture.orders.length > 1000) {
        ManageFuture.orders = takeRight(ManageFuture.orders, 1000);
      }

      await pool.query(
        `UPDATE snap SET "orders" = '${JSON.stringify(ManageFuture.orders)}'`
      );
    }
  }

  static async getSnapshot() {
    const { rows } = await pool.query('SELECT * FROM snap LIMIT 1');

    return { positions: rows?.[0]?.longPositions, orders: rows?.[0]?.orders };
  }

  static calcDcaQty(position) {
    let dcaBudget;
    if (position.dcaCount < position.dcaBudgets.length) {
      dcaBudget = position.dcaBudgets[position.dcaCount];
    } else {
      dcaBudget = position.dcaBudgets[position.dcaBudgets.length - 1];
    }

    dcaBudget += min([
      position.dcaPendingCounter * increaseVolParam,
      ManageFuture.config.dcaBudgets[0],
    ]);

    return ManageFuture.calcBestQty(
      dcaBudget / position.currentPrice,
      position.quantityPrecision,
      position.currentPrice
    );
  }

  static calcCutQty(position) {
    let cutBudget = position.dcaBudgets[0];

    cutBudget += position.cutPendingCounter * increaseVolParam;

    return ManageFuture.calcBestQty(
      cutBudget / position.currentPrice,
      position.quantityPrecision,
      position.currentPrice
    );
  }

  static calcChildDcaQty(position) {
    let childDcaBudget = position.dcaBudgets[0];

    childDcaBudget += position.childDcaPendingCounter * increaseVolParam;

    return ManageFuture.calcBestQty(
      childDcaBudget / position.currentPrice,
      position.quantityPrecision,
      position.currentPrice
    );
  }

  static calcBestQty(qty: number, qtyPrecision: number, price: number) {
    const nearestQty = round(qty, qtyPrecision);

    if (nearestQty * price < 6) {
      return ceil(qty, qtyPrecision);
    }

    return nearestQty;
  }

  static calcDcaPrice(position) {
    let dcaPercentage;

    if (position.dcaCount < ManageFuture.config.dcaPercentages.length) {
      dcaPercentage = ManageFuture.config.dcaPercentages[position.dcaCount];
    } else {
      dcaPercentage =
        ManageFuture.config.dcaPercentages[
          ManageFuture.config.dcaPercentages.length - 1
        ];
    }

    return position.side === 'LONG'
      ? round(
          position.currentPrice * (1 - dcaPercentage),
          position.pricePrecision
        )
      : round(
          position.currentPrice * (1 + dcaPercentage),
          position.pricePrecision
        );
  }

  static calcCutPrice(position) {
    let numCutBaseOnDca = 0;
    switch (position.filledDcaOrders.length) {
      case 0:
        numCutBaseOnDca = 0;
        break;
      case 1:
        numCutBaseOnDca = 0;
        break;
      case 2:
        numCutBaseOnDca = 1;
        break;
      case 3:
        numCutBaseOnDca = 2;
        break;
      case 4:
        numCutBaseOnDca = 2;
        break;
      case 5:
        numCutBaseOnDca = 3;
        break;
      case 6:
        numCutBaseOnDca = 4;
        break;
      case 7:
        numCutBaseOnDca = 4;
        break;
      case 8:
        numCutBaseOnDca = 5;
        break;
      case 9:
        numCutBaseOnDca = 6;
        break;
      case 10:
        numCutBaseOnDca = 6;
        break;
    }

    const numCut =
      numCutBaseOnDca +
      position.filledChildDcaOrders.length -
      position.filledCutOrders.length;

    if (numCut <= 0) {
      return;
    }

    let cutPrice;

    if (position.side === 'LONG') {
      cutPrice = round(
        (position.avgPrice * (1 + minProfitAfterDca) - position.currentPrice) /
          (numCut + 1) +
          position.currentPrice,
        position.pricePrecision
      );
    } else {
      cutPrice = round(
        (position.currentPrice - position.avgPrice * (1 - minProfitAfterDca)) /
          (numCut + 1) +
          position.avgPrice,
        position.pricePrecision
      );
    }

    return cutPrice;
  }

  static calcChildDcaPrice(position) {
    const numChildDca =
      position.filledCutOrders.length - position.filledChildDcaOrders.length;

    if (numChildDca <= 0) {
      return;
    }

    if (position.side === 'LONG') {
      const priceStep =
        (position.currentPrice - position.dcaPrice) / (numChildDca + 1);
      return round(position.currentPrice - priceStep, position.pricePrecision);
    }

    const priceStep =
      (position.dcaPrice - position.currentPrice) / (numChildDca + 1);
    return round(position.currentPrice + priceStep, position.pricePrecision);
  }

  static async createStopOrder(symbol, side, qty, stopPrice, closePosition) {
    try {
      const stopOrder = await FutureUtil.createStopOrder(
        symbol,
        side,
        qty,
        stopPrice,
        closePosition
      );
      return stopOrder;
    } catch (err) {
      if (err?.response?.data?.code === -2021) {
        const marketOrder = await FutureUtil.createMarketOrder(
          symbol,
          side,
          qty
        );
        return marketOrder;
      }
    }
  }

  static calcAvgPrice(position) {
    if (position.side === 'LONG') {
      //   return +pos.entryPrice;
      let buyBudget = position.entryPrice * position.entryQty;
      let buyQty = position.entryQty;

      for (const dcaOrder of position.filledDcaOrders) {
        buyBudget +=
          (+dcaOrder.price || +dcaOrder.avgPrice || +dcaOrder.stopPrice) *
          +dcaOrder.origQty;
        buyQty += +dcaOrder.origQty;
      }

      for (const dcaOrder of position.filledChildDcaOrders) {
        buyBudget +=
          (+dcaOrder.price || +dcaOrder.avgPrice || +dcaOrder.stopPrice) *
          +dcaOrder.origQty;
        buyQty += +dcaOrder.origQty;
      }

      let sellBudget = 0;
      let sellQty = 0;
      for (const cutOrder of position.filledCutOrders) {
        sellBudget +=
          (+cutOrder.price || +cutOrder.avgPrice || +cutOrder.stopPrice) *
          +cutOrder.origQty;
        sellQty += +cutOrder.origQty;
      }

      const buyAvgPrice = buyBudget / buyQty;

      if (sellQty > 0) {
        const sellAvgPrice = sellBudget / sellQty;

        if (sellAvgPrice < buyAvgPrice) {
          const lostProfit = (buyAvgPrice - sellAvgPrice) * sellQty;

          return round(
            buyAvgPrice + lostProfit / (buyQty - sellQty),
            position.pricePrecision
          );
        }

        if (buyAvgPrice < sellAvgPrice) {
          const gotProfit = (sellAvgPrice - buyAvgPrice) * sellQty;

          return round(
            buyAvgPrice - gotProfit / (buyQty - sellQty),
            position.pricePrecision
          );
        }

        return round(buyAvgPrice, position.pricePrecision);
      }

      return round(buyAvgPrice, position.pricePrecision);
    } else {
      //   return +pos.entryPrice;
      let sellBudget = position.entryPrice * position.entryQty;
      let sellQty = position.entryQty;

      for (const dcaOrder of position.filledDcaOrders) {
        sellBudget +=
          (+dcaOrder.price || +dcaOrder.avgPrice || +dcaOrder.stopPrice) *
          +dcaOrder.origQty;
        sellQty += +dcaOrder.origQty;
      }

      for (const dcaOrder of position.filledChildDcaOrders) {
        sellBudget +=
          (+dcaOrder.price || +dcaOrder.avgPrice || +dcaOrder.stopPrice) *
          +dcaOrder.origQty;
        sellQty += +dcaOrder.origQty;
      }

      let buyBudget = 0;
      let buyQty = 0;

      for (const cutOrder of position.filledCutOrders) {
        buyBudget +=
          (+cutOrder.price || +cutOrder.avgPrice || +cutOrder.stopPrice) *
          +cutOrder.origQty;
        buyQty += +cutOrder.origQty;
      }

      const sellAvgPrice = sellBudget / sellQty;

      if (buyQty > 0) {
        const buyAvgPrice = buyBudget / buyQty;

        if (buyAvgPrice < sellAvgPrice) {
          const gotProfit = (sellAvgPrice - buyAvgPrice) * buyQty;

          return round(
            sellAvgPrice + gotProfit / (sellQty - buyQty),
            position.pricePrecision
          );
        }

        if (buyAvgPrice > sellAvgPrice) {
          const lostProfit = (buyAvgPrice - sellAvgPrice) * buyQty;

          return round(
            sellAvgPrice - lostProfit / (sellQty - buyQty),
            position.pricePrecision
          );
        }

        return round(sellAvgPrice, position.pricePrecision);
      }

      return round(sellAvgPrice, position.pricePrecision);
    }
  }

  static async calcProfit(position) {
    if (position.side === 'LONG') {
      let buyBudget = position.entryPrice * position.entryQty;

      for (const dcaOrder of position.filledDcaOrders) {
        buyBudget +=
          (+dcaOrder.price || +dcaOrder.avgPrice || +dcaOrder.stopPrice) *
          +dcaOrder.origQty;
      }

      for (const dcaOrder of position.filledChildDcaOrders) {
        buyBudget +=
          (+dcaOrder.price || +dcaOrder.avgPrice || +dcaOrder.stopPrice) *
          +dcaOrder.origQty;
      }

      let sellBudget = 0;
      for (const cutOrder of position.filledCutOrders) {
        sellBudget +=
          (+cutOrder.price || +cutOrder.avgPrice || +cutOrder.stopPrice) *
          +cutOrder.origQty;
      }

      sellBudget +=
        (+position.profitOrder.price ||
          +position.profitOrder.avgPrice ||
          +position.profitOrder.stopPrice) * +position.profitOrder.origQty;

      return sellBudget - buyBudget;
    }

    let sellBudget = position.entryPrice * position.entryQty;

    for (const dcaOrder of position.filledDcaOrders) {
      sellBudget +=
        (+dcaOrder.price || +dcaOrder.avgPrice || +dcaOrder.stopPrice) *
        +dcaOrder.origQty;
    }

    for (const dcaOrder of position.filledChildDcaOrders) {
      sellBudget +=
        (+dcaOrder.price || +dcaOrder.avgPrice || +dcaOrder.stopPrice) *
        +dcaOrder.origQty;
    }

    let buyBudget = 0;
    for (const cutOrder of position.filledCutOrders) {
      buyBudget +=
        (+cutOrder.price || +cutOrder.avgPrice || +cutOrder.stopPrice) *
        +cutOrder.origQty;
    }

    buyBudget +=
      (+position.profitOrder.price ||
        +position.profitOrder.avgPrice ||
        +position.profitOrder.stopPrice) * +position.profitOrder.origQty;

    return sellBudget - buyBudget;
  }

  static upToProfit(position) {
    const orderMinProfit = isEmpty(position.filledDcaOrders)
      ? minProfit
      : minProfitAfterDca;

    const longStopPrice = round(
      position.avgPrice * (1 + orderMinProfit + stopPriceLimitPriceDistance),
      position.pricePrecision
    );
    if (position.side === 'LONG') {
      position.profitStopPrice = longStopPrice;
    }

    const shortStopPrice = round(
      position.avgPrice * (1 - orderMinProfit - stopPriceLimitPriceDistance),
      position.pricePrecision
    );
    if (position.side === 'SHORT') {
      position.profitStopPrice = shortStopPrice;
    }

    return (
      (position.side === 'LONG' && position.currentPrice > longStopPrice) ||
      (position.side === 'SHORT' && position.currentPrice < shortStopPrice)
    );
  }

  static async addPos() {
    let numOfRiskyLongPos = filter(
      ManageFuture.positions,
      ({ slPrice, side }) => isNil(slPrice) && side === 'LONG'
    ).length;

    let numOfRiskyShortPos = filter(
      ManageFuture.positions,
      ({ slPrice, side }) => isNil(slPrice) && side === 'SHORT'
    ).length;

    let availPos;

    let priceChanges = await FutureUtil.getPriceChange();
    ManageFuture.priceChanges = take(
      reverse(
        sortBy(
          filter(
            priceChanges,
            (t) =>
              !ManageFuture.positions.some((p) => p && p.symbol === t.symbol)
          ),
          (t) => +t.priceChangePercent
        )
      ),
      10
    ).concat(
      take(
        sortBy(
          filter(
            priceChanges,
            (t) =>
              !ManageFuture.positions.some((p) => p && p.symbol === t.symbol)
          ),
          (t) => +t.priceChangePercent
        ),
        10
      )
    );

    if (
      numOfRiskyLongPos < ManageFuture.config.longNumPos ||
      numOfRiskyShortPos < ManageFuture.config.shortNumPos ||
      isEmpty(ManageFuture.priceChanges)
    ) {
      priceChanges = filter(priceChanges, (c) => !/BUSD/.test(c.symbol));

      availPos = filter(
        priceChanges,
        (t) =>
          !ManageFuture.positions.some((p) => p && p.symbol === t.symbol) &&
          // !unusedSymbols.includes(t.symbol) &&
          // usedSymbols.includes(t.symbol) &&
          // +t.priceChangePercent < 5 &&
          !/BTCBUSD/.test(t.symbol) &&
          !/BTCUSDT/.test(t.symbol) &&
          !/BTCDOMUSDT/.test(t.symbol) &&
          !/ETHUSDT/.test(t.symbol) &&
          !/BUSD/.test(t.symbol)
      );
    }

    const availLongPos = sortBy(
      filter(availPos, (p) => +p.priceChangePercent < -10),
      (item) => +item.priceChangePercent
    );

    while (
      availLongPos.length > 0 &&
      numOfRiskyLongPos < ManageFuture.config.longNumPos
    ) {
      const pos = availLongPos.shift();
      if (isNil(pos)) {
        break;
      }

      const { symbol } = pos;

      try {
        const buyQty = await ManageFuture.calcEntryQty(symbol);

        ManageFuture.addOrderToOrders(
          await FutureUtil.createMarketOrder(symbol, 'BUY', buyQty),
          'entry'
        );
        numOfRiskyLongPos += 1;
      } catch (err) {
        continue;
      }
    }

    const availShortPos = orderBy(
      filter(availPos, (p) => +p.priceChangePercent > 10),
      (item) => +item.priceChangePercent,
      'desc'
    );

    while (
      availShortPos.length > 0 &&
      numOfRiskyShortPos < ManageFuture.config.shortNumPos
    ) {
      const { symbol } = availShortPos.shift();

      try {
        const sellQty = await ManageFuture.calcEntryQty(symbol);

        ManageFuture.addOrderToOrders(
          await FutureUtil.createMarketOrder(symbol, 'SELL', sellQty),
          'entry'
        );
        numOfRiskyShortPos += 1;
      } catch (err) {
        continue;
      }
    }
  }

  static async calcEntryQty(symbol: string) {
    const currentPrice = await FutureUtil.getPrice(symbol);

    const realQty = ManageFuture.calcBestQty(
      ManageFuture.config.baseBudget / currentPrice,
      precisions[symbol].quantityPrecision,
      currentPrice
    );

    if (
      realQty * currentPrice >
      ManageFuture.config.baseBudget + maxEntryBudgetDiffAllow
    ) {
      throw new Error();
    }

    return realQty;
  }

  static msToTime(duration) {
    let hours = round(duration / 1000 / 60 / 60);
    let days = 0;

    if (hours > 24) {
      days = floor(hours / 24);
      hours = hours % 24;
    }

    return `${days}d ${hours}h`;
  }

  static addOrderToOrders(order, type, profit?) {
    const orderPrice = ManageFuture.getOrderPrice(order);
    let change = undefined;

    if (type !== 'entry') {
      const latestOrder = findLast(
        ManageFuture.orders,
        (o) => o.order.symbol === order.symbol
      );

      if (latestOrder) {
        const latestOrderPrice = ManageFuture.getOrderPrice(latestOrder.order);
        if (isFinite(latestOrderPrice) && latestOrderPrice > 0) {
          change = round((orderPrice / latestOrderPrice - 1) * 100, 1);
        }
      }
    }

    ManageFuture.orders.push({
      type,
      order,
      change,
      profit,
    });
    ManageFuture.hasPendingSnapOrders = true;
  }

  static updateStop(position) {
    let cutStopPrice = null;
    let dcaStopPrice = null;
    let childDcaStopPrice = null;

    if (position.side === 'LONG') {
      if (position.cutPrice) {
        cutStopPrice = round(
          position.cutPrice * (1 + stopPriceLimitPriceDistance),
          position.pricePrecision
        );
      }

      if (position.dcaPrice) {
        dcaStopPrice = round(
          position.dcaPrice * (1 - stopPriceLimitPriceDistance),
          position.pricePrecision
        );
      }

      if (position.childDcaPrice) {
        childDcaStopPrice = round(
          position.childDcaPrice * (1 - stopPriceLimitPriceDistance),
          position.pricePrecision
        );
      }
    } else if (position.side === 'SHORT') {
      if (position.cutPrice) {
        cutStopPrice = round(
          position.cutPrice * (1 - stopPriceLimitPriceDistance),
          position.pricePrecision
        );
      }

      if (position.dcaPrice) {
        dcaStopPrice = round(
          position.dcaPrice * (1 + stopPriceLimitPriceDistance),
          position.pricePrecision
        );
      }

      if (position.childDcaPrice) {
        childDcaStopPrice = round(
          position.childDcaPrice * (1 + stopPriceLimitPriceDistance),
          position.pricePrecision
        );
      }
    }

    position.cutStopPrice = cutStopPrice;
    position.dcaStopPrice = dcaStopPrice;
    position.childDcaStopPrice = childDcaStopPrice;
  }

  static getOrderPrice(order) {
    if (!order) {
      return null;
    }

    if (+order.avgPrice > 0) {
      return +order.avgPrice;
    }

    return +order.stopPrice;
  }

  static updatePositionUpDownDistance(position) {
    let lowPrice;
    let highPrice;

    if (position.side === 'LONG') {
      lowPrice = position.dcaPrice;

      if (position.childDcaPrice && position.childDcaPrice > lowPrice) {
        lowPrice = position.childDcaPrice;
      }

      lowPrice = lowPrice * (1 - stopPriceLimitPriceDistance);

      const orderMinProfit = isEmpty(position.filledDcaOrders)
        ? minProfit
        : minProfitAfterDca;

      highPrice = round(
        position.avgPrice * (1 + orderMinProfit + stopPriceLimitPriceDistance),
        position.pricePrecision
      );

      if (
        position.cutPrice &&
        position.cutPrice * (1 + stopPriceLimitPriceDistance) < highPrice
      ) {
        highPrice = position.cutPrice * (1 + stopPriceLimitPriceDistance);
      }
    } else if (position.side === 'SHORT') {
      highPrice = position.dcaPrice;

      if (position.childDcaPrice && position.childDcaPrice < highPrice) {
        highPrice = position.childDcaPrice;
      }

      highPrice = highPrice * (1 + stopPriceLimitPriceDistance);

      const orderMinProfit = isEmpty(position.filledDcaOrders)
        ? minProfit
        : minProfitAfterDca;

      lowPrice = round(
        position.avgPrice * (1 - orderMinProfit - stopPriceLimitPriceDistance),
        position.pricePrecision
      );

      if (
        position.cutPrice &&
        position.cutPrice * (1 - stopPriceLimitPriceDistance) > lowPrice
      ) {
        lowPrice = position.cutPrice * (1 - stopPriceLimitPriceDistance);
      }
    }

    position.toLow = round((position.currentPrice / lowPrice - 1) * 100, 1);

    position.toHigh = round((1 - position.currentPrice / highPrice) * 100, 1);
  }

  static async long(symbol) {
    const buyQty = await ManageFuture.calcEntryQty(symbol);

    ManageFuture.addOrderToOrders(
      await FutureUtil.createMarketOrder(symbol, 'BUY', buyQty),
      'entry'
    );
  }

  static async short(symbol) {
    const sellQty = await ManageFuture.calcEntryQty(symbol);

    ManageFuture.addOrderToOrders(
      await FutureUtil.createMarketOrder(symbol, 'SELL', sellQty),
      'entry'
    );
  }

  static async updateCurrentPrices() {
    const priceChanges = await FutureUtil.getPriceChange();

    for (const priceChange of priceChanges) {
      ManageFuture.updateCurrentPrice(priceChange.symbol);
    }
  }

  static updateCurrentPrice(symbol) {
    const ws = new WebSocket(
      `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@markPrice@1s`
    );

    ws.isAlive = true;

    ws.on('message', async function incoming(data) {
      now = Date.now();

      try {
        const price = +JSON.parse(data).p;

        currentPrices[symbol] = price;
      } catch (err) {}
    });

    ws.on('error', () => {
      ManageFuture.updateCurrentPrice(symbol);
    });

    ws.on('close', () => {
      ManageFuture.updateCurrentPrice(symbol);
    });

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    setInterval(() => {
      if (!ws.isAlive) {
        ManageFuture.updateCurrentPrice(symbol);
      }

      ws.isAlive = false;
      ws.ping();
    }, 30000);
  }
}

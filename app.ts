if (process.env.NODE_ENV === 'development') {
  require('dotenv').config();
}

import cors from 'cors';
import express from 'express';
import bodyParser from 'body-parser';

import Bot from './src/bot';

import { FutureUtil } from './src/future-util';
import { NotificationUtil } from './src/notification-util';
import { Manage98 } from './src/manage-98';
import { ManageFuture } from './src/manage-future';
import { some } from 'lodash';

import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({
  port: 8000,
  // perMessageDeflate: {
  //   zlibDeflateOptions: {
  //     // See zlib defaults.
  //     chunkSize: 1024,
  //     memLevel: 7,
  //     level: 3
  //   },
  //   zlibInflateOptions: {
  //     chunkSize: 10 * 1024
  //   },
  //   // Other options settable:
  //   clientNoContextTakeover: true, // Defaults to negotiated value.
  //   serverNoContextTakeover: true, // Defaults to negotiated value.
  //   serverMaxWindowBits: 10, // Defaults to negotiated value.
  //   // Below options specified as default values.
  //   concurrencyLimit: 10, // Limits zlib concurrency for perf.
  //   threshold: 1024 // Size (in bytes) below which messages
  //   // should not be compressed if context takeover is disabled.
  // }
});

wss.on('connection', function connection(ws, req) {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  setInterval(() => {
    if (!ws.isAlive) {
      ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  }, 10000);

  if (req.url === '/future-positions') {
    setInterval(() => ws.send(JSON.stringify(ManageFuture.positions)), 5000);
  } else if (req.url === '/future-orders') {
    setInterval(() => ws.send(JSON.stringify(ManageFuture.orders)), 5000);
  } else if (req.url === '/future-config') {
    setInterval(() => ws.send(JSON.stringify(ManageFuture.config)), 5000);
  } else if (req.url === '/price-changes') {
    setInterval(() => ws.send(JSON.stringify(ManageFuture.priceChanges)), 5000);
  } else if (req.url === '/assets') {
    setInterval(() => ws.send(JSON.stringify(Manage98.assets)), 5000);
  }
});

var types = require('pg').types;
types.setTypeParser(1700, function (val) {
  return +val;
});

const app = express();
app.use(cors());
app.use(bodyParser.json());
ManageFuture.start();
Manage98.init();

setInterval(async () => {
  const holdNow = Manage98.now();
  const futureNow = ManageFuture.now();

  const current = Date.now();
  if (
    some(
      [futureNow, holdNow],
      (time) => current - time > 5 * 60 * 1000
    )
  ) {
    await NotificationUtil.sendMessage('RESET APP');
    process.exit(1);
  }
}, 60000);

app.get('/', (req, res) => {
  res.status(200).send();
});

app.get('/summary', async (req, res) => {
  res.json(await Manage98.calcSymbolSummary(req.query.pair));
});

app.post('/future/long', async (req, res) => {
  try {
    await ManageFuture.long(req.query.symbol);
    res.status(200).send();
  } catch (err) {
    res.status(500).send();
  }
});

app.post('/future/short', async (req, res) => {
  try {
    await ManageFuture.long(req.query.symbol);
    res.status(200).send();
  } catch (err) {
    res.status(500).send();
  }
});

app.post('/future/manual', async (req, res) => {
  try {
    ManageFuture.toManual = req.query.symbol;
    res.status(200).send();
  } catch (err) {
    res.status(500).send();
  }
});

app.post('/future/sl', async (req, res) => {
  try {
    ManageFuture.sl[req.body.symbol] = req.body.sl;
    res.status(200).send();
  } catch (err) {
    res.status(500).send();
  }
});

app.get('/positions', async (req, res) => {
  res.json(await FutureUtil.getPositions());
});

app.get('/orders', async (req, res) => {
  res.json(await FutureUtil.getAllOrders(req.query.symbol));
});

app.delete('/orders', async (req, res) => {
  await FutureUtil.cancelOrder(req.query.id, req.query.symbol);
  res.status(204).send();
});

app.get('/98', async (req, res) => {
  res.json(Manage98.assets);
});

app.get('/future/positions', async (req, res) => {
  res.json(ManageFuture.positions);
});

app.get('/future/orders', (req, res) => {
  res.json(ManageFuture.orders);
});

app.get('/future/config', async (req, res) => {
  res.json(ManageFuture.config);
});

app.post('/future/config', async (req, res) => {
  await Bot.saveConfig(req.body);
  res.status(200).send();
  process.exit(1);
});

app.get('/future/balance', async (req, res) => {
  res.json(await FutureUtil.getBalance());
});

app.get('/bot/time', (Req, res) => {
  res.json(Bot.now());
});

app.listen(3000, () => console.log(`Example app listening on port ${3000}!`));

import { WebsocketClient, WS_KEY_MAP, AccountAssetClient, SpotClientV3 } from 'bybit-api';
import { LinearClient } from './linear_client.js';
//const { WebsocketClient, WS_KEY_MAP, AccountAssetClient, SpotClientV3} = pkg;
import { WebsocketClient as binanceWS } from 'binance';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import express from 'express';
import path from 'path';
import chalk from 'chalk';
import fs from 'fs';
import { Webhook, MessageBuilder } from 'discord-webhook-node';
import { env } from 'process';
import http from 'http';
import https from 'https';
import WebSocket from 'ws';
import { networkInterfaces } from 'os';
import moment from 'moment';
import * as cron from 'node-cron'
import bodyParser from 'body-parser'
import session from 'express-session';
import { Server } from 'socket.io'
import { newPosition, incrementPosition, closePosition, updatePosition } from './position.js';
import { loadJson, storeJson, traceTrade, dumpLiquidationInfo } from './utils.js';
import { createMarketOrder, createLimitOrder, cancelOrder } from './order.js';
import { logIT, LOG_LEVEL } from './log.js';
import { checkListingDate, getVolatility } from './filters.js'
import { threadId } from 'worker_threads';

dotenv.config();

// Discord report cron tasks
if (process.env.USE_DISCORD == "true") {
    const cronTaskDiscordPositionReport = cron.schedule(process.env.DISCORD_REPORT_INTERVALL, () => {
        logIT("Discord report send!");
        reportWebhook();
    });
}
// Update function
if (process.env.FIRST_START === 'false') {
    updateLastDeploymentDateTime(new Date());
    changeENV('FIRST_START', 'true');
    dotenv.config();
}
// Check for updates
if (process.env.CHECK_FOR_UPDATE === 'true')
  checkForUpdates()

// used to calculate bot runtime
const timestampBotStart = moment();

var hook;
var reporthook;
if (process.env.USE_DISCORD == "true") {
    hook = new Webhook(process.env.DISCORD_URL);
	if (process.env.SPLIT_DISCORD_LOG_AND_REPORT == "true") {
		reporthook = new Webhook(process.env.DISCORD_URL_REPORT);
	}
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const key = process.env.API_KEY;
const secret = process.env.API_SECRET;
const key_webSocket = process.env.USE_TESTNET == "true" ? process.env.API_KEY_WEBSOCKET : process.env.API_KEY;
const secret_webSocket = process.env.USE_TESTNET == "true" ? process.env.API_SECRET_WEBSOCKET : process.env.API_SECRET;
const stopLossCoins = new Map();

// keep tracks of opened positions
var openPositions = undefined;

// tradesStat store metric about current trade
const tradesHistory = new Map();
// globalTradesStats store global metric
const globalStatsPath = "./global_stats.json";
var globalTradesStats = {
  trade_count: 0,
  max_loss : 0,
  losses_count: 0,
  wins_count: 0,
  consecutive_losses :0,
  consecutive_wins :0,
  max_consecutive_losses: 0,
  max_consecutive_wins: 0
};
loadJson(globalStatsPath, globalTradesStats);
const TRACE_TRADES_LEVEL_OFF = "OFF";
const TRACE_TRADES_LEVEL_ON = "ON";
const TRACE_TRADES_LEVEL_MAX = "MAX";
const traceTradeFields = process.env.TRACE_TRADES_FIELDS.replace(/ /g,"").split(",")


var lastReport = 0;
var pairs = [];
var liquidationOrders = [];
var lastUpdate = 0;
var global_balance;
const drawdownThreshold =  process.env.TIMEOUT_BLACKLIST_FOR_BIG_DRAWDOWN == "true" ?  parseFloat(process.env.DRAWDOWN_THRESHOLD) : 0

// queue to sequentially execute scalp method
var tradeOrdersQueue = [];

// set filters to discard some symbol
var filteredPairs = [];

var settings = {}; // a memory copy of settings file
var minOrderSizes = []; // a memory copy of min order size

app.use(bodyParser.urlencoded({ extended: false }));
app.use('/css', express.static('gui/css'));
app.use('/img', express.static('gui/img'));
app.use('/node_modules', express.static('node_modules/socket.io/client-dist'));

app.use(session({
    secret: process.env.GUI_SESSION_PASSWORD,
    resave: false,
    saveUninitialized: true
}));

app.get('/login', (req, res) => {
    res.sendFile('login.html', { root: 'gui' });
});

app.post('/login', (req, res) => {
    const password = req.body.password;
    if (password === process.env.GUI_PASSWORD) {
      req.session.isLoggedIn = true;
      res.redirect('/');
    } else {
      res.status(401).send('Wrong password');
    }
});

app.get('/', isAuthenticated, (req, res) => {
    res.sendFile('index.html', { root: 'gui' });
});

app.get('/settings', isAuthenticated, (req, res) => {
    res.sendFile('settings.html', { root: 'gui' });
});

app.get('/stats', isAuthenticated, (req, res) => {
    res.sendFile('stats.html', { root: 'gui' });
});

const runningStatus_UNDEFINED = 0;
const runningStatus_RUN = 1;
const runningStatus_PAUSE = 2;
const runningStatus_Label = ["Undefined", "Running", "Paused"];
var runningStatus = runningStatus_UNDEFINED
app.get('/runningStatus', getRunningStatus, (req, res) => {
  res.sendFile('index.html', { root: 'gui' });
});


io.on('connection', (socket) => {

	socket.on('setting', (msg) => {
        changeENV(msg.set, msg.val)
    });

    socket.on('sendsettings', (msg) => {
        getSettings()
    });

});

server.listen(PORT, () => {
    const interfaces = networkInterfaces();
    const addresses = [];
    for (const iface of Object.values(interfaces)) {
        for (const addr of iface) {
            if (addr.family === 'IPv4' && !addr.internal) {
                addresses.push(addr.address);
            }
        }
    }
    logIT(`GUI running on http://${addresses[0]}:${PORT}`)
});

//create ws client
const wsClient = new WebsocketClient({
    key: key_webSocket,
    secret: secret_webSocket,
    market: 'v5',
    livenet: true,
});

let wsTestClient = null;
if (process.env.USE_TESTNET == "true") {
    wsTestClient = new WebsocketClient({
    key: key,
    secret: secret,
    market: 'v5',
    livenet: true,
    testnet: true,
    });
}

// TODO: Check testnet
const binanceClient = new binanceWS({
    beautify: true,
});
//create linear client
const linearClient = new LinearClient({
    key: key,
    secret: secret,
    testnet: process.env.USE_TESTNET == "true",
    rateLimitExceedCallback: ()=> {
      logIT(chalk.redBright(`RATE LIMIT EXCEED`), LOG_LEVEL.ERROR);
      process.exit(4);
    },
});

//create linear client
const contractClient = linearClient;

//account client
if (process.env.WITHDRAW == "true" || process.env.TRANSFER_TO_SPOT == "true"){
    const accountClient = new AccountAssetClient({
        key: key,
        secret: secret,
        livenet: true,
    });
}

function handleNewOrder(order, liquidity_trigger) {
  const position = newPosition({...order, "liquidity_trigger": liquidity_trigger});
  tradesHistory.set(order.symbol, position);
}

function handleDcaOrder(order, liquidity_trigger) {
  let trade_info = tradesHistory.get(order.symbol);
  if (trade_info !== undefined) {
    trade_info._dca_count++;
    trade_info._liquidity_trigger = liquidity_trigger;
    if (process.env.TRACE_TRADES != TRACE_TRADES_LEVEL_OFF)
      traceTrade("dca", trade_info, traceTradeFields);
  }
}

function tradeOrdersQueue_enqueue(orderFnObj) {
  let ordersInProgress = tradeOrdersQueue.filter(el => el.pair === orderFnObj.pair);
  if (ordersInProgress.length == 0)
    tradeOrdersQueue.push(orderFnObj);
}

function wsHandleStopOrder(data) {
    const order_data = data.data;
    //check for stoploss trigger
    if (order_data[0].stop_order_type === "StopLoss" && order_data[0].order_status === "Triggered"){
        //add coin to timeout
        addCoinToTimeout(order_data[0].symbol, process.env.STOP_LOSS_TIMEOUT);
        messageWebhook(order_data[0].symbol + " hit Stop Loss!\n Waiting " + process.env.STOP_LOSS_TIMEOUT + " ms for timeout...");
    }
    let trade_info = tradesHistory.get(order_data[0].symbol);
    if (trade_info !== undefined && order_data[0].order_status === "Triggered" && (order_data[0].stop_order_type === "StopLoss" || order_data[0].stop_order_type === "TakeProfit")) {
        trade_info._close_type = order_data[0].stop_order_type;
    }
}

function wsHandleOrder(data) {
    let close_position = false;
    const filled_orders = data.data.filter(el => el.order_status == 'Filled');
    filled_orders.forEach( async order => {

      let trade_info = tradesHistory.get(order.symbol);

      // 26/05/2023 patch as ByBit change order.create_type
      const order_type = trade_info?._close_type ? trade_info._close_type : order.create_type;

      switch(order_type) {
        case 'CreateByUser':
          // new trade
          if (trade_info !== undefined) {
            // update price with executed order price
            // verify that it's starts order not dca
            if (trade_info._start_price === 0) {
              trade_info._start_price = order.last_exec_price;
              // TODO: Handle new order should be called here to have price field with a value
              trade_info._averaged_price = order.last_exec_price;
              traceTrade("start", trade_info, traceTradeFields);
            } else {
              // handle fill of DCA orders when DCA type is DCA_AVERAGE_ENTRIES
              if (process.env.USE_DCA_FEATURE == "true" && process.env.DCA_TYPE == "DCA_AVERAGE_ENTRIES") {
                incrementPosition(trade_info, order);
                traceTrade("dca", trade_info, traceTradeFields);
              }
            }
          }
          break;
        case 'StopLoss':
          close_position = true;
          globalTradesStats.consecutive_wins = 0;
          globalTradesStats.consecutive_losses += 1;
          globalTradesStats.max_consecutive_losses = Math.max(globalTradesStats.max_consecutive_losses, globalTradesStats.consecutive_losses);
          globalTradesStats.losses_count += 1;
          break;
        case 'TakeProfit':
          close_position = true;
          globalTradesStats.consecutive_losses = 0;
          globalTradesStats.consecutive_wins += 1;
          globalTradesStats.max_consecutive_wins = Math.max(globalTradesStats.max_consecutive_wins, globalTradesStats.consecutive_wins);
          globalTradesStats.wins_count += 1;
          if (drawdownThreshold > 0 && trade_info._max_loss > drawdownThreshold) {
              addCoinToTimeout(order.symbol, process.env.STOP_LOSS_TIMEOUT);
              logIT(`handleTakeProfit::addCoinToTimeout for ${order.symbol} as during the trade have a loss greater than drawdownThreshold`);
          }
          break;
        default:
          // NOP
      }

      if (close_position) {
        globalTradesStats.trade_count += 1;
        globalTradesStats.max_loss = Math.min(globalTradesStats.max_loss, trade_info._max_loss);
        closePosition(trade_info, order);
        storeJson(globalStatsPath, globalTradesStats);
        logIT(`#trade_stats:close# ${order.symbol}: ${JSON.stringify(trade_info)}`);
        logIT(`#global_stats:close# ${JSON.stringify(globalTradesStats)}`);

        //only needed with DCA_AVERAGE_ENTRIES features on.
        if (process.env.DCA_TYPE == "DCA_AVERAGE_ENTRIES") {
          let res = await cancelOrder(linearClient, order.symbol);
          if (res.retMsg != "OK")
            logIT(`on-update - error cancelling orphan orders for ${order.symbol}`, LOG_LEVEL.ERROR);
          else
            logIT(`on-update - successfully cancel orphan orders for ${order.symbol}`);
        }

        if (process.env.TRACE_TRADES != TRACE_TRADES_LEVEL_OFF)
          traceTrade(order_type, trade_info, traceTradeFields);
        tradesHistory.delete(order.symbol);
      }
    });
};

function wsHandleLiquidations(data) {
    var pair = data.data.symbol;
    var price = parseFloat(data.data.price);
    var side = data.data.side;
    //convert to float
    var qty = parseFloat(data.data.size) * price;
    //create timestamp
    var timestamp = Math.floor(Date.now() / 1000);
    //find what index of liquidationOrders array is the pair
    var index = liquidationOrders.findIndex(x => x.pair === pair);

    var dir = "";
    if (side === "Buy") {
        dir = "Long";
    } else {
        dir = "Short";
    }

    //get blacklisted pairs
    const blacklist = [];
    var blacklist_all = process.env.BLACKLIST;
    blacklist_all = blacklist_all.replaceAll(" ", "");
    blacklist_all.split(',').forEach(item => {
        blacklist.push(item);
    });

    // get whitelisted pairs
    const whitelist = [];
    var whitelist_all = process.env.WHITELIST;
    whitelist_all = whitelist_all.replaceAll(" ", "");
    whitelist_all.split(',').forEach(item => {
        whitelist.push(item);
    });

    //if pair is not in liquidationOrders array and not in blacklist, add it
    if (index === -1 && (!blacklist.includes(pair)) && (process.env.USE_WHITELIST == "false" || (process.env.USE_WHITELIST == "true" && whitelist.includes(pair)))) {
        liquidationOrders.push({pair: pair, price: price, side: side, qty: qty, amount: 1, timestamp: timestamp});
        index = liquidationOrders.findIndex(x => x.pair === pair);
    }
    //if pair is in liquidationOrders array, update it
    else if ((!blacklist.includes(pair)) && (process.env.USE_WHITELIST == "false" || (process.env.USE_WHITELIST == "true" && whitelist.includes(pair)))) {
        //check if timesstamp is withing 5 seconds of previous timestamp
        if (timestamp - liquidationOrders[index].timestamp <= 5) {
            liquidationOrders[index].price = price;
            liquidationOrders[index].side = side;
            //add qty to existing qty and round to 2 decimal places
            liquidationOrders[index].qty = parseFloat((liquidationOrders[index].qty + qty).toFixed(2));
            liquidationOrders[index].timestamp = timestamp;
            liquidationOrders[index].amount = liquidationOrders[index].amount + 1;

        }
        //if timestamp is more than 5 seconds from previous timestamp, overwrite
        else {
            liquidationOrders[index].price = price;
            liquidationOrders[index].side = side;
            liquidationOrders[index].qty = qty;
            liquidationOrders[index].timestamp = timestamp;
            liquidationOrders[index].amount = 1;
        }

        if (liquidationOrders[index].qty > process.env.MIN_LIQUIDATION_VOLUME) {

            if (stopLossCoins.has(pair) == true && process.env.USE_STOP_LOSS_TIMEOUT == "true") {
                logIT(chalk.yellow(liquidationOrders[index].pair + " is not allowed to trade cause it is on timeout"));
            } else {
                if (process.env.PLACE_ORDERS_SEQUENTIALLY == "true")
                  tradeOrdersQueue_enqueue({'pair': pair, 'fn': scalp.bind(null, pair, {...liquidationOrders[index]}, 'Bybit', runningStatus != runningStatus_RUN)});
                else
                  scalp(pair, {...liquidationOrders[index]}, 'Bybit', runningStatus != runningStatus_RUN);
            }

        }
        else {
            logIT(chalk.magenta("[" + liquidationOrders[index].amount + "] " + dir + " Liquidation order for " + liquidationOrders[index].pair + " @Bybit with a cumulative value of " + liquidationOrders[index].qty + " USDT"));
            logIT(chalk.yellow("Not enough liquidations to trade " + liquidationOrders[index].pair));
        }

    }
    else {
        logIT(chalk.gray("Liquidation Found for Blacklisted pair: " + pair + " ignoring..."));
    }
}

wsClient.on('update', (data) => {
    logIT(`raw message received ${JSON.stringify(data, null, 2)}`, LOG_LEVEL.DEBUG);

    const topic = data.topic;
    if (topic === "stop_order") {
        wsHandleStopOrder(data);
    } else if (topic === "order") {
        wsHandleOrder(data);
    } else {
        wsHandleLiquidations(data);
    }
});

// using testnet needs to receive update notifications for
// orders and stop_orders, instead liquidations comes from regular net.
if (process.env.USE_TESTNET == "true") {
    wsTestClient.on('update', (data) => {
        logIT(`raw message received ${JSON.stringify(data, null, 2)}`, LOG_LEVEL.DEBUG);

        const topic = data.topic;
        if (topic === "stop_order") {
            wsHandleStopOrder(data);
        } else if (topic === "order") {
            wsHandleOrder(data);
        }

    });
}

binanceClient.on('formattedMessage', (data) => {
    //console.log('raw message received ', JSON.stringify(data, null, 2));
    var pair = data.liquidationOrder.symbol;
    var price = parseFloat(data.liquidationOrder.price);
    var oside = data.liquidationOrder.side;
    //convert to float
    var qty = parseFloat(data.liquidationOrder.quantity) * price;
    //create timestamp
    var timestamp = Math.floor(Date.now() / 1000);
    //find what index of liquidationOrders array is the pair
    var index = liquidationOrders.findIndex(x => x.pair === pair);

    var dir = "";
    var side = "";
    if (oside === "BUY") {
        dir = "Long";
        side = "Sell";
    } else {
        dir = "Short";
        side = "Buy";
    }

    //get blacklisted pairs
    const blacklist = [];
    var blacklist_all = process.env.BLACKLIST;
    blacklist_all = blacklist_all.replaceAll(" ", "");
    blacklist_all.split(',').forEach(item => {
        blacklist.push(item);
    });

    // get whitelisted pairs
    const whitelist = [];
    var whitelist_all = process.env.WHITELIST;
    whitelist_all = whitelist_all.replaceAll(" ", "");
    whitelist_all.split(',').forEach(item => {
        whitelist.push(item);
    });

    //if pair is not in liquidationOrders array and not in blacklist, add it
    if (index === -1 && (!blacklist.includes(pair)) && (process.env.USE_WHITELIST == "false" || (process.env.USE_WHITELIST == "true" && whitelist.includes(pair)))) {
        liquidationOrders.push({pair: pair, price: price, side: side, qty: qty, amount: 1, timestamp: timestamp});
        index = liquidationOrders.findIndex(x => x.pair === pair);
    }
    //if pair is in liquidationOrders array, update it
    else if ((!blacklist.includes(pair)) && (process.env.USE_WHITELIST == "false" || (process.env.USE_WHITELIST == "true" && whitelist.includes(pair)))) {
        //check if timesstamp is withing 5 seconds of previous timestamp
        if (timestamp - liquidationOrders[index].timestamp <= 5) {
            liquidationOrders[index].price = price;
            liquidationOrders[index].side = side;
            //add qty to existing qty and round to 2 decimal places
            liquidationOrders[index].qty = parseFloat((liquidationOrders[index].qty + qty).toFixed(2));
            liquidationOrders[index].timestamp = timestamp;
            liquidationOrders[index].amount = liquidationOrders[index].amount + 1;

        }
        //if timestamp is more than 5 seconds from previous timestamp, overwrite
        else {
            liquidationOrders[index].price = price;
            liquidationOrders[index].side = side;
            liquidationOrders[index].qty = qty;
            liquidationOrders[index].timestamp = timestamp;
            liquidationOrders[index].amount = 1;
        }

        if (liquidationOrders[index].qty > process.env.MIN_LIQUIDATION_VOLUME) {

            if (stopLossCoins.has(pair) == true && process.env.USE_STOP_LOSS_TIMEOUT == "true") {
                logIT(chalk.yellow(liquidationOrders[index].pair + " is not allowed to trade cause it is on timeout"));
            } else {
                if (process.env.PLACE_ORDERS_SEQUENTIALLY == "true")
                    tradeOrdersQueue_enqueue({'pair': pair, 'fn': scalp.bind(null, pair, {...liquidationOrders[index]}, 'Binance', runningStatus != runningStatus_RUN)});
                else
                  scalp(pair, {...liquidationOrders[index]}, 'Binance', runningStatus != runningStatus_RUN);
            }

        }
        else {
            logIT(chalk.magenta("[" + liquidationOrders[index].amount + "] " + dir + " Liquidation order for " + liquidationOrders[index].pair + " @Binance with a cumulative value of " + liquidationOrders[index].qty + " USDT"));
            logIT(chalk.yellow("Not enough liquidations to trade " + liquidationOrders[index].pair));
        }

    }
    else {
        logIT(chalk.gray("Liquidation Found for Blacklisted pair: " + pair + " ignoring..."));
    }
});

wsClient.on('open', (data,) => {
    //console.log('connection opened open:', data.wsKey);
    //catch error
    if (data.wsKey === WS_KEY_MAP.WS_KEY_ERROR) {
        logIT("Error: " + data)
        return;
    }
    //logIT("Connection opened");
});
wsClient.on('response', (data) => {
    if (data.wsKey === WS_KEY_MAP.WS_KEY_ERROR) {
        logIT("Error: " + data)
        return;
    }
    //logIT("Connection opened");
});
wsClient.on('reconnect', ({ wsKey }) => {
    logIT('ws automatically reconnecting.... ', wsKey);
});
wsClient.on('reconnected', (data) => {
    logIT('ws has reconnected ', data?.wsKey);
});
binanceClient.on('open', (data,) => {
    //console.log('connection opened open:', data.wsKey);
});
binanceClient.on('reply', (data) => {
    //console.log("Connection opened");
});
binanceClient.on('reconnecting', ({ wsKey }) => {
    logIT('ws automatically reconnecting.... ', wsKey);
});
binanceClient.on('reconnected', (data) => {
    logIT('ws has reconnected ', data?.wsKey);
});
binanceClient.on('error', (data) => {
    logIT('ws saw error ', data?.wsKey);
});

// TODO: OCHO
function remapFloatField(resp) {
  return Object.fromEntries( Object.entries(resp).map(([key, value]) => [key, parseFloat(value) ? parseFloat(value) : value]) );
}

const wsClientPtr = process.env.USE_TESTNET == "true" ? wsTestClient : wsClient;
//subscribe to stop_order to see when we hit stop-loss
wsClientPtr.subscribeV5('user.stop_order.contractAccount', 'linear').catch(e => logIT(e, LOG_LEVEL.ERROR));

//subscribe to order to see when orders where executed
wsClientPtr.subscribeV5('user.order.contractAccount', 'linear').catch(e => logIT(e, LOG_LEVEL.ERROR));

//run websocket
async function liquidationEngine(pairs) {
    if (process.env.LIQ_SOURCE.toLowerCase() == 'both') {
        wsClient.subscribeV5(pairs, 'linear').catch(e => logIT(e, LOG_LEVEL.ERROR));
        binanceClient.subscribeAllLiquidationOrders('usdm');
    }
    else if (process.env.LIQ_SOURCE.toLowerCase() == 'binance') {
        binanceClient.subscribeAllLiquidationOrders('usdm');
    }
    else {
        wsClient.subscribeV5(pairs, 'linear').catch(e => logIT(e, LOG_LEVEL.ERROR));
    }
}

async function transferFunds(amount) {
    const transfer = await accountClient.createInternalTransfer(
        {
            transfer_id: await generateTransferId(),
            coin: 'USDT',
            amount: amount.toFixed(2),
            from_account_type: 'CONTRACT',
            to_account_type: 'SPOT',
        }
    );
}

async function withdrawFunds() {
    const settings = JSON.parse(fs.readFileSync('account.json', 'utf8'));

    if (process.env.WITHDRAW == "true"){

        const withdraw = await accountClient.submitWithdrawal(
            {
                coin: process.env.WITHDRAW_COIN,
                chain: process.env.WITHDRAW_CHAIN,
                address: process.env.WITHDRAW_ADDRESS,
                amount: String(process.env.AMOUNT_TO_WITHDRAW).toFixed(2),
                account_type: process.env.WITHDRAW_ACCOUNT
            }
        );

        logIT("Withdrawl completed!")
    } else {
        logIT("Would withdrawl, but it's not active..")
    }

}

//Generate transferId
async function generateTransferId() {
    const hexDigits = "0123456789abcdefghijklmnopqrstuvwxyz";
    let transferId = "";
    for (let i = 0; i < 32; i++) {
      transferId += hexDigits.charAt(Math.floor(Math.random() * 16));
      if (i === 7 || i === 11 || i === 15 || i === 19) {
        transferId += "-";
      }
    }
    return transferId;
}

//Get server time
async function getServerTime() {
    const data = await linearClient.fetchServerTime();
    var serverTime = new Date(data * 1000);
    var serverTimeGmt = serverTime.toGMTString()+'\n' + serverTime.toLocaleString();
    return serverTimeGmt;
}

//Get margin
async function getMargin() {
    return (await linearClient.getWalletBalance({accountType: process.env.ACCOUNT_TYPE, coin: 'USDT'}, true)).usedMargin;
}

async function getOpenPositionsCount() {
  const positions = await linearClient.getPositionInfo({}, true);
  const openPositions = positions.result.list.filter(el => parseFloat(el.size) > 0).length;
  return openPositions;
}

//get account balance
var getBalanceTryCount = 0;
async function getBalance() {
    try{
        // get ping
        var started = Date.now();
        const data = await linearClient.getWalletBalance({accountType: process.env.ACCOUNT_TYPE, coin: 'USDT'}, true);
        var elapsed = (Date.now() - started);
        if (!data) {
            logIT(chalk.redBright("Error fetching balance. err: " + data.ret_code + "; msg: " + data.retMsg));
            getBalanceTryCount++;
            if (getBalanceTryCount == 3)
              process.exit(1);
            return;
        }
        getBalanceTryCount = 0
        var availableBalance = data.availableBalance;
        // save balance global to reduce api requests
        global_balance = data.availableBalance;
        var usedBalance = data.usedMargin;
        var balance = data.wholeBalance;

        //load settings.json
        const settings = JSON.parse(fs.readFileSync('account.json', 'utf8'));

        //check if starting balance is set
        if (settings.startingBalance === 0) {
            settings.startingBalance = balance;
            fs.writeFileSync('account.json', JSON.stringify(settings, null, 4));
            var startingBalance = settings.startingBalance;
        }
        else {
            var startingBalance = settings.startingBalance;
        }

        var diff = balance - startingBalance;
        var percentGain = (diff / startingBalance) * 100;

        //check for gain to safe amount to spot
        if (diff >= process.env.AMOUNT_TO_SPOT && process.env.AMOUNT_TO_SPOT > 0 && process.env.TRANSFER_TO_SPOT == "true"){
            transferFunds(diff)
            logIT("Moved " + diff + " to SPOT")
        }

        //check spot balance to withdraw

        //spot client
        if (process.env.TRANSFER_TO_SPOT == "true" || process.env.WITHDRAW == "true"){
            const spotClient = new SpotClientV3({
                key: key,
                secret: secret,
                livenet: true,
            });

            const spotBal = await spotClient.getBalances();

            if (spotBal.retCode != 0) {
                logIT(chalk.redBright("Error fetching spot balance. err: " + spotBal.retCode + "; msg: " + spotBal.retMsg));
                process.exit(1);
            }

            var withdrawCoin = spotBal.result.balances.find(item => item.coin === process.env.WITHDRAW_COIN);

            if (withdrawCoin !== undefined && withdrawCoin.total >= process.env.AMOUNT_TO_WITHDRAW && process.env.WITHDRAW == "true"){
                withdrawFunds();
                logIT("Withdraw " + withdrawCoin.total + " to " + process.env.WITHDRAW_ADDRESS)
            }
        }

        //if positive diff then log green
        if (diff >= 0) {
            logIT(chalk.greenBright.bold("Profit: " + diff.toFixed(4) + " USDT" + " (" + percentGain.toFixed(2) + "%)") + " | " + chalk.magentaBright.bold("Balance: " + balance.toFixed(4) + " USDT"));
        }
        else {
            logIT(chalk.redBright.bold("Profit: " + diff.toFixed(4) + " USDT" + " (" + percentGain.toFixed(2) + "%)") + "  " + chalk.magentaBright.bold("Balance: " + balance.toFixed(4) + " USDT"));

        }

        // create the gui data
        var percentGain = percentGain.toFixed(6);
        var diff = diff.toFixed(6);
        //fetch positions
        var positions = await linearClient.getPositionInfo({settleCoin: 'USDT'}, true);
        var positionList = [];
        var marg = await getMargin();
        var time = await getServerTime();
        //loop through positions.result[i].data get open symbols with size > 0 calculate pnl and to array
        for (var i = 0; i < positions.result.list.length; i++) {
            const positionObj = remapFloatField(positions.result.list[i]);
            if (positionObj.size > 0) {

                var pnl1 = positionObj.unrealisedPnl;
                var pnl = pnl1.toFixed(6);
                var symbol = positionObj.symbol;
                var size = positionObj.size.toFixed(4);
                var liq = positionObj.liqPrice;
                var ios = positionObj.isIsolated; //TODO:

                var priceFetch = await linearClient.getTickers({symbol: symbol}, true);
                var test = parseFloat(priceFetch.result.list[0].lastPrice);

                let side = positionObj.side;
                var dir = "";
                if (side === "Buy") {
                    dir = "✅ Long / ❌ Short";
                } else {
                    dir = "❌ Long / ✅ Short";
                }

                var stop_loss = positionObj.stopLoss;
                var take_profit = positionObj.takeProfit;
                var price = positionObj.avgPrice;
                var fee = 0 //positionObj.occ_closingFee; //TODO: BOOOOO
                var price = price.toFixed(4);

                //calulate size in USDT
                var usdValue = (positionObj.avgPrice * size) / process.env.LEVERAGE;
                var position = {
                    "symbol": symbol,
                    "size": size,
                    "side": dir,
                    "sizeUSD": usdValue.toFixed(3),
                    "pnl": pnl,
                    "liq": liq,
                    "price": price,
                    "stop_loss": stop_loss,
                    "take_profit": take_profit,
                    "iso": ios,
                    "test": test,
                    "fee": fee.toFixed(3),
                }

                let trade = tradesHistory.get(symbol);
                // handle existing orders when app starts
                if (trade === undefined) {
                  var usdValue = (positionObj.entryPrice * size) / process.env.LEVERAGE;
                  const dca_count = Math.trunc( usdValue / (balance*process.env.PERCENT_ORDER_SIZE/100) );
                  tradesHistory.set(symbol, {...position, "_max_loss" : 0, "_dca_count" : dca_count, "_start_price" : positionObj.entryPrice});
                  trade = tradesHistory.get(symbol);
                } else {
                  updatePosition(trade, {"_max_loss": Math.min(pnl, trade._max_loss), "price": price, "stop_loss": stop_loss, "take_profit": take_profit});
                }

                positionList.push({...position, "dca_count": trade._dca_count, "max_loss": trade._max_loss.toFixed(3)});
                if (process.env.TRACE_TRADES == TRACE_TRADES_LEVEL_MAX)
                  traceTrade("cont", trade, traceTradeFields);
            }
        }

        //create data payload
        const positionsCount = await getOpenPositionsCount()
        const posidata = {
            balance: balance.toFixed(2).toString(),
            leverage: process.env.LEVERAGE.toString(),
            totalUSDT: marg.toFixed(2).toString(),
            profitUSDT: diff.toString(),
            profit: percentGain.toString(),
            servertime: time.toString(),
            positioncount: positionsCount.toString(),
            ping: elapsed,
            runningStatus: runningStatus_Label[runningStatus].toString(),
            trade_count: globalTradesStats.trade_count,
            max_loss: globalTradesStats.max_loss,
            wins_count: globalTradesStats.wins_count,
            loss_count: globalTradesStats.losses_count,
            max_consecutive_wins: globalTradesStats.max_consecutive_wins,
            max_consecutive_losses: globalTradesStats.max_consecutive_losses,
        };
        //send data to gui
        io.sockets.emit("data", posidata);

        const positionsData = [];

        //for each position in positionList add field only 7 fields per embed
        for(var i = 0; i < positionList.length; i++) {
            positionsData.push({
                symbol: positionList[i].symbol,
                isolated: positionList[i].iso,
                closing_fee: positionList[i].fee,
                size: positionList[i].size,
                sizeUSD: positionList[i].sizeUSD,
                pnl: positionList[i].pnl,
                side: positionList[i].side,
                price: positionList[i].test,
                entry_price: positionList[i].price,
                stop_loss: positionList[i].stop_loss,
                take_profit: positionList[i].take_profit,
                liq_price: positionList[i].liq,
                max_loss: positionList[i].max_loss,
                dca_count: positionList[i].dca_count,
            });
        }
        //send data to gui
        io.sockets.emit("positions", positionsData);

        return balance;
    }
    catch (e) {
        logIT(`getBalance error ${e}`, LOG_LEVEL.ERROR);
        return null;
    }

}
//get position
async function getPosition(pair, side) {
    //gor through all pairs and getPosition()
    const error_result = {side: null, entryPrice: null, size: null, percentGain: null};
    var positions = await linearClient.getPositionInfo({symbol: pair, settleCoin: 'USDT'}, true);
    // TODO: check response
    if (positions.retCode != 0) {
      logIT("Open positions bad response ${positions.retMsg}");
      return error_result;
    }

    //look for pair in positions with the same side
    var index = positions.result.list.findIndex(x => x.data.symbol === pair && x.data.side === side);
    if (index != -1) {
        //console.log(positions.result.list[index].data);
        logIT(chalk.blueBright("Open position found for " + positions.result.list[index].data.symbol + " with a size of " + positions.result.list[index].data.size + " contracts" + " with profit of " + positions.result.list[index].data.realised_pnl + " USDT"));
        var profit = positions.result.list[index ].data.unrealised_pnl;
        //calculate the profit % change in USD
        var margin = positions.result.list[index ].data.position_value/process.env.LEVERAGE;
        var percentGain = (profit / margin) * 100;
        return {side: positions.result.list[index].data.side, entryPrice: positions.result.list[index].data.entry_price, size: positions.result.list[index].data.size, percentGain: percentGain};
    } else {
      //TODO: insensato
        //no open position
        return undefined;
        //return {side: positions.result.list[index].data.side, entryPrice: positions.result.list[index].data.entry_price, size: positions.result.list[index].data.size, percentGain: 0};
    }
        // else {
        //     // adding this for debugging purposes
        //     logIT("Error: getPostion invalid for " + pair + " size parameter is returning " + positions.result.list[index].data.size);
        //     messageWebhook("Error: getPostion invalid for " + pair + " size parameter is returning " + positions.result.list[index].data.size);
        //     return {side: null, entryPrice: null, size: null, percentGain: null};
        // }

    // return on error
    return {side: null, entryPrice: null, size: null, percentGain: null};
}
//take profit
async function takeProfit(symbol, position) {

    //get entry price
    var positions = await position;
    const entryPrice = parseFloat(positions.avgPrice);
    const positionSize = parseFloat(positions.size);

    if (positions.side === "Buy") {
        var side = "Buy";
        var takeProfit = (entryPrice + (entryPrice * (process.env.TAKE_PROFIT_PERCENT/100) / process.env.LEVERAGE)).toFixed(decimalPlaces);
        var stopLoss = (entryPrice - (entryPrice * (process.env.STOP_LOSS_PERCENT/100) / process.env.LEVERAGE)).toFixed(decimalPlaces);
    }
    else {
        var side = "Sell";
        var takeProfit = (entryPrice - (entryPrice * (process.env.TAKE_PROFIT_PERCENT/100) / process.env.LEVERAGE)).toFixed(decimalPlaces);
        var stopLoss = (entryPrice + (entryPrice * (process.env.STOP_LOSS_PERCENT/100) / process.env.LEVERAGE)).toFixed(decimalPlaces);
    }

    //load min order size json

    const tickData = JSON.parse(fs.readFileSync('min_order_sizes.json', 'utf8'));

    try {
        var index = tickData.findIndex(x => x.pair === symbol);
        var tickSize = tickData[index].tickSize;
        var decimalPlaces = (tickSize.toString().split(".")[1] || []).length;
        const currentTakeProfit = parseFloat(positions.takeProfit).toFixed(decimalPlaces)
        const currentStopLoss = parseFloat(positions.stopLoss).toFixed(decimalPlaces)

        if (positionSize > 0 && currentTakeProfit === 0 || currentTakeProfit !== takeProfit || stopLoss !== currentStopLoss) {
            if(process.env.USE_STOPLOSS.toLowerCase() === "true") {

                var cfg = {
                    symbol: symbol,
                    side: side,
                    stopLoss: stopLoss,
                };

                if(process.env.USE_TAKE_PROFIT.toLowerCase() === "true")
                    cfg['takeProfit'] = takeProfit;

                const order = await linearClient.setTradingStop(cfg);
                //console.log(JSON.stringify(order, null, 4));

                if (order.retMsg === "OK" || order.retMsg === "not modified" || order.ret_code === 10002) {
                    //console.log(chalk.red("TAKE PROFIT ERROR: ", JSON.stringify(order, null, 2)));
                }
                else if (order.ret_code === 130027 || order.ret_code === 130030 || order.ret_code === 130024) {
                    //find current price
                    var priceFetch = await linearClient.getTickers({symbol: symbol});
                    var price = parseFloat(priceFetch.result.list[0].lastPrice);
                    //if side is sell add 1 tick to price
                    if (side === "Sell") {
                        price = parseFloat(priceFetch.result.list[0].askPrice);
                    }
                    else {
                        price = parseFloat(priceFetch.result.list[0].bid_price);
                    }

                    var cfg = {
                        symbol: symbol,
                        side: side,
                        stopLoss: stopLoss,
                    };

                    if(process.env.USE_TAKE_PROFIT.toLowerCase() === "true")
                        cfg['takeProfit'] = price.toFixed(decimalPlaces)

                    const order = await linearClient.setTradingStop(cfg);

                    logIT(chalk.red("TAKE PROFIT FAILED FOR " + symbol + " WITH ERROR PRICE MOVING TOO FAST OR ORDER ALREADY CLOSED, TRYING TO FILL AT BID/ASK!!"));
                }
                else {
                    logIT(chalk.red("TAKE PROFIT ERROR: ", JSON.stringify(order, null, 4)));
                }

            }
            else if (process.env.USE_TAKE_PROFIT.toLowerCase() === "true"){
                const order = await linearClient.setTradingStop({
                    // if hedge mode
                    positionIdx: side == 'Buy' ? 1 : 2,
                    symbol: symbol,
                    side: side,
                    takeProfit: takeProfit,
                });
                //console.log(JSON.stringify(order, null, 2));
                if(order.retMsg === "OK" || order.retMsg === "not modified" || order.retCode ===  34040) {
                    //console.log(chalk.red("TAKE PROFIT ERROR: ", JSON.stringify(order, null, 2)));
                }
                else if (order.ret_code === 130027 || order.ret_code === 130030) {
                    logIT(chalk.cyanBright("TAKE PROFIT FAILED PRICING MOVING FAST!! TRYING TO PLACE ABOVE CURRENT PRICE!!"));
                    //find current price
                    var priceFetch = await linearClient.getTickers({symbol: symbol});

                    logIT("Current price: " + JSON.stringify(priceFetch, null, 4));
                    var price = parseFloat(priceFetch.result.list[0].lastPrice);

                    //if side is sell add 1 tick to price
                    if (side === "Sell") {
                        price = parseFloat(priceFetch.result.list[0].askPrice);
                    }
                    else {
                        price = parseFloat(priceFetch.result.list[0].bidPrice);
                    }
                    logIT("Price for symbol " + symbol + " is " + price);
                    const order = await linearClient.setTradingStop({
                        // if hedge mode
                        positionIdx: side == 'Buy' ? 1 : 2,
                        symbol: symbol,
                        side: side,
                        takeProfit: price,
                    });
                    logIT(chalk.red("TAKE PROFIT FAILED FOR " + symbol + " WITH ERROR PRICE MOVING TOO FAST, TRYING TO FILL AT BID/ASK!!"));
                }
                else {
                    logIT(chalk.red("TAKE PROFIT ERROR: ", JSON.stringify(order, null, 2)));
                }
            }
        }
        else {
            logIT("No take profit to set for " + symbol);
            console.log("takeProfit " + takeProfit);
            console.log("positions.takeProfit " + currentTakeProfit);
        }
    }
    catch (e) {
        logIT(chalk.red("Error setting take profit: " + e + " for symbol " + symbol));
    }

}


//against trend
async function scalp(pair, liquidationInfo, source, new_trades_disabled = false) {
    //check how many positions are open
    const open_positions = openPositions
    logIT("scalp - Open positions: " + open_positions);

    const trigger_qty = liquidationInfo.qty;

    //make sure openPositions is less than max open positions and not null
    if (open_positions === null) {
      logIT(chalk.redBright("scalp - failed to fetch open positions!"));
      return;
    }

    let side = liquidationInfo.side;
    const settings = await JSON.parse(fs.readFileSync('settings.json', 'utf8'));
    var settingsIndex = await settings.pairs.findIndex(x => x.symbol === pair);

    // check price bounds
    if(settingsIndex == -1) {
      logIT(chalk.bgRedBright("scalp - " + pair + " does not exist in settings.json"));
      return;
    }
    if (side == "Buy" && liquidationInfo.price >= settings.pairs[settingsIndex].long_price) {
      logIT(chalk.cyan("scalp - " + "!! Liquidation price " + liquidationInfo.price + " is higher than long price " + settings.pairs[settingsIndex].long_price + " for " + pair));
      return;
    }
    if (side == "Sell" && liquidationInfo.price <= settings.pairs[settingsIndex].short_price) {
      logIT(chalk.cyan("scalp - " + "!! Liquidation price " + liquidationInfo.price + " is lower than short price " + settings.pairs[settingsIndex].long_price + " for " + pair));
      return;
    }

    dumpLiquidationInfo({
      'time': moment().utc().format(),
      'pair': pair,
      'side': side,
      'price': liquidationInfo.price,
      'size': liquidationInfo.qty,
    });

    //load min order size json
    const tickData = JSON.parse(fs.readFileSync('min_order_sizes.json', 'utf8'));
    var index = tickData.findIndex(x => x.pair === pair);
    var tickSize = tickData[index].tickSize;
    var decimalPlaces = (tickSize.toString().split(".")[1] || []).length;

    var position = await getPosition(pair, side);

    // if (position ? position.size == null : true) {
    //   logIT(chalk.redBright("scalp - " + "Error getting position for " + pair));
    //   return;
    // }
    const positionSize = position == undefined ? 0 : parseFloat(position.size);

    if (positionSize == 0 && new_trades_disabled) {
      logIT("scalp - " + "Server is in pause new trades are disabled");
      return;
    }

    if (positionSize == 0 && tradesHistory.get(pair) != undefined) {
      logIT("scalp - discard order as exchange position data is not updated: position was already opened and does not result on exchange yet");
      return;
    }

    // handle filteredPair
    const filtered = filteredPairs.find(el => el.symbol == pair);
    if (filtered !== undefined) {
      logIT(`scalp - discard order as pair ${pair} is in filter list reason ${filtered.reason}`);
      return;
    }

    // place new order
    if (positionSize == 0) {

      if (open_positions >= process.env.MAX_OPEN_POSITIONS) {
        logIT(chalk.redBright("scalp - Max Open Positions Reached!"));
        return;
      }

      // check volatility filter
      if (parseFloat(env.FILTER_CHECK_VOLATILITY_PRC) != 0) {
        const volatility = await getVolatility(pair, parseInt(env.FILTER_CHECK_VOLATILITY_PERIOD));
        if (volatility >  parseFloat(env.FILTER_CHECK_VOLATILITY_PRC)) { // if volatility > env.FILTER_CHECK_VOLATILITY_PRC discard token
          logIT("scalp - discard order as token ${pair} have too big volatility ${volatility}");
          return;
        }
      }

      // evaluate process.env.TRADE_POSITIONS_SIDE_BALANCE to have equals number of long and short
      const maxTradeForSide = Math.round(process.env.MAX_OPEN_POSITIONS / process.env.TRADE_POSITIONS_SIDE_BALANCE == true ? 2 : 1);
      const tradesForSide =  Array.from(tradesHistory.values()).filter(el => el.side == side).length;
      if (tradesForSide >  maxTradeForSide) {
        logIT(chalk.redBright("scalp - Max {side} Positions Reached!"));
        return;
      }

      //get current price
      var priceFetch = await linearClient.getTickers({symbol: pair});
      const price = parseFloat(priceFetch.result.list[0].lastPrice);

      // set leverage and margin-mode
      setLeverage(pair, process.env.LEVERAGE)
      // send order payload
      let take_profit = process.env.USE_TAKE_PROFIT == "true" ?
        (side == "Buy" ? pluspercent(price, process.env.TAKE_PROFIT_PERCENT).toFixed(decimalPlaces) : minuspercent(price, process.env.TAKE_PROFIT_PERCENT).toFixed(decimalPlaces)) : 0;
      let stop_loss = process.env.USE_STOPLOSS == "true" ?
        (side == "Buy" ? minuspercent(price, process.env.STOP_LOSS_PERCENT).toFixed(decimalPlaces) : pluspercent(price, process.env.STOP_LOSS_PERCENT).toFixed(decimalPlaces)) : 0;
      let size = settings.pairs[settingsIndex].order_size.toFixed(decimalPlaces);
      let order = await createMarketOrder(linearClient, pair, side, size, take_profit, stop_loss);
      if (order.retMsg != "OK") {
        logIT(`scalp exit: Error placing new ${side} order: ${order.retMsg}`);
        return;
      } else {
        handleNewOrder(order.result, trigger_qty);
        openPositions++; // increment here as async liquidation could be already enqueued and need synched openPositions status
        logIT(chalk.bgGreenBright(`scalp - ${side} Order Placed for ${pair} at ${settings.pairs[settingsIndex].order_size} size`));

        if (process.env.USE_DCA_FEATURE == "true" && process.env.DCA_TYPE == "DCA_AVERAGE_ENTRIES") {
          let dca_size = size;
          for (let i = 1; i <= process.env.DCA_SAFETY_ORDERS; i++) {
            let dca_price = side == "Buy" ? price * (1 - process.env.DCA_PRICE_DEVIATION_PRC * i / 100) : price * (1 + process.env.DCA_PRICE_DEVIATION_PRC * i /100)
            dca_price = dca_price.toFixed(decimalPlaces)
            dca_size = (dca_size * process.env.DCA_VOLUME_SCALE).toFixed(decimalPlaces)
            const dcaOrder = await createLimitOrder(linearClient, pair, side, dca_size, dca_price);
            if (dcaOrder.retMsg != "OK") {
              logIT(`scalp exit: Error placing new ${side} DCA[${i}] order: ${dcaOrder.retMsg} for ${pair} at price ${dca_price}`, LOG_LEVEL.ERROR);
              return;
            }
            logIT(chalk.bgGreenBright(`scalp - ${side} DCA[${i}] Order Placed for ${pair} at ${dca_size} size`));
          }
        }

        if(process.env.USE_DISCORD == "true") {
          orderWebhook(pair, settings.pairs[settingsIndex].order_size, side, positionSize, 0, trigger_qty, source);
        }
      } //TODO: remap position fields
    } else {
      const positionPercentGain = (parseFloat(position.markPrice) - parseFloat(position.avgPrice)) / parseFloat(position.avgPrice) * (position.side == "Buy" ? 1 : -1);
      if (positionPercentGain < 0 && process.env.USE_DCA_FEATURE == "true" && process.env.DCA_TYPE == "DCA_LIQUIDATIONS") {

        //Long/Short liquidation
        //make sure order is less than max order size
        if ((positionSize + settings.pairs[settingsIndex].order_size) > settings.pairs[settingsIndex].max_position_size) {
          //max position size reached
          logIT("scalp - " + "Max position size reached for " + pair);
          messageWebhook("Max position size reached for " + pair);
          return;
        }
        // set leverage and margin-mode
        setLeverage(pair, process.env.LEVERAGE)
        // order payload
        let size = settings.pairs[settingsIndex].order_size.toFixed(decimalPlaces);
        let order = await createMarketOrder(linearClient, pair, position.side, size, price);
        handleDcaOrder(order.result, trigger_qty);
        logIT(chalk.bgGreenBright.black("scalp - " + side + " DCA Order Placed for " + pair + " at " + settings.pairs[settingsIndex].order_size + " size"));
        if(process.env.USE_DISCORD == "true") {
            orderWebhook(pair, settings.pairs[settingsIndex].order_size, side, positionSize, positionPercentGain, trigger_qty, source);
        }
      } else {
        logIT(chalk.redBright("scalp - " + "DCA disabled or position pnl is positive for " + pair));
      }
    }
}

//set leverage on pair
async function setLeverage(pair, leverage) {
    //remove "liquidation." from pair name
    pair = pair.replace("liquidation.", "");

    try{
        if (process.env.MARGIN == "ISOLATED"){
            const setUserLeverage = await linearClient.setLeverage({symbol: pair,buyLeverage: leverage,sellLeverage: leverage});
            //const setMarginSwitch = await linearClient.setMarginSwitch({symbol: pair,buyLeverage: leverage,sellLeverage: leverage,is_isolated: true});
        } else {
            const setUserLeverage = await linearClient.setLeverage({symbol: pair,buyLeverage: leverage,sellLeverage: leverage});
            //const setMarginSwitch = await linearClient.setMarginSwitch({symbol: pair,buyLeverage: leverage,sellLeverage: leverage,is_isolated: false});
        }
    }
    catch (e) {
        logIT(chalk.redBright("ERROR setting leverage for " + pair + " to " + leverage, e));
        await sleep(1000);
    }
}

//set position mode to hedge
async function setPositionMode() {

    const set = await linearClient.switchPositionMode({
        coin: "USDT",
        mode: 3 //  0: Merged Single. 3: Both Sides
    });
    //log responses
    if (set.retMsg === "OK") {
        logIT("Position mode set");
        return true;
    }
    else if (set.retMsg === "Partial symbols switched successfully, excluding symbols with open orders or positions.") {
        logIT("Position mode set for symbols without positions");
        return false;
    }
    else if (set.retMsg === "All symbols switched successfully."){
        logIT("Position mode set");
        return true;
    } else {
        logIT(chalk.redBright("Unable to set position mode"));
        return false;
    }

}

async function checkLeverage(symbol) {
    var position = await linearClient.getPositionInfo({symbol: symbol}, true);
    var leverage = position.result[0].leverage;
    return leverage;
}
//create loop that checks for open positions every second
async function checkOpenPositions() {
    //go through all pairs and getPosition()
    var positions = await linearClient.getPositionInfo({settleCoin: 'USDT'}, true);
    openPositions = positions.result.list.length;  // positions.result.list.filter(el => parseFloat(el.size) > 0).length;
    const data = await linearClient.getWalletBalance({accountType: process.env.ACCOUNT_TYPE, coin: 'USDT'}, true);

    // pairs in paused list are not handled
    // in this way user could set custom tp/sl and wait the trade to be completed
    const pausedList = process.env.PAUSED_LIST.replace(/ /g, "").split(",");

    //logIT("Positions: " + JSON.stringify(positions, null, 2));
    var totalPositions = 0;
    var postionList = [];
    if (positions.result !== null) { // TOFO: remove
        for (var i = 0; i < positions.result.list.length; i++) {
            //if (parseFloat(positions.result.list[i].size) > 0) {
            let position = positions.result.list[i]
            //logIT("Open Position for " + positions.result[i].data.symbol + " with size " + positions.result[i].data.size + " and side " + positions.result[i].data.side + " and pnl " + positions.result[i].data.unrealised_pnl);
            if (process.env.USE_RECALC_SL_TP == "true" && !pausedList.includes(position.symbol))
                await takeProfit(position.symbol, position);

            //get usd value of position
            var usdValue = (parseFloat(position.avgPrice) * parseFloat(position.size)) / process.env.LEVERAGE;
            totalPositions++;

            var profit = parseFloat(position.unrealisedPnl);
            //get available Balance
            var availableBalance = data.availableBalance;
            //calculate the profit % change in USD
            // var margin = parseFloat(position.positionValue)/process.env.LEVERAGE;

            // if (positions.result[i].data.is_isolated == false)
            //     margin = positions.result[i].data.position_margin - global_balance;
            // TODO: check margin
            const margin = parseFloat(position.positionMM)

            var percentGain = (profit / margin) * 100;

            //create object to store in postionList
            var positionElement = {
                symbol: position.symbol,
                size: parseFloat(position.size),
                usdValue: usdValue.toFixed(4),
                side: position.side,
                //dca_count: positions.result[i].dca_count, // for future use
                pnl: parseFloat(position.unrealisedPnl).toFixed(5) + "(" + percentGain.toFixed(2) + ")"
            }
            postionList.push(positionElement);

            //}
        }
    }
    else {
        logIT("Open positions response is null");
    }
    if (postionList != 0){
        console.log("+----------------+");
        console.log("¦ Open Positions ¦");
        console.table(postionList);
    }
    return postionList;
}

async function getNewOrders() {
  const openOrdersResp = await contractClient.getHistoricOrders({orderStatus: "New"});
  if (openOrdersResp.retMsg != "OK") {
    logIT(`closeQuitPosition - error getting orders list: ${openOrdersResp.retMsg}`, LOG_LEVEL.ERROR);
    return [];
  }

  return openOrdersResp.result.list;
}

async function closeOrphanOrders(openPositionsList, openOrders) {
  const orphans = openOrders.filter(el => openPositionsList.find( el2 => el2.symbol == el.symbol) == undefined);
  if(orphans.length > 0) {
    orphans.forEach(async el => {
      let res =  await cancelOrder(linearClient, el.symbol);
      if (res.retMsg != "OK")
        logIT(`closeQuitPosition - error cancelling orphan orders for ${el.symbol}`, LOG_LEVEL.ERROR);
      else
        logIT(`closeQuitPosition - successfully cancel orphan orders for ${el.symbol}`);
    });
  } else {
    logIT(`closeQuitPosition - Orphan orders not found`);
  }
}

async function getMinTradingSize() {
    const response = await linearClient.getInstrumentsInfo();
    if (response.retCode != 0)
      throw Error(response.retMsg);
    const allData = response.result.list;
    const data = allData.filter(el => el.contractType == 'LinearPerpetual' && el.quoteCoin == 'USDT');
    var balance = (await linearClient.getWalletBalance({accountType: process.env.ACCOUNT_TYPE, coin: 'USDT'}, true)).wholeBalance;

    if (balance !== null) {
        var tickers = await linearClient.getTickers({}, true);
        //var positions = await linearClient.getPositionInfo({settleCoin: 'USDT'}, true);

        minOrderSizes = []; //update global variable TODO: refactoring to avoid global
        logIT("Fetching min Trading Sizes for pairs, this could take a minute...");
        for (var i = 0; i < data.length; i++) {
            logIT("Pair: " + data[i].symbol + " Min Trading Size: " + data[i].lotSizeFilter.minOrderQty);
            //check if min_trading_qty usd value is less than process.env.MIN_ORDER_SIZE
            var minOrderSize = data[i].lotSizeFilter.minOrderQty;
            //get price of pair from tickers
            var priceFetch = tickers.result.list.find(x => x.symbol === data[i].symbol);
            if (!priceFetch) {
              console.log("Ignore Pair: " + data[i].symbol + " as ticker was not found");
              continue;
            }
            var price = parseFloat(priceFetch.lastPrice);
            //get usd value of min order size
            var usdValue = (minOrderSize * price);
            //logIT("USD value of " + data[i].symbol + " is " + usdValue);
            //find usd valie of process.env.MIN_ORDER_SIZE
            var minOrderSizeUSD = (balance * process.env.PERCENT_ORDER_SIZE/100) * process.env.LEVERAGE;
            //logIT("USD value of " + process.env.PERCENT_ORDER_SIZE + " is " + minOrderSizeUSD);
            if (minOrderSizeUSD < usdValue) {
                //use min order size
                var minOrderSizePair = minOrderSize;
                //not tradeable since our percent order size is much lower than min order size value
                var tradeable = false
            }
            else {
                //convert min orderSizeUSD to pair value
                var minOrderSizePair = (minOrderSizeUSD / price);
                var tradeable = true
            }
            try{
                //find pair ion positions
                // var position = positions.result.list.find(x => x.symbol === data[i].symbol);
                // if (position === undefined) {
                //   logIT(chalk.bgRed(`skip ${data[i].symbol} position is undefined`));
                //   continue;
                // }

                //find max position size for pair
                var maxPositionSize = ((balance * (process.env.MAX_POSITION_SIZE_PERCENT/100)) / price) * process.env.LEVERAGE;
                //save min order size and max position size to json
                var minOrderSizeJson = {
                    "pair": data[i].symbol,
                    "minOrderSize": minOrderSizePair,
                    "maxPositionSize": maxPositionSize,
                    "tickSize": data[i].priceFilter.tickSize,
                    "tradeable": tradeable
                }

                if (minOrderSizeJson.tickSize == undefined) {
                  logIT(`getMinTradingSize - bad tickSize: ignore pair ${minOrderSizeJson.pair}`, LOG_LEVEL.ERROR);
                } else {
                  //add to array
                  minOrderSizes.push(minOrderSizeJson);
                }
            }
            catch (e) {
                await sleep(10);
            }

        }
        fs.writeFileSync('min_order_sizes.json', JSON.stringify(minOrderSizes, null, 4));


        //update settings.json with min order sizes
        if (fs.existsSync('settings.json')) { // check existence of the file
          if (Object.keys(settings).length === 0) // avoid read file if it's already loaded in the global settings TODO: avoid global
            settings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
          let updated = false;
          for (var i = 0; i < minOrderSizes.length; i++) {
              var settingsIndex = settings.pairs.findIndex(x => x.symbol === minOrderSizes[i].pair);
              if(settingsIndex !== -1) {
                  settings.pairs[settingsIndex].order_size = minOrderSizes[i].minOrderSize;
                  settings.pairs[settingsIndex].max_position_size = minOrderSizes[i].maxPositionSize;
                  updated = true;
              }
          }

          if (updated) {
            fs.writeFileSync('settings.json', JSON.stringify(settings, null, 2));
          }
        }
    }
    else {
        logIT("Error fetching balance");
    }

}
//get all symbols
async function getSymbols() {
    try{
        const response = await linearClient.getTickers();
        if (response.retCode != 0)
          throw Error(response.retMsg);
        var symbols = [];
        const data = response.result.list;
        //only allow symbols that are not inverse
        for (var i = 0; i < data.length; i++) {
            //check if 1000 or any number is in the name
            if (data[i].symbol.includes("1000")) {
                continue;
            }
            else {
                var t1 = "liquidation.";
                var t2 = data[i].symbol.toString();
                //check if t2 ends in USDT
                if (t2.endsWith("USDT")) {
                    var pair = t1.concat(t2);
                    symbols.push(pair);
                }

            }

        }
        return symbols;
    }
    catch(err) {
        logIT(err);
        return null;
    }
}
//sleep function
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
//auto create settings.json file
async function createSettings() {
    await getMinTradingSize();
    var minOrderSizes = JSON.parse(fs.readFileSync('min_order_sizes.json'));
    //get info from https://api.liquidation.report/public/research
    const url = "https://liquidation.report/api/lickhunter";
    fetch(url)
    .then(res => res.json())
    .then((out) => {
        //create settings.json file with multiple pairs
        settings = {}; // use global var TODO: avoid global
        settings["pairs"] = [];
        for (var i = 0; i < out.data.length; i++) {
            //logIT("Adding Smart Settings for " + out.data[i].name + " to settings.json");
            //if name contains 1000 or does not end in USDT, skip
            if (out.data[i].name.includes("1000")) {
                continue;
            }
            else {
                //find index of pair in min_order_sizes.json "pair" key
                var index = minOrderSizes.findIndex(x => x.pair === out.data[i].name + "USDT");
                if (index === -1) {
                    continue;
                }
                else {
                    //risk level
                    var riskLevellong  = process.env.RISK_LEVEL_LONG;
					var riskLevelshort = process.env.RISK_LEVEL_SHORT;
					if (riskLevellong !== '0') {
						var long_risk = out.data[i].long_price * (1 + riskLevellong / 100);
					}
					else {
					var long_risk = out.data[i].long_price;
					}

					if (riskLevelshort !== '0') {
						var short_risk = out.data[i].short_price * (1 - riskLevelshort / 100);
					}
					else {
					var short_risk = out.data[i].short_price;
					}

                    var pair = {
                        "symbol": out.data[i].name + "USDT",
                        "leverage": process.env.LEVERAGE,
                        "min_volume": process.env.MIN_LIQUIDATION_VOLUME,
                        "take_profit": process.env.TAKE_PROFIT_PERCENT,
                        "stop_loss": process.env.STOP_LOSS_PERCENT,
                        "order_size": minOrderSizes[index].minOrderSize,
                        "max_position_size": minOrderSizes[index].maxPositionSize,
                        "long_price": long_risk,
                        "short_price": short_risk
                    }
                    if (minOrderSizes[index].tradeable == true) {
                        settings["pairs"].push(pair);
                    }
                    else {
                        continue;
                    }
                }
            }
        }
        fs.writeFileSync('settings.json', JSON.stringify(settings, null, 4));

    }).catch(err => { throw err });
}
//update settings.json file with long_price and short_price

async function updateSettings() {
    //check if last update was more than 5 minutes ago
    if (lastUpdate == 0) {
        lastUpdate = Date.now();
    }
    else {
        var now = Date.now();
        var diff = now - lastUpdate;
        if (diff < 300000) {
            return;
        }
        else {
            lastUpdate = Date.now();
            if(process.env.UPDATE_MIN_ORDER_SIZING == "true") {
                await getMinTradingSize();
            }
            var minOrderSizes = JSON.parse(fs.readFileSync('min_order_sizes.json'));
            var settingsFile = JSON.parse(fs.readFileSync('settings.json'));
            const url = "https://liquidation.report/api/lickhunter";
            fetch(url)
            .then(res => res.json())
            .then((out) => {
                //create settings.json file with multiple pairs
                //save result to research.json
                fs.writeFileSync('research.json', JSON.stringify(out, null, 4));
                var settings = {};
                settings["pairs"] = [];
                for (var i = 0; i < out.data.length; i++) {
                    //find index of pair in min_order_sizes.json "pair" key
                    var index = minOrderSizes.findIndex(x => x.pair === out.data[i].name + "USDT");
                    var settingsIndex = settingsFile.pairs.findIndex(x => x.symbol === out.data[i].name + "USDT");
                    if (index === -1 || settingsIndex === -1 || out.data[i].name.includes("1000")) {
                        //logIT("Skipping " + out.data[i].name + "USDT");
                    }
                    else {
                        //set risk then update long_price and short_price
                        var riskLevellong  = process.env.RISK_LEVEL_LONG;
						var riskLevelshort = process.env.RISK_LEVEL_SHORT;
						if (riskLevellong !== '0') {
							var long_risk = out.data[i].long_price * (1 + riskLevellong / 100);
						}
						else {
						var long_risk = out.data[i].long_price;
						}
						if (riskLevelshort !== '0') {
							var short_risk = out.data[i].short_price * (1 - riskLevelshort / 100);
						}
						else {
						var short_risk = out.data[i].short_price;
                        }
                        //updated settings.json file
                        settingsFile.pairs[settingsIndex].long_price = long_risk;
                        settingsFile.pairs[settingsIndex].short_price = short_risk;
                    }
                }
                fs.writeFileSync('settings.json', JSON.stringify(settingsFile, null, 4));
            //if error load research.json file and update settings.json file
            }).catch(
                err => {
                    logIT(chalk.red("Reaseach API down Attempting to load research.json file, if this continues please contact @Crypt0gnoe or @Atsutane in Discord"));
                    var minOrderSizes = JSON.parse(fs.readFileSync('min_order_sizes.json'));
                    var settingsFile = JSON.parse(fs.readFileSync('settings.json'));
                    var researchFile = JSON.parse(fs.readFileSync('research.json'));
                    var settings = {};
                    settings["pairs"] = [];
                    for (var i = 0; i < researchFile.data.length; i++) {
                        //find index of pair in min_order_sizes.json "pair" key
                        var index = minOrderSizes.findIndex(x => x.pair === researchFile.data[i].name + "USDT");
                        var settingsIndex = settingsFile.pairs.findIndex(x => x.symbol === researchFile.data[i].name + "USDT");
                        try{
                            if (index === -1 || settingsIndex === 'undefined' || researchFile.data[i].name.includes("1000")) {
                                //logIT("Skipping " + researchFile.data[i].name + "USDT");
                            }
                            else {
                                //set risk then update long_price and short_price
                                var riskLevellong = process.env.RISK_LEVEL_LONG;
								var riskLevelshort = process.env.RISK_LEVEL_SHORT;
								if (riskLevellong !== '0') {
									var long_risk = researchFile.data[i].long_price * (1 + riskLevellong / 100);
								}
								else {
									var long_risk = researchFile.data[i].long_price;
								}
								if (riskLevelshort !== '0') {
									var short_risk = researchFile.data[i].short_price * (1 - riskLevelshort / 100);
								}
								else {
								var short_risk = researchFile.data[i].short_price;
								}
                                //updated settings.json file
                                settingsFile.pairs[settingsIndex].long_price = long_risk;
                                settingsFile.pairs[settingsIndex].short_price = short_risk;
                            }
                        }
                        catch(err){
                            logIT("Error updating " + researchFile.data[i].name + "USDT, this is likely due to not having this pair active in your settings.json file");
                        }


                    }
                    fs.writeFileSync('settings.json', JSON.stringify(settingsFile, null, 4));
                }
            );
        }
    }

}

//discord webhook
function orderWebhook(symbol, amount, side, position, pnl, qty, source) {
    if(process.env.USE_DISCORD == "true") {
        if (side == "Buy") {
            var color = '#00ff00';
        }
        else {
            var color = '#ff0000';

        }
        var dir = "";
        if (side === "Buy") {
            dir = "✅Long";
            var color = '#00ff00';
        } else {
            dir = "❌Short";
            var color = '#ff0000';
        }
        const embed = new MessageBuilder()
            .setTitle('New Liquidation | ' + symbol.toString() + ' | ' + dir)
            .addField('Symbol: ', symbol.toString(), true)
            .addField('Amount: ', amount.toString(), true)
            .addField('Liq. Vol.: ', qty.toFixed(0), true)
            .addField('Side: ', dir, true)
            .addField('Source: ', source, true)
            .setColor(color)
            .setTimestamp();
        try {
            hook.send(embed);
        }
        catch (err) {
            logIT(chalk.red("Discord Webhook Error"));
        }
    }
}

function calculateBotUptime(uptimeSeconds) {
    var elapsedDays = uptimeSeconds / 86400;  //days
    var restSeconds = uptimeSeconds % 86400;   // rest of seconds left
    var elapsedHours = restSeconds / 3600;          // hours
    restSeconds = restSeconds % 3600;
    var elapsedMinutes = restSeconds / 60;          // minutes
    var elapsedSeconds = restSeconds % 60;
    var times = [parseInt(elapsedDays), parseInt(elapsedHours), parseInt(elapsedMinutes), parseInt(elapsedSeconds)];
    return times;
}

function getRunningStatus(req, res, next) {
  const old_runningStatus = runningStatus;

  if (!req.session.isLoggedIn) {
    res.redirect('/login');
  }

  if (req.query.set !== undefined) {
    switch(req.query.set.toLowerCase())
    {
      case "run":
        runningStatus = runningStatus_RUN;
        break;
      case "pause":
        runningStatus = runningStatus_PAUSE;
        break;
      default:
        logIT(`get running status request bad value ${req.query.status}`)
    }
  }

  if (old_runningStatus == runningStatus)
    logIT(`running status is ${runningStatus_Label[runningStatus]}`);
  else
    logIT(`running status switch from  ${runningStatus_Label[old_runningStatus]} to ${runningStatus_Label[runningStatus]}`);
  next();
}

function isAuthenticated(req, res, next) {
    if (req.session.isLoggedIn) {
      return next();
    }
    res.redirect('/login');
}

//add coins to a timeout if stop-loss is met
function addCoinToTimeout(coin, time) {
    if (stopLossCoins.has(coin)) {
        clearTimeout(stopLossCoins.get(coin));
        stopLossCoins.delete(coin);
    }

    const timerId = setTimeout(() => {
        stopLossCoins.delete(coin);
        logIT(`Coin ${coin} removed from timeout`);
    }, time);

    stopLossCoins.set(coin, timerId);
    logIT(`Added coin ${coin} to timeout for ${time}ms`);
}

//message webhook
function messageWebhook(message) {
    if(process.env.USE_DISCORD == "true") {
        const embed = new MessageBuilder()
            .setTitle('New Alert')
            .addField('Message: ', message, true)
            .setColor('#00FFFF')
            .setTimestamp();
        try {
            hook.send(embed);
        }
        catch (err) {
            logIT(chalk.red("Discord Webhook Error"));
        }
    }
}

//report webhook
async function reportWebhook() {
    if(process.env.USE_DISCORD == "true") {
        const settings = JSON.parse(fs.readFileSync('account.json', 'utf8'));
        //fetch balance first if not startingBalance will be null
        var balance = (await linearClient.getWalletBalance({accountType: process.env.ACCOUNT_TYPE, coin: 'USDT'}, true)).wholeBalance;
        //check if starting balance is set
        if (settings.startingBalance === 0) {
            settings.startingBalance = balance;
            fs.writeFileSync('account.json', JSON.stringify(settings, null, 4));
            var startingBalance = settings.startingBalance;
        }
        else {
            var startingBalance = settings.startingBalance;
        }

        //get current timestamp and calculate bot uptime
        const timestampNow = moment();
        const timeUptimeInSeconds = timestampNow.diff(timestampBotStart, 'seconds');
        const times = calculateBotUptime(timeUptimeInSeconds);

        //fetch balance
        var diff = balance - startingBalance;
        var percentGain = (diff / startingBalance) * 100;
        var percentGain = percentGain.toFixed(6);
        var diff = diff.toFixed(6);
        var balance = balance.toFixed(2);
        //fetch positions
        var positions = await linearClient.getPositionInfo({settleCoin: 'USDT'}, true);
        var positionList = [];
        var marg = await getMargin();
        var time = await getServerTime();
        //loop through positions.result[i].data get open symbols with size > 0 calculate pnl and to array
        for (var i = 0; i < positions.result.length; i++) {
            if (positions.result[i].data.size > 0) {

                var pnl1 = positions.result[i].data.unrealised_pnl;
                var pnl = pnl1.toFixed(6);
                var symbol = positions.result[i].data.symbol;
                var size = positions.result[i].data.size;
                var liq = positions.result[i].data.liq_price;
                var size = size.toFixed(4);
                var ios = positions.result[i].data.is_isolated;

                var priceFetch = await linearClient.getTickers({symbol: symbol}, true);
                var test = priceFetch.result[0].lastPrice;

                let side = positions.result[i].data.side;
                var dir = "";
                if (side === "Buy") {
                    dir = "✅Long / ❌Short";
                } else {
                    dir = "❌Long / ✅Short";
                }

                var stop_loss = positions.result[i].data.stop_loss;
                var take_profit = positions.result[i].data.take_profit;
                var price = positions.result[i].data.entry_price;
                var fee = positions.result[i].data.occ_closing_fee;
                var price = price.toFixed(4);
                //calulate size in USDT
                var usdValue = (positions.result[i].data.entry_price * size) / process.env.LEVERAGE;
                var position = {
                    "symbol": symbol,
                    "size": size,
                    "side": dir,
                    "sizeUSD": usdValue.toFixed(3),
                    "pnl": pnl,
                    "liq": liq,
                    "price": price,
                    "stop_loss": stop_loss,
                    "take_profit": take_profit,
                    "iso": ios,
                    "test": test,
                    "fee": fee.toFixed(3)
                }
                positionList.push(position);
            }
        }

        const embed = new MessageBuilder()
            .setTitle("```"+'---------------------------Bot Report---------------------------'+"```")
            .addField('Balance: ', "```autohotkey"+'\n'+balance.toString()+"```", true)
            .addField('Leverage: ', "```autohotkey"+'\n'+process.env.LEVERAGE.toString()+"```", true)
            //.addField('Version: ', version.commit.toString(), true)
            .addField('Total USDT in Posi: ', "```autohotkey"+'\n'+marg.toFixed(2).toString()+"```", true)
            .addField('Profit USDT: ', "```autohotkey"+'\n'+diff.toString()+"```", true)
            .addField('Profit %: ', "```autohotkey"+'\n'+percentGain.toString()+"```"+'\n', true)
            .addField('Bot UpTime: ', "```autohotkey" + '\n' + times[0].toString() + " days " + times[1].toString() + " hr. " + times[2].toString() + " min. " + times[3].toString() + " sec." + "```", true)
            .addField('Server Time: ', "```autohotkey"+'\n'+time.toString()+"```", true)
            .addField("","",true)
            .addField("","",true)
            .setFooter('Open Positions: ' + openPositions.toString())
            //for each position in positionList add field only 7 fields per embed
            for(var i = 0; i < positionList.length; i++) {stop_loss
                embed.addField(positionList[i].symbol,'\n'
                +"```autohotkey"+'\n'
                +"Isolated: " + positionList[i].iso +'\n'
                +"Closing Fee: " + positionList[i].fee +'\n'
                +"Size: " + positionList[i].size +'\n'
                +"Value in $: " + positionList[i].sizeUSD +'\n'
                + "PnL: " + positionList[i].pnl+'\n'+"```"
                +"```fix"+'\n'+ positionList[i].side+"```"
                +"```autohotkey"+'\n'
                +"Price: " + positionList[i].test +'\n'
                + "Entry Price: " + positionList[i].price+'\n'
                + "Stop Loss: " + positionList[i].stop_loss+'\n'
                + "Take Profit: " + positionList[i].take_profit+'\n'
                + "Liq Price: " + positionList[i].liq+"```", true);
            }
            //purple color
            embed.setColor('#9966cc')
            .setTimestamp();
        try {
			if (process.env.SPLIT_DISCORD_LOG_AND_REPORT == "true") {
				reporthook.send(embed);
			}else{
				hook.send(embed);
			}
        }
        catch (err) {
            logIT(chalk.red("Discord Webhook Error"));
        }
    }
}

async function applyFilters(pairs) {
  let i = 0;
  let filtered = [];
  for(let i = 0; i < pairs.length; i++){
    let sym = pairs[i];

    if (parseInt(env.FILTER_MIN_LISTING_DAYS) != 0) {
      const wasListed = await checkListingDate(sym, parseInt(env.FILTER_MIN_LISTING_DAYS));
      if (!wasListed) {
        logIT(`applyFilters - discard symbol ${sym} as it's not listed at list from ${env.FILTER_MIN_LISTING_DAYS} days`);
        filtered.push({symbol: sym, reason: "FILTER_MIN_LISTING_DAYS"});
      }
    }

    if (i%50 == 0) // rate limit to 100 request per second (limit is 120 x 5 sec)
      await sleep(1000);
  }

  return filtered;
}

async function main() {
    let initDone = false;

    //logIT("Starting Lick Hunter!");
    logIT("Starting Lick Hunter!");
    runningStatus = runningStatus_RUN;
    reportWebhook();
    try{
        pairs = await getSymbols();

        // set globally filtered pairs
        let tmpFilters = await applyFilters(pairs.map(el => el.split(".")[1]));
        if (tmpFilters.length > 0) {
          logIT(`filteredPairs ${JSON.stringify(tmpFilters)}`);
          filteredPairs = tmpFilters;
          // TODO: filter disabled symbols from wssocket
        }
        // set initDone to true anyway but force the main loop to wait for filters initialization.
        if (tmpFilters.length >= 0 )
          initDone = true;

        //load local file acccount.json with out require and see if "config_set" is true
        var account = JSON.parse(fs.readFileSync('account.json', 'utf8'));
        if (account.config_set == false) {
            var isSet = await setPositionMode();
            if (isSet == true) {
                //set to true and save
                account.config_set = true;
                fs.writeFileSync('account.json', JSON.stringify(account));
            }

        }

        if(process.env.UPDATE_MIN_ORDER_SIZING == "true") {
            await getMinTradingSize();
        }
        if (process.env.USE_SMART_SETTINGS.toLowerCase() == "true") {
            logIT("Updating settings.json with smart settings");
            await createSettings();
        }

        // Only needed with DCA_AVERAGE_ENTRIES features on.
        // Check if there are orphan limit orders created by DCA.
        // Happens when the trade was closed when the app is not running.
        if (process.env.USE_DCA_FEATURE == "true" && process.env.DCA_TYPE == "DCA_AVERAGE_ENTRIES") {
          const openPositionList = await checkOpenPositions();
          const newOrders = await getNewOrders();
          await closeOrphanOrders(openPositionList, newOrders);
        }

    }
    catch (err) {
        logIT(chalk.red("Error in main()"));

        if (process.env.USE_DISCORD == "true")
            messageWebhook(err);

        await sleep(10000);
    }

    await liquidationEngine(pairs);

    // place orders loop
    let tradeFunction = undefined;
    setInterval( async () => {
      if (tradeOrdersQueue.length > 0 && tradeFunction === undefined) {
        // dequeue and execute first order
        tradeFunction = tradeOrdersQueue.shift();
        await tradeFunction.fn();
        tradeFunction = undefined;
      }
    }, 100);

    // start main loop when the initialization is completed
    while (initDone) {
        try {
            linearClient.invalidateCache();
            await checkOpenPositions();
            await getBalance();
            await updateSettings();

            await sleep(linearClient.getRateLimit());
        } catch (e) {
            console.log(e);
            sleep(1000);
        }
    }
}

// check for updates since first use
function getLastDeploymentDateTime() {
    return new Promise((resolve, reject) => {
      fs.readFile("deployment", 'utf8', (error, data) => {
        if (error) {
          reject(error);
        } else {
          const dateTime = new Date(data.trim());
          resolve(dateTime);
        }
      });
    });
}

function updateLastDeploymentDateTime(dateTime) {
    fs.writeFile("deployment", dateTime.toISOString(), (error) => {
        if (error) {
            console.error(error);
        } else {
            console.log('Updated last change: ', dateTime.toLocaleString());
        }
    });
}

function minuspercent(wert, per) {
	var w = parseFloat(wert)
	var r = (w / 100) * per;
	var er = w - (r / process.env.LEVERAGE)

	return er;
}

function pluspercent(wert, per) {
	var w = parseFloat(wert)
	var r = (w / 100) * per;
	var er = w + (r / process.env.LEVERAGE)

	return er;
}

async function checkForUpdates() {
    const lastDeploymentDateTime = await getLastDeploymentDateTime();
    const options = {
      hostname: 'api.github.com',
      path: `/repos/CryptoGnome/Bybit-Lick-Hunter-v4/commits?since=${lastDeploymentDateTime.toISOString()}`,
      headers: {
        'User-Agent': 'Node.js'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        const commits = JSON.parse(data);
        if (commits.length > 0) {
          logIT(chalk.red(`There is a new update available!` + 'https://github.com/CryptoGnome/Bybit-Lick-Hunter-v4'));
        } else {
          logIT(chalk.green('You are on the newest version of Lick-Hunter!'));
        }
      });
    });

    req.on('error', (error) => {
      logIT(error);
    });

    req.end();
  }

// check for config changes, and update it
fs.watchFile('.env', (curr, prev) => {
    logIT("Config has changed!");
    var newEnv = dotenv.parse(fs.readFileSync('.env'));

    for (const key in newEnv) {
      process.env[key] = newEnv[key];
    }

    dotenv.config();
    getSettings()
});

// change the .env the right way
function changeENV(variable, value) {
    const env = dotenv.parse(fs.readFileSync('.env'));
    env[variable] = value;
    const envString = Object.keys(env).map(key => `${key}=${env[key]}`).join('\n');
    fs.writeFileSync('.env', envString);

    dotenv.config();
}

// get settings and send to gui
function getSettings(){
    const env = dotenv.parse(fs.readFileSync('.env'));
    const json = {};

    for (const key in env) {
        json[key] = process.env[key];
    }

    io.sockets.emit("settings", json);
}

try {
    main();
}
catch (error) {
    logIT(chalk.red("Error: ", error));

    if (process.env.USE_DISCORD == "true")
        messageWebhook(error);

    main();
}

//  Copyright (C)2022 - Alessandro Arrabito - <arrabitoster@gmail.com> - Strambatax on TradingView
//  @class LinearClient
//  ByBit linear client decorator

import { RestClientV5 } from 'bybit-api';

const baseRateLimit = 2000;

export class LinearClient {

  constructor(params) {

    //create linear client
    this.linearClient = new RestClientV5({
      key: params.key,
      secret: params.secret,
      testnet: params.testnet,
    });

    this.requestsCache = new Map();
    this.rateLimit = baseRateLimit;
  }

  getRateLimit() {
    return this.rateLimit;
  }

  updateRateLimit(resp) {
    if (resp.retCode != 0) {
      return false;
    }

    //check rateLimitStatus
    if (resp.rateLimitStatus) {
      //check rateLimitStatus
      if (resp.rateLimitStatus > 100) {
        this.rateLimit = baseRateLimit;
        logIT("Rate limit status: " + chalk.green(resp.rateLimitStatus));
      }
      else if (resp.rateLimitStatus > 75) {
        this.rateLimit += 500;
        logIT("Rate limit status: " + chalk.greenBright(resp.rateLimitStatus));
      }
      else if (resp.rateLimitStatus > 50) {
        this.rateLimit +=  1000;
        logIT("Rate limit status: " + chalk.yellowBright(resp.rateLimitStatus));
      }
      else if (resp.rateLimitStatus > 25) {
        this.rateLimit +=  2000;
        logIT("Rate limit status: " + chalk.yellow(resp.rateLimitStatus));
      }
      else {
        this.rateLimit +=  4000;
        logIT("Rate limit status: " + chalk.red(resp.rateLimitStatus));
      }
    }
    return true;
  }

  async runAndCache(method, params, methodKey, getCachedValue) {
    let res = undefined;
    if (getCachedValue) {
      res = this.requestsCache.get(methodKey); // if not exists return undefined
    }

    if (res == undefined) {
      res = await method.call(this.linearClient, {category: 'linear', ...params});
        if (res.retCode == 0) {
        this.requestsCache.set(methodKey, res);
        this.updateRateLimit(res)
      }
    }

    return res;
  }

  invalidateCache() {
    this.requestsCache.clear();
  }

  async fetchServerTime() {
    return await this.linearClient.fetchServerTime();
  }

  async setTradingStop(params) {
    return await this.linearClient.setTradingStop({...params, category: 'linear'});
  }

  async getTickers(params = {}, getCachedValue = false) {
    return await this.runAndCache(this.linearClient.getTickers, params, "getTickers", getCachedValue);
  }

  async createMarketOrder(params) {
    return await this.linearClient.createMarketOrder({category: 'linear', ...params});
  }

  async setLeverage(params) {
    return await this.linearClient.setLeverage({category: 'linear', ...params});
  }

  async setMarginSwitch(params) {
    return await this.linearClient.setMarginSwitch({category: 'linear', ...params});
  }

  async switchPositionMode(params) {
    return await this.linearClient.switchPositionMode({category: 'linear', ...params});
  }

  async getInstrumentsInfo(params = {}, getCachedValue = false) {
    return await this.runAndCache(this.linearClient.getInstrumentsInfo, params, "getInstrumentsInfo", getCachedValue);
  }

  async getWalletBalance(params = {}, getCachedValue = false) {
    let res = {}
    let response = await this.runAndCache(this.linearClient.getWalletBalance, params, "getWalletBalance", getCachedValue);

    // TODO: remap fields in another place not here
    if (response.retCode == 0) {
      const wallet = response.result.list[0].coin[0];
      res= {
        availableBalance: parseFloat(wallet.availableToWithdraw),
        usedMargin: parseFloat(wallet.totalPositionIM),
        wholeBalance: parseFloat(wallet.availableToWithdraw) + parseFloat(wallet.totalPositionIM)
      };
    }

    return res;
  }

  async getPositionInfo(params = {}, getCachedValue = false) {
    return await this.runAndCache(this.linearClient.getPositionInfo, params, "getPositionInfo", getCachedValue);
  }

  async getPosition(params = {}, getCachedValue = false) {
    return await this.runAndCache(this.linearClient.getPosition, params, "getPosition", getCachedValue);
  }

  async getHistoricOrders(params = {}, getCachedValue = false) {
    return await this.runAndCache(this.linearClient.getHistoricOrders, params, "getHistoricOrders", getCachedValue);
  }
}
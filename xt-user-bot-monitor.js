import crypto from 'crypto';
import xtTelegramService from './xt-telegram-service.js';
import { generateXtSignature, buildSignatureMessage, getXtTimestamp, syncXtServerTime } from './xt-user-routes.js';

const XT_BASE_URL = process.env.XT_BASE_URL || 'https://sapi.xt.com';

class XtUserBotMonitor {
  constructor(db) {
    this.db = db;
    this.isRunning = false;
    this.checkInterval = null;
    this.logs = [];
    this.maxLogs = 500;
    this.marketData = {};
    this.processingBots = new Set();
  }

  log(type, message, data = null) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      type,
      message,
      data
    };
    this.logs.unshift(logEntry);
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(0, this.maxLogs);
    }
    const emoji = type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warning' ? '⚠️' : type === 'trade' ? '💱' : 'ℹ️';
    console.log(`${emoji} [XtUserBot] ${message}`, data ? JSON.stringify(data) : '');
  }

  async start() {
    if (this.isRunning) {
      this.log('warning', 'XT User Bot monitor already running');
      return;
    }

    this.isRunning = true;
    this.log('success', 'XT User Bot monitor started');

    // Check every 3 seconds
    this.checkInterval = setInterval(() => this.checkAllUserBots(), 3000);
    
    // Initial check
    await this.checkAllUserBots();
  }

  async stop() {
    if (!this.isRunning) {
      this.log('warning', 'XT User Bot monitor not running');
      return;
    }

    this.isRunning = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.log('info', 'XT User Bot monitor stopped');
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      marketData: this.marketData
    };
  }

  getLogs(limit = 100) {
    return this.logs.slice(0, limit);
  }

  // Helper to make authenticated XT API requests with retry logic
  async makeXtRequest(apiKey, apiSecret, method, path, queryParams = '', body = null, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const timestamp = await getXtTimestamp();
        
        const headers = {
          'validate-algorithms': 'HmacSHA256',
          'validate-appkey': apiKey,
          'validate-recvwindow': '5000',
          'validate-timestamp': timestamp
        };

        const bodyJson = body ? JSON.stringify(body) : '';
        const original = buildSignatureMessage(method, path, queryParams, bodyJson, headers);
        const signature = generateXtSignature(apiSecret, original);

        const url = queryParams ? `${XT_BASE_URL}${path}?${queryParams}` : `${XT_BASE_URL}${path}`;

        const fetchOptions = {
          method,
          headers: {
            'Content-Type': 'application/json',
            'validate-algorithms': 'HmacSHA256',
            'validate-appkey': apiKey,
            'validate-recvwindow': '5000',
            'validate-timestamp': timestamp,
            'validate-signature': signature
          }
        };

        if (body && (method === 'POST' || method === 'PUT' || method === 'DELETE')) {
          fetchOptions.body = bodyJson;
        }

        const response = await fetch(url, fetchOptions);
        const data = await response.json();
        
        // Retry on time-related auth errors
        if ((data.mc === 'AUTH_104' || data.mc === 'AUTH_105') && attempt < maxRetries) {
          this.log('warning', `XT API error ${data.mc}, resyncing time and retrying (attempt ${attempt}/${maxRetries})`);
          await syncXtServerTime();
          continue;
        }
        
        return data;
      } catch (error) {
        if (attempt < maxRetries) {
          this.log('warning', `XT API request error, retrying (attempt ${attempt}/${maxRetries}): ${error.message}`);
          await syncXtServerTime();
          continue;
        }
        throw error;
      }
    }
  }

  async getMarketPrice(symbol = 'gcb_usdt') {
    try {
      const response = await fetch(`${XT_BASE_URL}/v4/public/ticker/price?symbol=${symbol}`);
      const data = await response.json();
      if (data.rc === 0 && data.result && data.result.length > 0) {
        const price = parseFloat(data.result[0].p);
        this.marketData[symbol] = { price, updatedAt: new Date().toISOString() };
        return price;
      }
      return null;
    } catch (error) {
      this.log('error', `Failed to fetch XT market price: ${error.message}`);
      return null;
    }
  }

  async getBestAskPrice(symbol = 'gcb_usdt') {
    try {
      const response = await fetch(`${XT_BASE_URL}/v4/public/depth?symbol=${symbol}&limit=5`);
      const data = await response.json();
      
      if (data.rc === 0 && data.result && data.result.asks && data.result.asks.length > 0) {
        const bestAskPrice = parseFloat(data.result.asks[0][0]);
        return bestAskPrice;
      }
      return null;
    } catch (error) {
      this.log('error', `Failed to fetch XT order book: ${error.message}`);
      return null;
    }
  }

  async getUserCredentials(mexcUserId) {
    try {
      const xtUser = await this.db.collection('xt_users').findOne({ mexcUserId });

      if (!xtUser) {
        return null;
      }

      return {
        apiKey: xtUser.apiKey,
        apiSecret: xtUser.apiSecret
      };
    } catch (error) {
      this.log('error', `Error getting XT user credentials: ${error.message}`);
      return null;
    }
  }

  async getAccountBalance(apiKey, apiSecret) {
    try {
      const data = await this.makeXtRequest(apiKey, apiSecret, 'GET', '/v4/balances', 'currencies=usdt,gcb');
      
      if (data.rc === 0 && data.result?.assets) {
        const balanceMap = {};
        data.result.assets.forEach(asset => {
          balanceMap[asset.currency.toLowerCase()] = {
            availableAmount: asset.availableAmount,
            frozenAmount: asset.frozenAmount,
            totalAmount: asset.totalAmount
          };
        });
        return balanceMap;
      }
      return null;
    } catch (error) {
      this.log('error', `Failed to fetch XT account balance: ${error.message}`);
      return null;
    }
  }

  async placeMarketBuyOrder(apiKey, apiSecret, symbol, quoteQty) {
    try {
      const orderBody = {
        symbol: symbol.toLowerCase(),
        side: 'BUY',
        type: 'MARKET',
        timeInForce: 'IOC',
        bizType: 'SPOT',
        quoteQty: quoteQty
      };

      this.log('info', `📤 XT Order: BUY MARKET ${symbol} - quoteQty: ${quoteQty} USDT`);

      const data = await this.makeXtRequest(apiKey, apiSecret, 'POST', '/v4/order', '', orderBody);

      if (data.rc === 0 && data.result?.orderId) {
        this.log('success', `XT Market buy order placed: ${quoteQty} USDT`, {
          orderId: data.result.orderId,
          quoteQty: quoteQty
        });
        return data.result;
      } else {
        this.log('error', `Failed to place XT market buy order`, data);
        return null;
      }
    } catch (error) {
      this.log('error', `Error placing XT market buy order: ${error.message}`);
      return null;
    }
  }

  async checkAllUserBots() {
    if (!this.isRunning) return;

    try {
      // Find all active user bots
      const activeBots = await this.db.collection('xt_user_bots').find({
        isActive: true,
        isRunning: true
      }).toArray();

      if (activeBots.length === 0) {
        return;
      }

      this.log('info', `🔍 Checking ${activeBots.length} active XT user bot(s)`);

      for (const bot of activeBots) {
        await this.checkBot(bot);
      }
    } catch (error) {
      this.log('error', 'Error checking XT user bots', error.message);
    }
  }

  async checkBot(bot) {
    const botId = bot._id.toString();

    // Prevent duplicate processing
    if (this.processingBots.has(botId)) {
      return;
    }
    this.processingBots.add(botId);

    try {
      const symbol = bot.symbol || 'gcb_usdt';
      
      // Get user credentials
      const credentials = await this.getUserCredentials(bot.mexcUserId);
      if (!credentials) {
        this.log('warning', `[${bot.name}] XT credentials not found`);
        return;
      }

      // Re-fetch bot from DB to get fresh lastExecutedAt
      const freshBot = await this.db.collection('xt_user_bots').findOne({ _id: bot._id });
      if (!freshBot || !freshBot.isRunning) {
        return;
      }

      // Check cooldown FIRST
      const cooldownMs = (freshBot.cooldownSeconds || 10) * 1000;
      const lastExecuted = freshBot.lastExecutedAt ? new Date(freshBot.lastExecutedAt).getTime() : 0;
      const now = Date.now();

      if (now - lastExecuted < cooldownMs) {
        const remaining = Math.ceil((cooldownMs - (now - lastExecuted)) / 1000);
        this.log('info', `[${bot.name}] ⏳ Cooldown active (${remaining}s remaining)`);
        return;
      }
      
      // Get current market price
      const marketPrice = await this.getMarketPrice(symbol);
      if (!marketPrice) {
        this.log('warning', `[${bot.name}] Could not fetch market price`);
        return;
      }

      // Get best ask price
      const bestAskPrice = await this.getBestAskPrice(symbol);
      if (!bestAskPrice) {
        this.log('warning', `[${bot.name}] Could not fetch best ask price`);
        return;
      }

      // Calculate price gap
      const priceGap = ((bestAskPrice - marketPrice) / marketPrice) * 100;

      // Update bot with latest prices
      await this.db.collection('xt_user_bots').updateOne(
        { _id: bot._id },
        { 
          $set: { 
            lastMarketPrice: marketPrice,
            lastBestAskPrice: bestAskPrice,
            lastPriceGap: priceGap,
            lastCheckedAt: new Date(),
            updatedAt: new Date()
          } 
        }
      );

      this.log('info', `[${bot.name}] 📊 Market: $${marketPrice.toFixed(6)} | Best Ask: $${bestAskPrice.toFixed(6)} | Gap: ${priceGap.toFixed(2)}%`);

      // Check if price gap is >= threshold
      const gapThreshold = freshBot.gapThreshold || 3;
      
      if (priceGap >= gapThreshold) {
        this.log('info', `[${bot.name}] 🚨 Price gap ${priceGap.toFixed(2)}% >= ${gapThreshold}% threshold!`);

        // Check USDT balance
        const orderAmount = freshBot.orderAmount || 1;
        const balances = await this.getAccountBalance(credentials.apiKey, credentials.apiSecret);
        const availableUsdt = balances?.usdt ? parseFloat(balances.usdt.availableAmount) : 0;

        if (availableUsdt < orderAmount) {
          this.log('warning', `[${bot.name}] ⚠️ Insufficient USDT balance: ${availableUsdt.toFixed(2)} < ${orderAmount}`);
          
          // Send low balance warning to Balance bot
          if (freshBot.telegramEnabled) {
            try {
              const gcbBalance = balances?.gcb ? parseFloat(balances.gcb.availableAmount) : 0;
              await xtTelegramService.checkAndNotifyLowBalance({
                botName: bot.name,
                userId: bot.mexcUserId,
                usdtBalance: availableUsdt,
                gcbBalance: gcbBalance,
                symbol: symbol
              });
            } catch (err) {
              this.log('warning', 'Balance warning notification failed', err.message);
            }
          }
          return;
        }

        // Place market buy order
        const result = await this.placeMarketBuyOrder(
          credentials.apiKey, 
          credentials.apiSecret, 
          symbol, 
          orderAmount
        );

        if (result) {
          // Update bot stats
          await this.db.collection('xt_user_bots').updateOne(
            { _id: bot._id },
            { 
              $set: { 
                lastExecutedAt: new Date(),
                updatedAt: new Date()
              },
              $inc: {
                executionCount: 1,
                totalUsdtSpent: orderAmount
              }
            }
          );

          // Log the trade
          await this.db.collection('xt_user_bot_logs').insertOne({
            mexcUserId: bot.mexcUserId,
            botId: botId,
            botName: bot.name,
            action: 'BUY',
            symbol: symbol,
            amount: orderAmount,
            marketPrice: marketPrice,
            bestAskPrice: bestAskPrice,
            priceGap: priceGap,
            orderId: result.orderId,
            status: 'SUCCESS',
            message: `Placed market buy for $${orderAmount} USDT (gap: ${priceGap.toFixed(2)}%)`,
            createdAt: new Date()
          });

          this.log('success', `[${bot.name}] ✅ Executed order: $${orderAmount} USDT (gap: ${priceGap.toFixed(2)}%)`);

          // Send Telegram notification if enabled (uses XT-specific bot)
          if (freshBot.telegramEnabled) {
            try {
              const tgBalances = await this.getAccountBalance(credentials.apiKey, credentials.apiSecret);
              
              // Send order notification to XT bot
              await xtTelegramService.notifyXtUserBotOrder({
                botName: bot.name,
                symbol: symbol,
                orderAmount: orderAmount,
                marketPrice: marketPrice,
                bestAskPrice: bestAskPrice,
                priceGap: priceGap,
                balances: tgBalances,
                orderId: result.orderId,
                status: 'success'
              });

              // Check for low balance and send warning to Balance bot
              const usdtBalance = tgBalances?.usdt ? parseFloat(tgBalances.usdt.availableAmount) : 0;
              const gcbBalance = tgBalances?.gcb ? parseFloat(tgBalances.gcb.availableAmount) : 0;
              
              await xtTelegramService.checkAndNotifyLowBalance({
                botName: bot.name,
                userId: bot.mexcUserId,
                usdtBalance: usdtBalance,
                gcbBalance: gcbBalance,
                symbol: symbol
              });
            } catch (err) {
              this.log('warning', 'Telegram notification failed', err.message);
            }
          }
        } else {
          // Log failed attempt
          await this.db.collection('xt_user_bot_logs').insertOne({
            mexcUserId: bot.mexcUserId,
            botId: botId,
            botName: bot.name,
            action: 'BUY',
            symbol: symbol,
            amount: orderAmount,
            marketPrice: marketPrice,
            bestAskPrice: bestAskPrice,
            priceGap: priceGap,
            status: 'FAILED',
            message: 'Failed to place market buy order',
            createdAt: new Date()
          });
        }
      } else {
        this.log('info', `[${bot.name}] ✅ Gap ${priceGap.toFixed(2)}% < ${gapThreshold}% - no action`);
      }
    } catch (error) {
      this.log('error', `[${bot.name}] Error: ${error.message}`);
    } finally {
      this.processingBots.delete(botId);
    }
  }
}

export default XtUserBotMonitor;

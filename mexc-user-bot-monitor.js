import crypto from 'crypto';
import mexcTelegramService from './mexc-telegram-service.js';

const MEXC_BASE_URL = process.env.MEXC_BASE_URL || 'https://api.mexc.com';

class MexcUserBotMonitor {
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
    console.log(`${emoji} [MexcUserBot] ${message}`, data ? JSON.stringify(data) : '');
  }

  async start() {
    if (this.isRunning) {
      this.log('warning', 'MEXC User Bot monitor already running');
      return;
    }

    this.isRunning = true;
    this.log('success', 'MEXC User Bot monitor started');

    // Check every 3 seconds
    this.checkInterval = setInterval(() => this.checkAllUserBots(), 3000);
    
    // Initial check
    await this.checkAllUserBots();
  }

  async stop() {
    if (!this.isRunning) {
      this.log('warning', 'MEXC User Bot monitor not running');
      return;
    }

    this.isRunning = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.log('info', 'MEXC User Bot monitor stopped');
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

  generateMexcSignature(queryString, apiSecret) {
    return crypto
      .createHmac('sha256', apiSecret)
      .update(queryString)
      .digest('hex');
  }

  async getMarketPrice(symbol = 'GCBUSDT') {
    try {
      const response = await fetch(`${MEXC_BASE_URL}/api/v3/ticker/price?symbol=${symbol}`);
      const data = await response.json();
      if (data && data.price) {
        const price = parseFloat(data.price);
        this.marketData[symbol] = { price, updatedAt: new Date().toISOString() };
        return price;
      }
      return null;
    } catch (error) {
      this.log('error', `Failed to fetch MEXC market price: ${error.message}`);
      return null;
    }
  }

  async getBestAskPrice(symbol = 'GCBUSDT') {
    try {
      const response = await fetch(`${MEXC_BASE_URL}/api/v3/depth?symbol=${symbol}&limit=5`);
      const data = await response.json();
      
      if (data && data.asks && data.asks.length > 0) {
        const bestAskPrice = parseFloat(data.asks[0][0]);
        return bestAskPrice;
      }
      return null;
    } catch (error) {
      this.log('error', `Failed to fetch MEXC order book: ${error.message}`);
      return null;
    }
  }

  async getUserCredentials(userId) {
    try {
      const { ObjectId } = await import('mongodb');
      const user = await this.db.collection('mexc_users').findOne({ 
        _id: new ObjectId(userId) 
      });

      if (!user) {
        return null;
      }

      return {
        apiKey: user.apiKey,
        apiSecret: user.apiSecret
      };
    } catch (error) {
      this.log('error', `Error getting user credentials: ${error.message}`);
      return null;
    }
  }

  async getAccountBalance(apiKey, apiSecret) {
    try {
      const timestamp = Date.now();
      const queryString = `timestamp=${timestamp}`;
      const signature = this.generateMexcSignature(queryString, apiSecret);

      const response = await fetch(`${MEXC_BASE_URL}/api/v3/account?${queryString}&signature=${signature}`, {
        method: 'GET',
        headers: {
          'X-MEXC-APIKEY': apiKey,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      
      if (data.balances) {
        const balanceMap = {};
        data.balances.forEach(balance => {
          balanceMap[balance.asset] = {
            free: balance.free,
            locked: balance.locked
          };
        });
        return balanceMap;
      }
      return null;
    } catch (error) {
      this.log('error', `Failed to fetch account balance: ${error.message}`);
      return null;
    }
  }

  async placeMarketBuyOrder(apiKey, apiSecret, symbol, quoteOrderQty) {
    try {
      const timestamp = Date.now();
      const queryParams = `symbol=${symbol}&side=BUY&type=MARKET&quoteOrderQty=${quoteOrderQty}&timestamp=${timestamp}`;
      const signature = this.generateMexcSignature(queryParams, apiSecret);

      this.log('info', `📤 MEXC Order: BUY MARKET ${symbol} - quoteOrderQty: ${quoteOrderQty} USDT`);

      const response = await fetch(`${MEXC_BASE_URL}/api/v3/order?${queryParams}&signature=${signature}`, {
        method: 'POST',
        headers: {
          'X-MEXC-APIKEY': apiKey,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();

      if (data.orderId) {
        this.log('success', `MEXC Market buy order placed: ${quoteOrderQty} USDT`, {
          orderId: data.orderId,
          quoteOrderQty: quoteOrderQty
        });
        return data;
      } else {
        this.log('error', `Failed to place MEXC market buy order`, data);
        return null;
      }
    } catch (error) {
      this.log('error', `Error placing MEXC market buy order: ${error.message}`);
      return null;
    }
  }

  async checkAllUserBots() {
    if (!this.isRunning) return;

    try {
      // Find all active user bots
      const activeBots = await this.db.collection('mexc_user_bots').find({
        isActive: true,
        isRunning: true
      }).toArray();

      if (activeBots.length === 0) {
        return;
      }

      this.log('info', `🔍 Checking ${activeBots.length} active user bot(s)`);

      for (const bot of activeBots) {
        await this.checkBot(bot);
      }
    } catch (error) {
      this.log('error', 'Error checking user bots', error.message);
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
      const symbol = bot.symbol || 'GCBUSDT';
      
      // Get user credentials
      const credentials = await this.getUserCredentials(bot.userId);
      if (!credentials) {
        this.log('warning', `[${bot.name}] User credentials not found`);
        return;
      }

      // Re-fetch bot from DB to get fresh lastExecutedAt
      const freshBot = await this.db.collection('mexc_user_bots').findOne({ _id: bot._id });
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
      await this.db.collection('mexc_user_bots').updateOne(
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
        const availableUsdt = balances?.USDT ? parseFloat(balances.USDT.free) : 0;

        if (availableUsdt < orderAmount) {
          this.log('warning', `[${bot.name}] ⚠️ Insufficient USDT balance: ${availableUsdt.toFixed(2)} < ${orderAmount}`);
          
          // Send low balance warning to Balance bot
          if (freshBot.telegramEnabled) {
            try {
              const gcbBalance = balances?.GCB ? parseFloat(balances.GCB.free) : 0;
              await mexcTelegramService.checkAndNotifyLowBalance({
                botName: bot.name,
                userId: bot.userId,
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
          await this.db.collection('mexc_user_bots').updateOne(
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
          await this.db.collection('mexc_user_bot_logs').insertOne({
            userId: bot.userId,
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

          // Send Telegram notification if enabled (uses MEXC-specific bot)
          if (freshBot.telegramEnabled) {
            try {
              const tgBalances = await this.getAccountBalance(credentials.apiKey, credentials.apiSecret);
              
              // Send order notification to MEXC bot
              await mexcTelegramService.notifyMexcUserBotOrder({
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
              const usdtBalance = tgBalances?.USDT ? parseFloat(tgBalances.USDT.free) : 0;
              const gcbBalance = tgBalances?.GCB ? parseFloat(tgBalances.GCB.free) : 0;
              
              await mexcTelegramService.checkAndNotifyLowBalance({
                botName: bot.name,
                userId: bot.userId,
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
          await this.db.collection('mexc_user_bot_logs').insertOne({
            userId: bot.userId,
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

export default MexcUserBotMonitor;

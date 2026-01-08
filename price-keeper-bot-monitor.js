import crypto from 'crypto';
import telegramService from './telegram-service.js';

const GCBEX_OPEN_API_BASE = process.env.GCBEX_OPEN_API_BASE || 'https://openapi.gcbex.com';

class PriceKeeperBotMonitor {
  constructor(db) {
    this.db = db;
    this.isRunning = false;
    this.checkInterval = null;
    this.logs = [];
    this.maxLogs = 500;
    this.marketData = {};
    this.processingBots = new Set(); // In-memory lock to prevent duplicate processing
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
    console.log(`${emoji} [PriceKeeperBot] ${message}`, data ? JSON.stringify(data) : '');
  }

  async start() {
    if (this.isRunning) {
      this.log('warning', 'Price Keeper Bot monitor already running');
      return;
    }

    this.isRunning = true;
    this.log('success', 'Price Keeper Bot monitor started');

    // Check every 3 seconds for quick response
    this.checkInterval = setInterval(() => this.checkPriceKeeperBots(), 3000);
    
    // Initial check
    await this.checkPriceKeeperBots();
  }

  async stop() {
    if (!this.isRunning) {
      this.log('warning', 'Price Keeper Bot monitor not running');
      return;
    }

    this.isRunning = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.log('info', 'Price Keeper Bot monitor stopped');
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

  generateSignature(timestamp, method, requestPath, body, apiSecret) {
    const message = body 
      ? `${timestamp}${method.toUpperCase()}${requestPath}${body}`
      : `${timestamp}${method.toUpperCase()}${requestPath}`;
    return crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
  }

  async getServerTime() {
    try {
      const response = await fetch(`${GCBEX_OPEN_API_BASE}/sapi/v2/time`);
      const data = await response.json();
      return data.serverTime;
    } catch (error) {
      this.log('warning', 'Failed to fetch server time, using local time', error.message);
      return Date.now();
    }
  }

  async getMarketPrice(symbol = 'GCBUSDT') {
    try {
      const response = await fetch(`${GCBEX_OPEN_API_BASE}/sapi/v2/ticker?symbol=${symbol.toLowerCase()}`);
      const data = await response.json();
      if (data && data.last) {
        const price = parseFloat(data.last);
        this.marketData[symbol] = { price, updatedAt: new Date().toISOString() };
        return price;
      }
      return null;
    } catch (error) {
      this.log('error', `Failed to fetch market price: ${error.message}`);
      return null;
    }
  }

  async getBestAskPrice(symbol = 'GCBUSDT') {
    try {
      const response = await fetch(`${GCBEX_OPEN_API_BASE}/sapi/v2/depth?symbol=${symbol.toLowerCase()}&limit=5`);
      const data = await response.json();
      
      if (data && data.asks && data.asks.length > 0) {
        // asks[0][0] is the best (lowest) ask price
        const bestAskPrice = parseFloat(data.asks[0][0]);
        return bestAskPrice;
      }
      return null;
    } catch (error) {
      this.log('error', `Failed to fetch order book: ${error.message}`);
      return null;
    }
  }

  async getSymbolInfo(symbol = 'GCBUSDT') {
    try {
      const response = await fetch(`${GCBEX_OPEN_API_BASE}/sapi/v2/symbols`);
      const data = await response.json();
      
      if (data && data.symbols) {
        const symbolInfo = data.symbols.find(s => s.symbol.toUpperCase() === symbol.toUpperCase());
        if (symbolInfo) {
          return {
            pricePrecision: symbolInfo.pricePrecision || 6,
            quantityPrecision: symbolInfo.quantityPrecision || 2,
            basePrecision: symbolInfo.basePrecision || 2,
            quotePrecision: symbolInfo.quotePrecision || 6
          };
        }
      }
      return { pricePrecision: 6, quantityPrecision: 2, basePrecision: 2, quotePrecision: 6 };
    } catch (error) {
      this.log('error', `Failed to fetch symbol info: ${error.message}`);
      return { pricePrecision: 6, quantityPrecision: 2, basePrecision: 2, quotePrecision: 6 };
    }
  }

  async placeMarketBuyOrder(user, symbol, usdtAmount, symbolInfo) {
    try {
      // For market buy, volume is the USDT amount to spend (quote currency)
      const quotePrecision = symbolInfo?.quotePrecision || 2;

      const orderBody = {
        symbol: symbol.toUpperCase(),
        side: 'BUY',
        type: 'MARKET',
        volume: usdtAmount.toFixed(quotePrecision)
      };

      const timestamp = (await this.getServerTime()).toString();
      const method = 'POST';
      const requestPath = '/sapi/v2/order';
      const bodyJson = JSON.stringify(orderBody);
      const signature = this.generateSignature(timestamp, method, requestPath, bodyJson, user.apiSecret);

      const response = await fetch(`${GCBEX_OPEN_API_BASE}${requestPath}`, {
        method: 'POST',
        headers: {
          'X-CH-APIKEY': user.apiKey,
          'X-CH-TS': timestamp,
          'X-CH-SIGN': signature,
          'Content-Type': 'application/json'
        },
        body: bodyJson
      });

      const data = await response.json();
      
      if (data.orderId || data.orderIdString) {
        this.log('success', `Market buy order placed: ${usdtAmount} USDT`, {
          orderId: data.orderIdString || data.orderId,
          volume: usdtAmount.toFixed(quotePrecision)
        });
        return data;
      } else {
        this.log('error', `Failed to place market buy order`, data);
        return null;
      }
    } catch (error) {
      this.log('error', `Error placing market buy order: ${error.message}`);
      return null;
    }
  }

  async checkPriceKeeperBots() {
    if (!this.isRunning) return;

    try {
      // Find all active price keeper bots
      const activeBots = await this.db.collection('price_keeper_bots').find({
        isActive: true,
        isRunning: true
      }).toArray();

      if (activeBots.length === 0) {
        return;
      }

      this.log('info', `🔍 Checking ${activeBots.length} active price keeper bot(s)`);

      for (const bot of activeBots) {
        await this.monitorAndKeepPrice(bot);
      }
    } catch (error) {
      this.log('error', 'Error checking price keeper bots', error.message);
    }
  }

  async monitorAndKeepPrice(bot) {
    const botId = bot._id.toString();

    // Prevent duplicate processing
    if (this.processingBots.has(botId)) {
      return;
    }

    try {
      // Get user credentials
      const user = await this.db.collection('users').findOne({
        uid: bot.userId,
        apiKey: { $exists: true },
        apiSecret: { $exists: true }
      });

      if (!user) {
        this.log('warning', `[${bot.name}] User not found or missing API credentials`);
        return;
      }

      const symbol = bot.symbol || 'GCBUSDT';
      
      // Get current market price (last trade price)
      const marketPrice = await this.getMarketPrice(symbol);
      if (!marketPrice) {
        this.log('warning', `[${bot.name}] Could not fetch market price`);
        return;
      }

      // Get best ask price (cheapest sell price)
      const bestAskPrice = await this.getBestAskPrice(symbol);
      if (!bestAskPrice) {
        this.log('warning', `[${bot.name}] Could not fetch best ask price`);
        return;
      }

      // Update bot with latest prices
      await this.db.collection('price_keeper_bots').updateOne(
        { _id: bot._id },
        { 
          $set: { 
            lastMarketPrice: marketPrice,
            lastBestAskPrice: bestAskPrice,
            lastCheckedAt: new Date(),
            updatedAt: new Date()
          } 
        }
      );

      // Log current prices
      this.log('info', `[${bot.name}] 📊 Market: $${marketPrice.toFixed(6)} | Best Ask: $${bestAskPrice.toFixed(6)}`, {
        marketPrice,
        bestAskPrice,
        botName: bot.name
      });

      // Check if prices differ
      // Use a small tolerance to avoid floating point issues
      const priceDifference = Math.abs(marketPrice - bestAskPrice);
      const tolerance = bestAskPrice * 0.0001; // 0.01% tolerance

      if (priceDifference > tolerance && marketPrice < bestAskPrice) {
        // Market price is below best ask - need to place a market buy to sync
        this.log('info', `[${bot.name}] Price mismatch detected! Market: $${marketPrice.toFixed(6)}, Best Ask: $${bestAskPrice.toFixed(6)}`);

        // Lock this bot
        this.processingBots.add(botId);

        try {
          // Check cooldown - don't place orders too frequently
          const cooldownMs = (bot.cooldownSeconds || 5) * 1000;
          const lastExecuted = bot.lastExecutedAt ? new Date(bot.lastExecutedAt).getTime() : 0;
          const now = Date.now();

          if (now - lastExecuted < cooldownMs) {
            this.log('info', `[${bot.name}] Cooldown active, skipping...`);
            return;
          }

          // Get symbol info for precision
          const symbolInfo = await this.getSymbolInfo(symbol);
          
          // Place small market buy order
          const orderAmount = bot.orderAmount || 0.1; // Default 0.1 USDT
          const result = await this.placeMarketBuyOrder(user, symbol, orderAmount, symbolInfo);

          if (result) {
            // Update bot stats
            await this.db.collection('price_keeper_bots').updateOne(
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
            await this.db.collection('price_keeper_bot_logs').insertOne({
              botId: botId,
              botName: bot.name,
              userId: bot.userId,
              action: 'BUY',
              symbol: symbol,
              amount: orderAmount,
              marketPrice: marketPrice,
              bestAskPrice: bestAskPrice,
              orderId: result.orderIdString || result.orderId,
              status: 'SUCCESS',
              message: `Placed market buy for $${orderAmount} to sync price`,
              createdAt: new Date()
            });

            this.log('success', `[${bot.name}] ✅ Executed price keeper order: $${orderAmount} USDT`);

            // Send Telegram notification
            try {
              const message = `<b>🎯 Price Keeper Bot Order</b>\n\n` +
                `🤖 <b>Bot:</b> ${bot.name}\n` +
                `💱 <b>Symbol:</b> ${symbol}\n` +
                `💵 <b>Order Amount:</b> $${orderAmount}\n` +
                `📊 <b>Market Price:</b> $${marketPrice.toFixed(6)}\n` +
                `🎯 <b>Best Ask:</b> $${bestAskPrice.toFixed(6)}\n` +
                `⏰ <b>Time (UTC):</b> ${new Date().toUTCString()}`;
              
              await telegramService.sendMessage(message);
            } catch (err) {
              this.log('warning', 'Telegram notification failed', err.message);
            }
          } else {
            // Log failed attempt
            await this.db.collection('price_keeper_bot_logs').insertOne({
              botId: botId,
              botName: bot.name,
              userId: bot.userId,
              action: 'BUY',
              symbol: symbol,
              amount: bot.orderAmount || 0.1,
              marketPrice: marketPrice,
              bestAskPrice: bestAskPrice,
              status: 'FAILED',
              message: 'Failed to place market buy order',
              createdAt: new Date()
            });
          }
        } finally {
          this.processingBots.delete(botId);
        }
      } else {
        // Prices are in sync
        this.log('info', `[${bot.name}] ✅ Prices in sync - no action needed`);
      }
    } catch (error) {
      this.log('error', `[${bot.name}] Error in price keeper: ${error.message}`);
      this.processingBots.delete(botId);
    }
  }
}

export default PriceKeeperBotMonitor;

import crypto from 'crypto';
import telegramService from './telegram-service.js';

const MEXC_BASE_URL = process.env.MEXC_BASE_URL || 'https://api.mexc.com';
const MEXC_API_KEY = process.env.MEXC_API_KEY;
const MEXC_API_SECRET = process.env.MEXC_API_SECRET;

class MexcMMBotMonitor {
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
    console.log(`${emoji} [MexcMMBot] ${message}`, data ? JSON.stringify(data) : '');
  }

  async start() {
    if (this.isRunning) {
      this.log('warning', 'MEXC MM Bot monitor already running');
      return;
    }

    this.isRunning = true;
    this.log('success', 'MEXC MM Bot monitor started');

    // Check every 3 seconds
    this.checkInterval = setInterval(() => this.checkMexcMMBots(), 3000);
    
    // Initial check
    await this.checkMexcMMBots();
  }

  async stop() {
    if (!this.isRunning) {
      this.log('warning', 'MEXC MM Bot monitor not running');
      return;
    }

    this.isRunning = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.log('info', 'MEXC MM Bot monitor stopped');
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

  generateMexcSignature(queryString) {
    return crypto
      .createHmac('sha256', MEXC_API_SECRET)
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
        // asks[0][0] is the best (lowest) ask price
        const bestAskPrice = parseFloat(data.asks[0][0]);
        return bestAskPrice;
      }
      return null;
    } catch (error) {
      this.log('error', `Failed to fetch MEXC order book: ${error.message}`);
      return null;
    }
  }

  async getAccountBalance() {
    try {
      if (!MEXC_API_KEY || !MEXC_API_SECRET) {
        this.log('error', 'MEXC API credentials not configured');
        return null;
      }

      const timestamp = Date.now();
      const queryString = `timestamp=${timestamp}`;
      const signature = this.generateMexcSignature(queryString);

      const response = await fetch(`${MEXC_BASE_URL}/api/v3/account?${queryString}&signature=${signature}`, {
        method: 'GET',
        headers: {
          'X-MEXC-APIKEY': MEXC_API_KEY,
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
      this.log('error', `Failed to fetch MEXC account balance: ${error.message}`);
      return null;
    }
  }

  async placeMarketBuyOrder(symbol, quoteOrderQty) {
    try {
      if (!MEXC_API_KEY || !MEXC_API_SECRET) {
        this.log('error', 'MEXC API credentials not configured');
        return null;
      }

      const timestamp = Date.now();
      const queryParams = `symbol=${symbol}&side=BUY&type=MARKET&quoteOrderQty=${quoteOrderQty}&timestamp=${timestamp}`;
      const signature = this.generateMexcSignature(queryParams);

      this.log('info', `📤 MEXC Order: BUY MARKET ${symbol} - quoteOrderQty: ${quoteOrderQty} USDT`);

      const response = await fetch(`${MEXC_BASE_URL}/api/v3/order?${queryParams}&signature=${signature}`, {
        method: 'POST',
        headers: {
          'X-MEXC-APIKEY': MEXC_API_KEY,
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

  async checkMexcMMBots() {
    if (!this.isRunning) return;

    try {
      // Find all active MEXC MM bots
      const activeBots = await this.db.collection('mexc_mm_bots').find({
        isActive: true,
        isRunning: true
      }).toArray();

      if (activeBots.length === 0) {
        return;
      }

      this.log('info', `🔍 Checking ${activeBots.length} active MEXC MM bot(s)`);

      for (const bot of activeBots) {
        await this.checkBot(bot);
      }
    } catch (error) {
      this.log('error', 'Error checking MEXC MM bots', error.message);
    }
  }

  async checkBot(bot) {
    const botId = bot._id.toString();

    // Prevent duplicate processing - LOCK IMMEDIATELY
    if (this.processingBots.has(botId)) {
      return;
    }
    this.processingBots.add(botId);

    try {
      const symbol = bot.symbol || 'GCBUSDT';
      
      // Re-fetch bot from DB to get fresh lastExecutedAt (prevents race condition)
      const freshBot = await this.db.collection('mexc_mm_bots').findOne({ _id: bot._id });
      if (!freshBot || !freshBot.isRunning) {
        return;
      }

      // Check cooldown FIRST before any API calls
      const cooldownMs = (freshBot.cooldownSeconds || 10) * 1000;
      const lastExecuted = freshBot.lastExecutedAt ? new Date(freshBot.lastExecutedAt).getTime() : 0;
      const now = Date.now();

      if (now - lastExecuted < cooldownMs) {
        const remaining = Math.ceil((cooldownMs - (now - lastExecuted)) / 1000);
        this.log('info', `[${bot.name}] ⏳ Cooldown active (${remaining}s remaining), skipping...`);
        return;
      }
      
      // Get current market price (last trade price)
      const marketPrice = await this.getMarketPrice(symbol);
      if (!marketPrice) {
        this.log('warning', `[${bot.name}] Could not fetch MEXC market price`);
        return;
      }

      // Get best ask price (cheapest sell price in order book)
      const bestAskPrice = await this.getBestAskPrice(symbol);
      if (!bestAskPrice) {
        this.log('warning', `[${bot.name}] Could not fetch MEXC best ask price`);
        return;
      }

      // Calculate the price gap percentage
      // Gap = (bestAsk - marketPrice) / marketPrice * 100
      const priceGap = ((bestAskPrice - marketPrice) / marketPrice) * 100;

      // Update bot with latest prices
      await this.db.collection('mexc_mm_bots').updateOne(
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

      // Log current prices and gap
      this.log('info', `[${bot.name}] 📊 Market: $${marketPrice.toFixed(6)} | Best Ask: $${bestAskPrice.toFixed(6)} | Gap: ${priceGap.toFixed(2)}%`, {
        marketPrice,
        bestAskPrice,
        priceGap: priceGap.toFixed(2),
        botName: bot.name
      });

      // Check if price gap is >= threshold (default 3%)
      const gapThreshold = freshBot.gapThreshold || 3;
      
      if (priceGap >= gapThreshold) {
        // Market price is significantly below best ask - need to place market buy
        this.log('info', `[${bot.name}] 🚨 Price gap ${priceGap.toFixed(2)}% >= ${gapThreshold}% threshold!`);

        // Check USDT balance before placing order
        const orderAmount = freshBot.orderAmount || 1;
        const balances = await this.getAccountBalance();
        const availableUsdt = balances?.USDT ? parseFloat(balances.USDT.free) : 0;

        if (availableUsdt < orderAmount) {
          this.log('warning', `[${bot.name}] ⚠️ Insufficient USDT balance: ${availableUsdt.toFixed(2)} < ${orderAmount} required`);
          return;
        }

        // Place market buy order
        const result = await this.placeMarketBuyOrder(symbol, orderAmount);

        if (result) {
          // Update bot stats
          await this.db.collection('mexc_mm_bots').updateOne(
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
          await this.db.collection('mexc_mm_bot_logs').insertOne({
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

          this.log('success', `[${bot.name}] ✅ Executed MEXC MM order: $${orderAmount} USDT (gap: ${priceGap.toFixed(2)}%)`);

          // Send Telegram notification
          try {
            const tgBalances = await this.getAccountBalance();
            
            const message = `<b>🔄 MEXC MM Bot Order</b>\n\n` +
              `🤖 <b>Bot:</b> ${bot.name}\n` +
              `💱 <b>Symbol:</b> ${symbol}\n` +
              `💵 <b>Order Amount:</b> $${orderAmount} USDT\n` +
              `📊 <b>Market Price:</b> $${marketPrice.toFixed(6)}\n` +
              `🎯 <b>Best Ask:</b> $${bestAskPrice.toFixed(6)}\n` +
              `📈 <b>Price Gap:</b> ${priceGap.toFixed(2)}%\n\n` +
              `💰 <b>MEXC Balance:</b>\n` +
              `   • GCB: ${tgBalances?.GCB ? parseFloat(tgBalances.GCB.free).toFixed(2) : '0.00'}\n` +
              `   • USDT: ${tgBalances?.USDT ? parseFloat(tgBalances.USDT.free).toFixed(2) : '0.00'}\n\n` +
              `⏰ <b>Time (UTC):</b> ${new Date().toUTCString()}`;
            
            await telegramService.sendMessage(message);
          } catch (err) {
            this.log('warning', 'Telegram notification failed', err.message);
          }
        } else {
          // Log failed attempt
          await this.db.collection('mexc_mm_bot_logs').insertOne({
            botId: botId,
            botName: bot.name,
            action: 'BUY',
            symbol: symbol,
            amount: orderAmount,
            marketPrice: marketPrice,
            bestAskPrice: bestAskPrice,
            priceGap: priceGap,
            status: 'FAILED',
            message: 'Failed to place MEXC market buy order',
            createdAt: new Date()
          });
        }
      } else {
        // Price gap is within threshold
        this.log('info', `[${bot.name}] ✅ Gap ${priceGap.toFixed(2)}% < ${gapThreshold}% - no action needed`);
      }
    } catch (error) {
      this.log('error', `[${bot.name}] Error in MEXC MM bot: ${error.message}`);
    } finally {
      this.processingBots.delete(botId);
    }
  }
}

export default MexcMMBotMonitor;

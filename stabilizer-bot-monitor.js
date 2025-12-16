import crypto from 'crypto';

class StabilizerBotMonitor {
  constructor(db, config = {}) {
    this.db = db;
    this.isRunning = false;
    this.config = {
      checkInterval: config.checkInterval || 5000, // Check every 5 seconds
      ...config
    };
    this.openApiBase = config.openApiBase || 'https://openapi.gcbex.com';
    this.checkTimer = null;
    this.logs = [];
    this.maxLogs = 1000;
  }

  log(level, message, data = null, botId = null) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
      botId
    };
    this.logs.unshift(logEntry);
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(0, this.maxLogs);
    }

    const emoji = {
      info: 'ℹ️',
      success: '✅',
      error: '❌',
      warning: '⚠️',
      trade: '💱',
      calculate: '🧮',
      monitor: '👁️'
    };
    console.log(`${emoji[level] || '📝'} [STABILIZER BOT] ${message}`, data ? data : '');

    // Save log to database
    if (botId) {
      this.saveLogToDb(logEntry, botId).catch(err => 
        console.error('Failed to save log to DB:', err.message)
      );
    }
  }

  async saveLogToDb(logEntry, botId) {
    try {
      await this.db.collection('stabilizer_bot_logs').insertOne({
        ...logEntry,
        botId: botId.toString(),
        createdAt: new Date()
      });
    } catch (error) {
      console.error('Error saving log:', error.message);
    }
  }

  getLogs(limit = 100, botId = null) {
    if (botId) {
      return this.logs.filter(log => log.botId && log.botId.toString() === botId.toString()).slice(0, limit);
    }
    return this.logs.slice(0, limit);
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      config: this.config,
      uptime: this.isRunning ? 'Running' : 'Stopped'
    };
  }

  async start() {
    if (this.isRunning) {
      this.log('warning', 'Stabilizer bot monitor is already running');
      return;
    }

    this.isRunning = true;
    this.log('success', 'Stabilizer bot monitoring service started');

    this.checkStabilizerBots();
    this.checkTimer = setInterval(() => this.checkStabilizerBots(), this.config.checkInterval);
  }

  async stop() {
    if (!this.isRunning) {
      this.log('warning', 'Stabilizer bot monitor is not running');
      return;
    }

    this.isRunning = false;
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.log('info', 'Stabilizer bot monitoring service stopped');
  }

  async checkStabilizerBots() {
    if (!this.isRunning) return;

    try {
      // Find all active stabilizer bots
      const activeBots = await this.db.collection('stabilizer_bots').find({
        isActive: true,
        isRunning: true
      }).toArray();

      if (activeBots.length > 0) {
        this.log('monitor', `Checking ${activeBots.length} active stabilizer bot(s)`);
      }

      for (const bot of activeBots) {
        await this.monitorAndStabilize(bot);
      }
    } catch (error) {
      this.log('error', 'Error checking stabilizer bots', error.message);
    }
  }

  async getServerTime() {
    try {
      const response = await fetch(`${this.openApiBase}/sapi/v2/time`);
      const data = await response.json();
      return data.serverTime;
    } catch (error) {
      this.log('warning', 'Failed to fetch server time, using local time', error.message);
      return Date.now();
    }
  }

  async getSymbolInfo(symbol) {
    try {
      const response = await fetch(`${this.openApiBase}/sapi/v2/symbols`);
      const data = await response.json();
      
      if (data && data.symbols) {
        const symbolInfo = data.symbols.find(s => s.symbol.toUpperCase() === symbol.toUpperCase());
        if (symbolInfo) {
          return {
            pricePrecision: symbolInfo.pricePrecision || 6,
            quantityPrecision: symbolInfo.quantityPrecision || 2
          };
        }
      }
      // Default fallback for GCBUSDT
      return { pricePrecision: 6, quantityPrecision: 2 };
    } catch (error) {
      this.log('error', `Error fetching symbol info for ${symbol}`, error.message);
      return { pricePrecision: 6, quantityPrecision: 2 };
    }
  }

  async getUserBalance(user) {
    try {
      if (!user || !user.apiKey || !user.apiSecret) {
        this.log('error', 'User API credentials missing');
        return null;
      }

      const timestamp = (await this.getServerTime()).toString();
      const method = 'GET';
      const requestPath = '/sapi/v1/account';
      const message = `${timestamp}${method.toUpperCase()}${requestPath}`;
      const signature = crypto
        .createHmac('sha256', user.apiSecret)
        .update(message)
        .digest('hex');

      const response = await fetch(`${this.openApiBase}${requestPath}`, {
        method: 'GET',
        headers: {
          'X-CH-APIKEY': user.apiKey,
          'X-CH-TS': timestamp,
          'X-CH-SIGN': signature,
        },
      });

      const data = await response.json();

      if (data.balances) {
        return data.balances;
      }

      this.log('error', `Balance fetch failed for user ${user.uid}`, JSON.stringify(data));
      return null;
    } catch (error) {
      this.log('error', `Error fetching balance for user ${user.uid}`, error.message);
      return null;
    }
  }

  async getMarketPrice(symbol) {
    try {
      const response = await fetch(`${this.openApiBase}/sapi/v2/ticker?symbol=${symbol.toLowerCase()}`);
      const data = await response.json();
      
      if (data && data.last) {
        return parseFloat(data.last);
      }
      return null;
    } catch (error) {
      this.log('error', `Error fetching market price for ${symbol}`, error.message);
      return null;
    }
  }

  async getOrderBookDepth(symbol) {
    try {
      const response = await fetch(`${this.openApiBase}/sapi/v2/depth?symbol=${symbol}&limit=20`);
      const data = await response.json();
      
      if (data.asks && data.asks.length > 0) {
        return {
          asks: data.asks.map(ask => ({ price: parseFloat(ask[0]), volume: parseFloat(ask[1]) })),
          bids: data.bids ? data.bids.map(bid => ({ price: parseFloat(bid[0]), volume: parseFloat(bid[1]) })) : []
        };
      }
      return null;
    } catch (error) {
      this.log('error', 'Error fetching order book depth', error.message);
      return null;
    }
  }

  calculateRequiredUSDT(orderBook, currentPrice, targetPrice) {
    // Calculate how much USDT needed to buy enough tokens to push price to target
    // We need to consume ALL asks up to AND INCLUDING the target price
    let requiredUSDT = 0;
    let cumulativeVolume = 0;
    
    for (const ask of orderBook.asks) {
      // Break only if ask price is GREATER than target (not equal)
      // We want to consume asks AT the target price to reach it
      if (ask.price > targetPrice) {
        break;
      }
      
      const volumeAtThisLevel = ask.volume;
      const costAtThisLevel = ask.price * volumeAtThisLevel;
      
      requiredUSDT += costAtThisLevel;
      cumulativeVolume += volumeAtThisLevel;
    }

    return {
      requiredUSDT: requiredUSDT,
      tokensNeeded: cumulativeVolume,
      levelsToConsume: orderBook.asks.filter(ask => ask.price <= targetPrice).length
    };
  }

  async executeMarketBuy(user, symbol, usdtAmount, symbolInfo) {
    try {
      // Use symbol's quantityPrecision for volume
      const orderBody = {
        symbol: symbol,
        side: 'BUY',
        type: 'MARKET',
        volume: usdtAmount.toFixed(symbolInfo.quantityPrecision) // Use correct precision from symbol info
      };

      const timestamp = (await this.getServerTime()).toString();
      const method = 'POST';
      const requestPath = '/sapi/v2/order';
      const bodyJson = JSON.stringify(orderBody, null, 0).replace(/\s/g, '');
      const message = `${timestamp}${method.toUpperCase()}${requestPath}${bodyJson}`;
      const signature = crypto
        .createHmac('sha256', user.apiSecret)
        .update(message)
        .digest('hex');

      const response = await fetch(`${this.openApiBase}${requestPath}`, {
        method: 'POST',
        headers: {
          'X-CH-APIKEY': user.apiKey,
          'X-CH-TS': timestamp,
          'X-CH-SIGN': signature,
          'Content-Type': 'application/json'
        },
        body: bodyJson
      });

      const result = await response.json();
      
      if (result.orderId) {
        return { success: true, orderId: result.orderId, data: result };
      } else {
        return { success: false, error: result.msg || 'Unknown error', data: result };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async monitorAndStabilize(bot) {
    try {
      this.log('monitor', `Monitoring: ${bot.name}`, null, bot._id);

      // Get user credentials
      const user = await this.db.collection('users').findOne({ 
        uid: bot.userId,
        apiKey: { $exists: true },
        apiSecret: { $exists: true }
      });

      if (!user) {
        this.log('error', `User ${bot.userId} not found or missing API credentials`, null, bot._id);
        return;
      }

      // Get current market price
      const marketPrice = await this.getMarketPrice(bot.symbol);
      if (!marketPrice) {
        this.log('error', 'Failed to fetch market price', null, bot._id);
        return;
      }

      const targetPrice = bot.targetPrice;
      
      this.log('info', `Market: $${marketPrice.toFixed(6)} | Target: $${targetPrice.toFixed(6)}`, null, bot._id);

      // Check if price is below target
      if (marketPrice >= targetPrice) {
        this.log('success', `✅ Price is at or above target. No action needed.`, null, bot._id);
        
        // Update last checked time
        await this.db.collection('stabilizer_bots').updateOne(
          { _id: bot._id },
          { $set: { lastCheckedAt: new Date() } }
        );
        return;
      }

      // Price is below target - need to stabilize
      this.log('warning', `⚠️ Price BELOW target by $${(targetPrice - marketPrice).toFixed(6)}. Stabilization needed!`, null, bot._id);

      // Get order book to calculate required USDT
      const orderBook = await this.getOrderBookDepth(bot.symbol);
      if (!orderBook) {
        this.log('error', 'Failed to fetch order book', null, bot._id);
        return;
      }

      // Calculate how much USDT needed
      const calculation = this.calculateRequiredUSDT(orderBook, marketPrice, targetPrice);
      
      this.log('calculate', `📊 Calculation: Need $${calculation.requiredUSDT.toFixed(2)} USDT to buy ${calculation.tokensNeeded.toFixed(2)} tokens across ${calculation.levelsToConsume} price levels`, null, bot._id);

      if (calculation.requiredUSDT === 0 || calculation.requiredUSDT < 1) {
        this.log('warning', 'Required USDT too low, skipping execution', null, bot._id);
        return;
      }

      // Get symbol precision info
      const symbolInfo = await this.getSymbolInfo(bot.symbol);
      this.log('info', `📏 Symbol precision: Price=${symbolInfo.pricePrecision} decimals, Volume=${symbolInfo.quantityPrecision} decimals`, null, bot._id);

      // Check user balance before executing
      const balances = await this.getUserBalance(user);
      if (!balances) {
        this.log('error', '❌ Failed to fetch user balance', null, bot._id);
        return;
      }

      const usdtBalance = balances.find(b => b.asset.toUpperCase() === 'USDT');
      const availableUsdt = usdtBalance ? parseFloat(usdtBalance.free) : 0;
      
      this.log('info', `💰 Available USDT: $${availableUsdt.toFixed(2)} | Required: $${calculation.requiredUSDT.toFixed(2)}`, null, bot._id);

      if (availableUsdt < calculation.requiredUSDT) {
        this.log('error', `❌ Insufficient balance! Need $${calculation.requiredUSDT.toFixed(2)} but only have $${availableUsdt.toFixed(2)} USDT`, null, bot._id);
        return;
      }

      // Split into 4 parts
      const quarterAmount = calculation.requiredUSDT / 4;
      
      this.log('info', `🔄 Splitting $${calculation.requiredUSDT.toFixed(2)} into 4 parts of $${quarterAmount.toFixed(2)} each`, null, bot._id);
      this.log('info', `⏱️ Will execute over 40 seconds (4 orders × 10 second intervals)`, null, bot._id);

      // Execute 4 market buys with 10 second intervals
      let allOrdersSuccessful = true;
      let successfulOrdersCount = 0;
      
      for (let i = 1; i <= 4; i++) {
        this.log('trade', `💱 Executing buy order ${i}/4: $${quarterAmount.toFixed(2)} USDT`, null, bot._id);
        
        const result = await this.executeMarketBuy(user, bot.symbol, quarterAmount, symbolInfo);
        
        if (result.success) {
          successfulOrdersCount++;
          this.log('success', `✅ Order ${i}/4 executed successfully! Order ID: ${result.orderId}`, null, bot._id);
          
          // Save trade to database
          await this.db.collection('stabilizer_bot_trades').insertOne({
            stabilizerBotId: bot._id,
            userId: bot.userId,
            symbol: bot.symbol,
            orderNumber: i,
            totalOrders: 4,
            usdtAmount: quarterAmount,
            orderId: result.orderId,
            marketPrice: marketPrice,
            targetPrice: targetPrice,
            status: 'success',
            executedAt: new Date(),
            response: result.data
          });
          
          // Check price after each order - stop if target reached
          const currentPrice = await this.getMarketPrice(bot.symbol);
          if (currentPrice && currentPrice >= targetPrice) {
            this.log('success', `🎯 Target price reached! Current: $${currentPrice.toFixed(6)} >= Target: $${targetPrice.toFixed(6)}`, null, bot._id);
            this.log('success', `✅ Stabilization achieved with ${i}/4 orders. Stopping early.`, null, bot._id);
            break;
          }
        } else {
          allOrdersSuccessful = false;
          this.log('error', `❌ Order ${i}/4 failed: ${result.error}`, null, bot._id);
          
          // Save failed trade
          await this.db.collection('stabilizer_bot_trades').insertOne({
            stabilizerBotId: bot._id,
            userId: bot.userId,
            symbol: bot.symbol,
            orderNumber: i,
            totalOrders: 4,
            usdtAmount: quarterAmount,
            marketPrice: marketPrice,
            targetPrice: targetPrice,
            status: 'failed',
            error: result.error,
            executedAt: new Date()
          });
          
          // Stop execution if order fails
          this.log('error', `🛑 Stopping execution due to order failure. Completed: ${successfulOrdersCount}/4`, null, bot._id);
          break;
        }

        // Wait 10 seconds before next order (except for last one)
        if (i < 4) {
          this.log('info', `⏳ Waiting 10 seconds before order ${i + 1}/4...`, null, bot._id);
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
      }

      // Check final price and show completion message
      const finalPrice = await this.getMarketPrice(bot.symbol);
      const priceChange = finalPrice - marketPrice;
      const priceChangePercent = (priceChange / marketPrice) * 100;
      
      if (successfulOrdersCount > 0 && finalPrice >= targetPrice) {
        // Success - target reached
        this.log('success', `🎯 Stabilization complete! ${successfulOrdersCount}/4 orders executed. Price moved from $${marketPrice.toFixed(6)} to $${finalPrice.toFixed(6)} (+${priceChangePercent.toFixed(2)}%)`, null, bot._id);
      } else if (successfulOrdersCount > 0) {
        // Partial success - orders executed but target not reached
        this.log('warning', `⚠️ Stabilization incomplete. ${successfulOrdersCount}/4 orders executed but target not reached. Price: $${finalPrice.toFixed(6)} (target: $${targetPrice.toFixed(6)})`, null, bot._id);
      } else {
        // Failed - no successful orders
        this.log('error', `❌ Stabilization failed. No orders succeeded.`, null, bot._id);
      }

      // Count successful orders
      const successfulOrders = await this.db.collection('stabilizer_bot_trades')
        .countDocuments({ stabilizerBotId: bot._id, status: 'success' });
      const failedOrders = await this.db.collection('stabilizer_bot_trades')
        .countDocuments({ stabilizerBotId: bot._id, status: 'failed' });

      // Calculate actual spent amount (only successful orders)
      const actualSpent = successfulOrdersCount * quarterAmount;

      // Update bot statistics
      await this.db.collection('stabilizer_bots').updateOne(
        { _id: bot._id },
        { 
          $set: { 
            lastExecutedAt: new Date(),
            lastCheckedAt: new Date(),
            lastMarketPrice: marketPrice,
            lastFinalPrice: finalPrice,
            successfulOrders: successfulOrders,
            failedOrders: failedOrders
          },
          $inc: { 
            executionCount: 1,
            totalUsdtSpent: actualSpent
          }
        }
      );

    } catch (error) {
      this.log('error', `Error in stabilization cycle for bot ${bot._id}`, error.message, bot._id);
    }
  }
}

export default StabilizerBotMonitor;

import crypto from 'crypto';

class ScheduledBotMonitor {
  constructor(db, config = {}) {
    this.db = db;
    this.isRunning = false;
    this.config = {
      checkInterval: config.checkInterval || 60000, // Check every 1 minute
      ...config
    };
    this.openApiBase = config.openApiBase || 'https://openapi.gcbex.com';
    this.checkTimer = null;
  }

  log(level, message, data = null) {
    const emoji = {
      info: 'ℹ️',
      success: '✅',
      error: '❌',
      warning: '⚠️',
      trade: '💱'
    };
    console.log(`${emoji[level] || '📝'} [SCHEDULED BOT] ${message}`, data ? data : '');
  }

  async start() {
    if (this.isRunning) {
      this.log('warning', 'Scheduled bot monitor is already running');
      return;
    }

    this.isRunning = true;
    this.log('success', 'Scheduled bot monitoring service started');

    this.checkScheduledBots();
    this.checkTimer = setInterval(() => this.checkScheduledBots(), this.config.checkInterval);
  }

  async stop() {
    if (!this.isRunning) {
      this.log('warning', 'Scheduled bot monitor is not running');
      return;
    }

    this.isRunning = false;
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.log('info', 'Scheduled bot monitoring service stopped');
  }

  async checkScheduledBots() {
    if (!this.isRunning) return;

    try {
      const now = new Date();
      
      // Find all active scheduled bots that are due for execution
      const dueBots = await this.db.collection('scheduled_bots').find({
        isActive: true,
        isRunning: true,
        nextBuyAt: { $lte: now }
      }).toArray();

      this.log('info', `🔍 Checking scheduled bots: ${dueBots.length} bot(s) due for execution`);

      for (const bot of dueBots) {
        await this.executeScheduledBuy(bot);
      }
    } catch (error) {
      this.log('error', 'Error checking scheduled bots', error.message);
    }
  }

  async getServerTime() {
    try {
      const response = await fetch(`${this.openApiBase}/sapi/v1/time`);
      const data = await response.json();
      return data.serverTime;
    } catch (error) {
      this.log('warning', 'Failed to fetch server time, using local time', error.message);
      return Date.now();
    }
  }

  async getOrderBookDepth(symbol) {
    try {
      const response = await fetch(`${this.openApiBase}/sapi/v2/depth?symbol=${symbol}&limit=10`);
      const data = await response.json();
      
      if (data.asks && data.asks.length > 0) {
        return {
          bestAskPrice: parseFloat(data.asks[0][0]),
          bestAskVolume: parseFloat(data.asks[0][1]),
          bestBidPrice: data.bids && data.bids.length > 0 ? parseFloat(data.bids[0][0]) : null,
          bestBidVolume: data.bids && data.bids.length > 0 ? parseFloat(data.bids[0][1]) : null
        };
      }
      return null;
    } catch (error) {
      this.log('error', 'Error fetching order book depth', error.message);
      return null;
    }
  }

  async executeScheduledBuy(bot) {
    try {
      this.log('trade', `Executing scheduled accumulation for bot: ${bot.name} (${bot._id})`);

      // Get user credentials
      const user = await this.db.collection('users').findOne({ 
        uid: bot.userId,
        apiKey: { $exists: true },
        apiSecret: { $exists: true }
      });

      if (!user) {
        this.log('error', `User ${bot.userId} not found or missing API credentials`);
        return;
      }

      // Get order book to find best ask price
      const orderBook = await this.getOrderBookDepth(bot.symbol);
      if (!orderBook) {
        this.log('error', 'Failed to fetch order book depth');
        return;
      }

      const bestAskPrice = orderBook.bestAskPrice;
      this.log('info', `📊 Best ask price: ${bestAskPrice} USDT`);

      // Split USDT budget for this hour (50% market buy, 50% limit buy)
      const usdtPerHour = bot.usdtPerHour;
      const marketBuyUSDT = usdtPerHour * 0.5;
      const limitBuyUSDT = usdtPerHour * 0.5;
      
      // Calculate GCB volumes
      const marketBuyVolume = marketBuyUSDT / bestAskPrice;

      // Step 1: Execute MARKET BUY to take tokens from sellers
      this.log('info', `💰 Step 1: Market buy ${marketBuyVolume.toFixed(4)} GCB with ${marketBuyUSDT.toFixed(2)} USDT at ~${bestAskPrice} USDT`);
      
      const marketBuyOrderBody = {
        symbol: bot.symbol,
        side: 'BUY',
        type: 'MARKET',
        volume: marketBuyVolume.toFixed(8)
      };

      const timestamp = (await this.getServerTime()).toString();
      const method = 'POST';
      const requestPath = '/sapi/v2/order';
      const bodyJson = JSON.stringify(marketBuyOrderBody, null, 0).replace(/\s/g, '');
      const message = `${timestamp}${method.toUpperCase()}${requestPath}${bodyJson}`;
      const signature = crypto
        .createHmac('sha256', user.apiSecret)
        .update(message)
        .digest('hex');

      const marketBuyResponse = await fetch(`${this.openApiBase}${requestPath}`, {
        method: 'POST',
        headers: {
          'X-CH-APIKEY': user.apiKey,
          'X-CH-TS': timestamp,
          'X-CH-SIGN': signature,
          'Content-Type': 'application/json'
        },
        body: bodyJson
      });

      const marketBuyResult = await marketBuyResponse.json();

      if (!marketBuyResult.orderId) {
        this.log('error', `Market buy failed: ${marketBuyResult.msg || 'Unknown error'}`, marketBuyResult);
        
        // Save failed trade
        await this.db.collection('scheduled_bot_trades').insertOne({
          scheduledBotId: bot._id,
          userId: bot.userId,
          symbol: bot.symbol,
          marketBuyStatus: 'failed',
          limitBuyStatus: 'skipped',
          error: marketBuyResult.msg || 'Unknown error',
          executedAt: new Date(),
          marketBuyResponse: marketBuyResult
        });
        return;
      }

      this.log('success', `✅ Market buy executed: ${marketBuyResult.orderId}`);

      // Step 2: Place LIMIT BUY bid just below best ask to be top of order book
      const limitBuyPrice = bestAskPrice * (1 - bot.bidOffsetPercent / 100);
      const limitBuyVolume = limitBuyUSDT / limitBuyPrice;
      
      this.log('info', `📈 Step 2: Placing LIMIT BUY bid at ${limitBuyPrice.toFixed(8)} USDT (${bot.bidOffsetPercent}% below best ask) for ${limitBuyVolume.toFixed(4)} GCB`);

      const limitBuyOrderBody = {
        symbol: bot.symbol,
        side: 'BUY',
        type: 'LIMIT',
        volume: limitBuyVolume.toFixed(8),
        price: limitBuyPrice.toFixed(8),
        timeInForce: 'GTC'
      };

      const timestamp2 = (await this.getServerTime()).toString();
      const bodyJson2 = JSON.stringify(limitBuyOrderBody, null, 0).replace(/\s/g, '');
      const message2 = `${timestamp2}${method.toUpperCase()}${requestPath}${bodyJson2}`;
      const signature2 = crypto
        .createHmac('sha256', user.apiSecret)
        .update(message2)
        .digest('hex');

      const limitBuyResponse = await fetch(`${this.openApiBase}${requestPath}`, {
        method: 'POST',
        headers: {
          'X-CH-APIKEY': user.apiKey,
          'X-CH-TS': timestamp2,
          'X-CH-SIGN': signature2,
          'Content-Type': 'application/json'
        },
        body: bodyJson2
      });

      const limitBuyResult = await limitBuyResponse.json();

      if (!limitBuyResult.orderId) {
        this.log('error', `Limit buy bid failed: ${limitBuyResult.msg || 'Unknown error'}`, limitBuyResult);
      } else {
        this.log('success', `✅ Limit buy bid placed: ${limitBuyResult.orderId} at ${limitBuyPrice.toFixed(8)} USDT - Now top of order book!`);
      }

      // Save trade to database
      const executedMarketBuyPrice = parseFloat(marketBuyResult.price) || bestAskPrice;
      await this.db.collection('scheduled_bot_trades').insertOne({
        scheduledBotId: bot._id,
        userId: bot.userId,
        symbol: bot.symbol,
        marketBuyOrderId: marketBuyResult.orderId,
        limitBuyOrderId: limitBuyResult.orderId || null,
        marketBuyPrice: executedMarketBuyPrice,
        limitBuyPrice: limitBuyPrice,
        marketBuyVolume: marketBuyVolume,
        limitBuyVolume: limitBuyVolume,
        marketBuyStatus: 'success',
        limitBuyStatus: limitBuyResult.orderId ? 'placed' : 'failed',
        executedAt: new Date(),
        marketBuyResponse: marketBuyResult,
        limitBuyResponse: limitBuyResult
      });

      // Update bot progress
      const executedBuys = bot.executedBuys + 1;
      const spentUsdt = bot.spentUsdt + usdtPerHour;
      const accumulatedGcb = bot.accumulatedGcb + marketBuyVolume; // Only count market buy as accumulated
      const completed = executedBuys >= bot.totalBuys;
      
      const nextBuyAt = completed ? null : new Date(Date.now() + bot.intervalMs);

      await this.db.collection('scheduled_bots').updateOne(
        { _id: bot._id },
        {
          $set: {
            executedBuys: executedBuys,
            spentUsdt: spentUsdt,
            accumulatedGcb: accumulatedGcb,
            lastBuyAt: new Date(),
            nextBuyAt: nextBuyAt,
            isActive: !completed,
            isRunning: !completed,
            status: completed ? 'completed' : 'running',
            updatedAt: new Date()
          }
        }
      );

      if (completed) {
        this.log('success', `🎉 Scheduled bot completed: ${bot.name} (${bot._id})`);
      } else {
        this.log('info', `⏰ Next buy scheduled at: ${nextBuyAt.toISOString()}`);
      }

    } catch (error) {
      this.log('error', `Error executing scheduled buy for bot ${bot._id}`, error.message);
      
      // Save error to database
      await this.db.collection('scheduled_bot_trades').insertOne({
        scheduledBotId: bot._id,
        userId: bot.userId,
        symbol: bot.symbol,
        status: 'error',
        error: error.message,
        executedAt: new Date()
      });
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      checkInterval: this.config.checkInterval
    };
  }
}

export default ScheduledBotMonitor;

import crypto from 'crypto';

class MarketMakerBotMonitor {
  constructor(db, config = {}) {
    this.db = db;
    this.isRunning = false;
    this.config = {
      checkInterval: config.checkInterval || 30000, // Check every 30 seconds
      ...config
    };
    this.openApiBase = config.openApiBase || 'https://openapi.gcbex.com';
    this.checkTimer = null;
    this.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || config.telegramBotToken;
    this.logs = [];
    this.maxLogs = 1000;
    this.exchangeInfo = {}; // Cache for exchange info
  }

  log(level, message, data = null) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data
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
      trade: '💱'
    };
    console.log(`${emoji[level] || '📝'} [MARKET MAKER] ${message}`, data ? data : '');
  }

  getLogs(limit = 100) {
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
      this.log('warning', 'Market maker bot monitor is already running');
      return;
    }

    this.isRunning = true;
    this.log('success', 'Market maker bot monitoring service started');

    this.checkMarketMakerBots();
    this.checkTimer = setInterval(() => this.checkMarketMakerBots(), this.config.checkInterval);
  }

  async stop() {
    if (!this.isRunning) {
      this.log('warning', 'Market maker bot monitor is not running');
      return;
    }

    this.isRunning = false;
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.log('info', 'Market maker bot monitoring service stopped');
  }

  async sendTelegramAlert(userId, message) {
    if (!this.telegramBotToken || !userId) return;

    try {
      const url = `https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: userId.trim(),
          text: message,
          parse_mode: 'Markdown'
        })
      });
    } catch (error) {
      this.log('error', `Telegram notification error: ${error.message}`);
    }
  }

  async checkMarketMakerBots() {
    if (!this.isRunning) return;

    try {
      // Find all active market maker bots
      const activeBots = await this.db.collection('market_maker_bots').find({
        isActive: true,
        isRunning: true,
        targetReached: false
      }).toArray();

      this.log('info', `🔍 Checking market maker bots: ${activeBots.length} active bot(s)`);

      for (const bot of activeBots) {
        await this.executeMarketMakerCycle(bot);
      }
    } catch (error) {
      this.log('error', 'Error checking market maker bots', error.message);
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

  async getBalance(user, asset) {
    try {
      const timestamp = (await this.getServerTime()).toString();
      const method = 'GET';
      const requestPath = '/sapi/v1/account';
      
      const message = `${timestamp}${method.toUpperCase()}${requestPath}`;
      const signature = crypto
        .createHmac('sha256', user.apiSecret)
        .update(message)
        .digest('hex');

      const response = await fetch(`${this.openApiBase}${requestPath}`, {
        headers: {
          'X-CH-APIKEY': user.apiKey,
          'X-CH-TS': timestamp,
          'X-CH-SIGN': signature
        }
      });

      const data = await response.json();
      
      if (data && data.balances) {
        const balance = data.balances.find(b => b.asset === asset);
        return balance ? parseFloat(balance.free) : 0;
      }
      
      return 0;
    } catch (error) {
      this.log('error', `Error fetching balance for ${asset}`, error.message);
      return 0;
    }
  }

  async placeOrder(user, bot, side, price, symbolInfo) {
    try {
      const timestamp = (await this.getServerTime()).toString();
      const method = 'POST';
      const requestPath = '/sapi/v2/order';
      
      // Use correct precision from symbol info
      const formattedVolume = bot.currentOrderSize.toFixed(symbolInfo.quantityPrecision);
      const formattedPrice = price.toFixed(symbolInfo.pricePrecision);
      
      const orderBody = {
        symbol: bot.symbol,
        side: side,
        type: 'LIMIT',
        timeInForce: 'GTC',
        volume: formattedVolume,
        price: formattedPrice
      };
      
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

      const data = await response.json();
      
      if (data.orderId) {
        this.log('success', `✅ Placed ${side} order at ${formattedPrice} (${bot.currentOrderSize.toFixed(2)} GCB)`);
        if (bot.telegramEnabled && bot.telegramUserId) {
          await this.sendTelegramAlert(bot.telegramUserId, 
            `✅ *${bot.name}*\nPlaced ${side} order at $${formattedPrice}\nSize: ${bot.currentOrderSize.toFixed(2)} GCB`
          );
        }
        return true;
      } else {
        this.log('warning', `⚠ Order error: ${JSON.stringify(data)}`);
        return false;
      }
    } catch (error) {
      this.log('error', `Error placing ${side} order`, error.message);
      return false;
    }
  }

  async cancelAllOrders(user, symbol) {
    try {
      this.log('info', `🔍 Fetching open orders for ${symbol}...`);
      
      const timestamp = (await this.getServerTime()).toString();
      const method = 'GET';
      const query = `symbol=${symbol}`;
      const requestPath = `/sapi/v2/openOrders`;
      const fullPathWithQuery = `${requestPath}?${query}`;

      const message = `${timestamp}${method.toUpperCase()}${fullPathWithQuery}`;
      const signature = crypto
        .createHmac('sha256', user.apiSecret)
        .update(message)
        .digest('hex');

      const response = await fetch(`${this.openApiBase}${fullPathWithQuery}`, {
        headers: {
          'X-CH-APIKEY': user.apiKey,
          'X-CH-TS': timestamp,
          'X-CH-SIGN': signature
        }
      });

      const data = await response.json();
      this.log('info', `📋 Open orders response: ${JSON.stringify(data)}`);
      
      // Handle different response formats
      let orders = [];
      if (data.list && Array.isArray(data.list)) {
        orders = data.list;
      } else if (Array.isArray(data)) {
        orders = data;
      }

      if (orders.length === 0) {
        this.log('info', 'No open orders to cancel');
        return;
      }

      this.log('info', `🗑️ Cancelling ${orders.length} open order(s)...`);
      
      let cancelledCount = 0;
      let failedCount = 0;
      
      for (const order of orders) {
        // Use orderIdString if available (recommended by API), otherwise use orderId
        const orderId = order.orderIdString || order.orderId;
        const success = await this.cancelOrder(user, symbol, orderId);
        
        if (success) {
          cancelledCount++;
        } else {
          failedCount++;
        }
        
        // Small delay between cancellations to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      
      this.log('success', `✅ Cancelled ${cancelledCount}/${orders.length} order(s)${failedCount > 0 ? ` (${failedCount} failed)` : ''}`);
    } catch (error) {
      this.log('error', `Error in cancelAllOrders: ${error.message}`);
    }
  }

  async cancelOrder(user, symbol, orderId) {
    try {
      if (!orderId) {
        this.log('error', '❌ Invalid orderId: undefined or null');
        return false;
      }

      const timestamp = (await this.getServerTime()).toString();
      const method = 'POST';
      const requestPath = '/sapi/v2/cancel';
      
      const cancelBody = {
        symbol: symbol.toUpperCase(),
        orderId: orderId.toString()
      };
      
      const bodyJson = JSON.stringify(cancelBody, null, 0).replace(/\s/g, '');
      const message = `${timestamp}${method.toUpperCase()}${requestPath}${bodyJson}`;
      const signature = crypto
        .createHmac('sha256', user.apiSecret)
        .update(message)
        .digest('hex');

      this.log('info', `🔄 Cancelling order ${orderId}...`);

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
      this.log('info', `📄 Cancel response: ${JSON.stringify(result)}`);
      
      // Check multiple success conditions
      // PENDING_CANCEL means the cancel request was accepted and is being processed
      if (result.status === 'CANCELED' || 
          result.status === 'CANCELLED' || 
          result.status === 'PENDING_CANCEL' ||
          result.code === '0' ||
          (result.orderId && result.orderId.toString() === orderId.toString())) {
        this.log('success', `✅ Successfully cancelled order ${orderId} (Status: ${result.status || 'OK'})`);
        return true;
      } else {
        this.log('warning', `⚠️ Failed to cancel ${orderId}: ${JSON.stringify(result)}`);
        return false;
      }
    } catch (error) {
      this.log('error', `❌ Exception cancelling order ${orderId}: ${error.message}`);
      return false;
    }
  }

  async executeMarketMakerCycle(bot) {
    try {
      this.log('trade', `Executing market maker cycle for: ${bot.name} (${bot._id})`);

      // Get user credentials
      const user = await this.db.collection('users').findOne({ 
        uid: bot.userId,
        apiKey: { $exists: true },
        apiSecret: { $exists: true },
        botEnabled: true
      });

      if (!user) {
        this.log('error', `User ${bot.userId} not found or bot not enabled`);
        return;
      }

      // Get symbol precision info
      const symbolInfo = await this.getSymbolInfo(bot.symbol);
      this.log('info', `📏 Precision: Price=${symbolInfo.pricePrecision} decimals, Quantity=${symbolInfo.quantityPrecision} decimals`);

      // Get current market price
      const marketPrice = await this.getMarketPrice(bot.symbol);
      if (!marketPrice) {
        this.log('error', 'Failed to fetch market price');
        return;
      }

      this.log('info', `🎯 Target: ${bot.targetPrice.toFixed(6)} | 💹 Market: ${marketPrice.toFixed(6)}`);

      // Check if target price is reached
      if (marketPrice >= bot.targetPrice) {
        if (!bot.targetReached) {
          await this.cancelAllOrders(user, bot.symbol);
          await this.db.collection('market_maker_bots').updateOne(
            { _id: bot._id },
            { 
              $set: { 
                targetReached: true,
                isRunning: false,
                status: 'target_reached',
                updatedAt: new Date()
              } 
            }
          );
          
          const message = `✅ *Target Price Reached!*\n${bot.name}\nTarget: $${bot.targetPrice.toFixed(6)}\nMarket: $${marketPrice.toFixed(6)}\nBot now in monitor-only mode.`;
          this.log('success', message);
          
          if (bot.telegramEnabled && bot.telegramUserId) {
            await this.sendTelegramAlert(bot.telegramUserId, message);
          }
        }
        return;
      }

      // Use current market price for order calculations (not stored price)
      const orderPrice = marketPrice;

      // Calculate bid and ask prices based on current market price
      const bidPrice = orderPrice * (1 - bot.spreadPercent);
      const askPrice = orderPrice * (1 + bot.spreadPercent);

      this.log('info', `📊 Market: ${marketPrice.toFixed(6)} | Bid: ${bidPrice.toFixed(6)} | Ask: ${askPrice.toFixed(6)} | Size: ${bot.currentOrderSize.toFixed(2)} GCB`);

      // Cancel all existing orders FIRST before placing new ones
      this.log('info', '═══════════════════════════════════════');
      this.log('info', '🔄 STEP 1: Cancelling all existing orders...');
      await this.cancelAllOrders(user, bot.symbol);
      
      // Longer delay to ensure orders are cancelled
      this.log('info', '⏳ Waiting 4 seconds for cancellations to process...');
      await new Promise(resolve => setTimeout(resolve, 4000));
      
      // Verify orders were cancelled by fetching again
      this.log('info', '🔍 Verifying orders were cancelled...');
      const verifyTimestamp = (await this.getServerTime()).toString();
      const verifyQuery = `symbol=${bot.symbol}`;
      const verifyPath = `/sapi/v2/openOrders`;
      const verifyFullPath = `${verifyPath}?${verifyQuery}`;
      const verifyMessage = `${verifyTimestamp}GET${verifyFullPath}`;
      const verifySignature = crypto.createHmac('sha256', user.apiSecret)
        .update(verifyMessage)
        .digest('hex');
      
      const verifyResponse = await fetch(`${this.openApiBase}${verifyFullPath}`, {
        headers: {
          'X-CH-APIKEY': user.apiKey,
          'X-CH-TS': verifyTimestamp,
          'X-CH-SIGN': verifySignature
        }
      });
      
      const remainingOrders = await verifyResponse.json();
      const ordersArray = Array.isArray(remainingOrders) ? remainingOrders : (remainingOrders.list || []);
      this.log('info', `📊 Remaining orders: ${ordersArray.length}`);
      
      if (ordersArray.length > 0) {
        this.log('warning', `⚠️ WARNING: ${ordersArray.length} order(s) still active! Skipping new orders this cycle.`);
        this.log('warning', `Remaining orders: ${JSON.stringify(ordersArray.map(o => ({id: o.orderIdString || o.orderId, symbol: o.symbol})))}`);
        return;
      }
      
      this.log('info', '✅ All orders cancelled successfully');
      this.log('info', '═══════════════════════════════════════');
      this.log('info', '🔄 STEP 2: Placing new orders...');

      // Extract base and quote assets from symbol
      const baseAsset = bot.symbol.slice(0, -4); // "GCBUSDT" -> "GCB"
      const quoteAsset = bot.symbol.slice(-4); // "GCBUSDT" -> "USDT"

      // Get balances
      const quoteBalance = await this.getBalance(user, quoteAsset);
      const baseBalance = await this.getBalance(user, baseAsset);

      this.log('info', `💰 Balances: ${quoteAsset}=${quoteBalance.toFixed(2)} | ${baseAsset}=${baseBalance.toFixed(2)}`);

      const requiredQuote = bidPrice * bot.currentOrderSize;
      const requiredBase = bot.currentOrderSize;

      // Place BUY order if sufficient balance
      if (quoteBalance >= requiredQuote) {
        await this.placeOrder(user, bot, 'BUY', bidPrice, symbolInfo);
      } else {
        const msg = `❗ Not enough ${quoteAsset} to BUY: Have ${quoteBalance.toFixed(2)}, need ${requiredQuote.toFixed(2)}`;
        this.log('warning', msg);
      }

      // Small delay between orders
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Place SELL order if sufficient balance
      if (baseBalance >= requiredBase) {
        await this.placeOrder(user, bot, 'SELL', askPrice, symbolInfo);
      } else {
        const msg = `❗ Not enough ${baseAsset} to SELL: Have ${baseBalance.toFixed(2)}, need ${requiredBase.toFixed(2)}`;
        this.log('warning', msg);
      }

      // Update bot state for next cycle (oscillating ladder strategy)
      // Oscillate between 40% and 90% of original size
      const initialSize = bot.initialOrderSize || bot.orderSize;
      const currentSize = bot.currentOrderSize;
      const minSize = initialSize * 0.40; // 40% of initial
      const maxSize = initialSize * 0.90; // 90% of initial
      
      // Determine direction (default is decreasing if not set)
      let isDecreasing = bot.isDecreasing !== undefined ? bot.isDecreasing : true;
      let newOrderSize;
      
      if (isDecreasing) {
        // Decrease by 3%
        newOrderSize = currentSize * 0.97;
        
        // If we hit or pass 40%, switch to increasing
        if (newOrderSize <= minSize) {
          newOrderSize = minSize;
          isDecreasing = false;
          this.log('info', `🔄 Reached minimum (40%). Switching to INCREASE mode`);
        }
      } else {
        // Increase by 3%
        newOrderSize = currentSize * 1.03;
        
        // If we hit or pass 90%, switch to decreasing
        if (newOrderSize >= maxSize) {
          newOrderSize = maxSize;
          isDecreasing = true;
          this.log('info', `🔄 Reached maximum (90%). Switching to DECREASE mode`);
        }
      }
      
      const percentOfInitial = (newOrderSize / initialSize * 100).toFixed(1);
      this.log('info', `📊 Next cycle size: ${newOrderSize.toFixed(2)} GCB (${percentOfInitial}% of initial) - ${isDecreasing ? 'DECREASING ⬇️' : 'INCREASING ⬆️'}`);

      await this.db.collection('market_maker_bots').updateOne(
        { _id: bot._id },
        { 
          $set: {
            currentOrderSize: newOrderSize,
            initialOrderSize: initialSize, // Store initial size for reference
            isDecreasing: isDecreasing, // Store direction
            lastExecutedAt: new Date(),
            updatedAt: new Date()
          },
          $inc: { executionCount: 1 }
        }
      );

      this.log('success', `✅ Cycle complete. Next cycle will use live market price. Size: ${newOrderSize.toFixed(2)} GCB`);

    } catch (error) {
      this.log('error', `Error in market maker cycle for bot ${bot._id}`, error.message);
      
      if (bot.telegramEnabled && bot.telegramUserId) {
        await this.sendTelegramAlert(bot.telegramUserId, 
          `❌ *Bot Error*\n${bot.name}\nError: ${error.message}`
        );
      }
    }
  }
}

export default MarketMakerBotMonitor;


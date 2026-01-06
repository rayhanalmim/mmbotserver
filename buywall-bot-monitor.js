import 'dotenv/config';
import crypto from 'crypto';
import telegramService from './telegram-service.js';

const GCBEX_OPEN_API_BASE = process.env.GCBEX_OPEN_API_BASE || 'https://openapi.gcbex.com';

class BuyWallBotMonitor {
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
    const emoji = type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warning' ? '⚠️' : 'ℹ️';
    console.log(`${emoji} [BuyWallBot] ${message}`, data ? JSON.stringify(data) : '');
  }

  async start() {
    if (this.isRunning) {
      this.log('warning', 'Buy Wall Bot monitor already running');
      return;
    }

    this.isRunning = true;
    this.log('success', 'Buy Wall Bot monitor started');

    // Check every 5 seconds
    this.checkInterval = setInterval(() => this.checkBuyWallBots(), 5000);
    
    // Initial check
    await this.checkBuyWallBots();
  }

  async stop() {
    if (!this.isRunning) {
      this.log('warning', 'Buy Wall Bot monitor not running');
      return;
    }

    this.isRunning = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.log('info', 'Buy Wall Bot monitor stopped');
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

  async getOpenOrders(user, symbol = 'GCBUSDT') {
    try {
      const timestamp = Date.now().toString();
      const method = 'GET';
      const requestPath = '/sapi/v2/openOrders';
      const queryString = `symbol=${symbol}`;
      const message = `${timestamp}${method}${requestPath}?${queryString}`;
      const signature = crypto.createHmac('sha256', user.apiSecret).update(message).digest('hex');

      const response = await fetch(`${GCBEX_OPEN_API_BASE}${requestPath}?${queryString}`, {
        method: 'GET',
        headers: {
          'X-CH-APIKEY': user.apiKey,
          'X-CH-TS': timestamp,
          'X-CH-SIGN': signature,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      
      if (Array.isArray(data)) {
        return data;
      } else if (data.list && Array.isArray(data.list)) {
        return data.list;
      }
      return [];
    } catch (error) {
      this.log('error', `Failed to fetch open orders: ${error.message}`);
      return [];
    }
  }

  async placeLimitBuyOrder(user, symbol, price, usdtAmount, symbolInfo) {
    try {
      // Calculate GCB quantity from USDT amount
      const gcbQuantity = usdtAmount / price;
      
      // Get precision from symbol info
      const pricePrecision = symbolInfo?.quotePrecision || 6;
      const quantityPrecision = symbolInfo?.basePrecision || 2;

      const orderBody = {
        symbol: symbol.toUpperCase(),
        side: 'BUY',
        type: 'LIMIT',
        volume: gcbQuantity.toFixed(quantityPrecision),
        price: price.toFixed(pricePrecision),
        timeInForce: 'GTC'
      };

      const timestamp = Date.now().toString();
      const method = 'POST';
      const requestPath = '/sapi/v2/order';
      const bodyJson = JSON.stringify(orderBody, null, 0).replace(/\s/g, '');
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

      const result = await response.json();

      if (result.orderId) {
        return { success: true, orderId: result.orderId, price, usdtAmount, gcbQuantity };
      } else {
        return { success: false, error: result.msg || 'Order failed', price, usdtAmount };
      }
    } catch (error) {
      return { success: false, error: error.message, price, usdtAmount };
    }
  }

  async getSymbolInfo(symbol = 'GCBUSDT') {
    try {
      const response = await fetch(`${GCBEX_OPEN_API_BASE}/sapi/v1/symbols`);
      const data = await response.json();
      if (data.symbols) {
        const symbolInfo = data.symbols.find(s => s.symbol.toUpperCase() === symbol.toUpperCase());
        return symbolInfo || { basePrecision: 2, quotePrecision: 6 };
      }
      return { basePrecision: 2, quotePrecision: 6 };
    } catch (error) {
      return { basePrecision: 2, quotePrecision: 6 };
    }
  }

  async checkBuyWallBots() {
    if (!this.isRunning) return;

    try {
      // Get all active buy wall bots
      const bots = await this.db.collection('buywall_bots').find({
        isActive: true,
        isRunning: true
      }).toArray();

      if (bots.length === 0) {
        return;
      }

      // Get users with bot enabled
      const enabledUsers = await this.db.collection('users').find({
        botEnabled: true,
        apiKey: { $exists: true },
        apiSecret: { $exists: true }
      }).toArray();

      const enabledUserIds = new Set(enabledUsers.map(u => u.uid));

      for (const bot of bots) {
        if (!enabledUserIds.has(bot.userId)) {
          continue;
        }

        const user = enabledUsers.find(u => u.uid === bot.userId);
        if (!user) continue;

        await this.monitorAndManageBuyWall(bot, user);
      }
    } catch (error) {
      this.log('error', `Error checking buy wall bots: ${error.message}`);
    }
  }

  async monitorAndManageBuyWall(bot, user) {
    const botId = bot._id.toString();
    
    // Check if this bot is already being processed (prevent race condition)
    if (this.processingBots.has(botId)) {
      this.log('info', `[${bot.name}] Already processing, skipping...`);
      return;
    }
    
    const symbol = bot.symbol || 'GCBUSDT';

    try {
      // Get current market price
      const marketPrice = await this.getMarketPrice(symbol);
      if (!marketPrice) {
        this.log('error', `Could not get market price for ${symbol}`);
        return;
      }

      const targetPrice = bot.targetPrice;
      const buyOrders = bot.buyOrders || []; // Array of { price, usdtAmount }

      this.log('info', `[${bot.name}] Market: $${marketPrice.toFixed(6)}, Target: $${targetPrice.toFixed(6)}`);

      // Check if price is at or below target
      if (marketPrice > targetPrice && !bot.ordersPlaced) {
        this.log('info', `[${bot.name}] Price above target, waiting...`);
        return;
      }

      const symbolInfo = await this.getSymbolInfo(symbol);

      // If orders haven't been placed yet and price hit target
      if (!bot.ordersPlaced && marketPrice <= targetPrice) {
        // Add to processing set to prevent duplicate processing
        this.processingBots.add(botId);
        
        try {
          // FIRST: Mark as placed in DB to prevent race condition
          await this.db.collection('buywall_bots').updateOne(
            { _id: bot._id },
            { $set: { ordersPlaced: true, updatedAt: new Date() } }
          );
          
          this.log('success', `[${bot.name}] Price hit target! Placing all buy wall orders...`);
          await this.placeAllBuyOrders(bot, user, symbolInfo);
        } finally {
          // Remove from processing set
          this.processingBots.delete(botId);
        }
        return;
      }

      // If orders are already placed, monitor and refill
      if (bot.ordersPlaced) {
        await this.monitorAndRefillOrders(bot, user, symbolInfo, marketPrice);
      }

    } catch (error) {
      this.log('error', `Error managing buy wall bot ${bot.name}: ${error.message}`);
    }
  }

  async placeAllBuyOrders(bot, user, symbolInfo) {
    const buyOrders = bot.buyOrders || [];
    const placedOrders = [];
    const failedOrders = [];

    for (const order of buyOrders) {
      const result = await this.placeLimitBuyOrder(
        user,
        bot.symbol || 'GCBUSDT',
        order.price,
        order.usdtAmount,
        symbolInfo
      );

      if (result.success) {
        placedOrders.push({
          price: order.price,
          usdtAmount: order.usdtAmount,
          orderId: result.orderId,
          gcbQuantity: result.gcbQuantity,
          placedAt: new Date().toISOString(),
          status: 'OPEN'
        });

        this.log('success', `Placed buy order: ${order.usdtAmount} USDT at $${order.price}`);

        // Save trade record
        await this.db.collection('buywall_bot_trades').insertOne({
          botId: bot._id,
          botName: bot.name,
          userId: bot.userId,
          symbol: bot.symbol || 'GCBUSDT',
          side: 'BUY',
          type: 'LIMIT',
          price: order.price,
          usdtAmount: order.usdtAmount,
          gcbQuantity: result.gcbQuantity,
          orderId: result.orderId,
          action: 'INITIAL_PLACE',
          status: 'success',
          executedAt: new Date()
        });

      } else {
        failedOrders.push({
          price: order.price,
          usdtAmount: order.usdtAmount,
          error: result.error
        });
        this.log('error', `Failed to place order at $${order.price}: ${result.error}`);
      }

      // Small delay between orders
      await this.sleep(500);
    }

    // Update bot with placed orders info (ordersPlaced already set to true before calling this)
    await this.db.collection('buywall_bots').updateOne(
      { _id: bot._id },
      {
        $set: {
          placedOrders: placedOrders,
          failedOrders: failedOrders,
          lastPlacedAt: new Date(),
          updatedAt: new Date()
        }
      }
    );

    // Log activity
    await this.db.collection('buywall_bot_logs').insertOne({
      botId: bot._id,
      botName: bot.name,
      userId: bot.userId,
      action: 'INITIAL_PLACE',
      message: `Placed ${placedOrders.length} orders, ${failedOrders.length} failed`,
      details: { placedOrders, failedOrders },
      timestamp: new Date()
    });

    // Send Telegram notification
    await this.notifyOrdersPlaced(bot, placedOrders, failedOrders);
  }

  async monitorAndRefillOrders(bot, user, symbolInfo, marketPrice) {
    const symbol = bot.symbol || 'GCBUSDT';
    
    // Get current open orders from exchange
    const openOrders = await this.getOpenOrders(user, symbol);
    const openOrderIds = new Set(openOrders.map(o => o.orderId?.toString()));

    // Get our tracked placed orders
    const placedOrders = bot.placedOrders || [];
    
    // Find orders that are no longer open (filled or partially filled)
    const filledOrders = [];
    const stillOpenOrders = [];

    for (const order of placedOrders) {
      if (!openOrderIds.has(order.orderId?.toString())) {
        filledOrders.push(order);
      } else {
        // Check if partially filled
        const exchangeOrder = openOrders.find(o => o.orderId?.toString() === order.orderId?.toString());
        if (exchangeOrder) {
          const executedQty = parseFloat(exchangeOrder.executedQty || 0);
          const originalQty = parseFloat(order.gcbQuantity || 0);
          
          if (executedQty > 0 && executedQty < originalQty) {
            // Partially filled
            const remainingQty = originalQty - executedQty;
            order.remainingQuantity = remainingQty;
            order.executedQuantity = executedQty;
            order.partiallyFilled = true;
          }
          stillOpenOrders.push(order);
        }
      }
    }

    if (filledOrders.length === 0) {
      return; // No orders filled, nothing to do
    }

    this.log('info', `[${bot.name}] ${filledOrders.length} orders filled, refilling...`);

    // Re-place filled orders
    const refilledOrders = [];
    const refillFailures = [];

    for (const order of filledOrders) {
      // Check if we need to top up a partially filled order first
      // Find if there's a corresponding order in stillOpenOrders that was partially filled
      const partialOrder = stillOpenOrders.find(o => 
        o.partiallyFilled && 
        Math.abs(o.price - order.price) < 0.0000001
      );

      if (partialOrder) {
        // Top up the partial order first
        const filledUsdtAmount = partialOrder.executedQuantity * partialOrder.price;
        this.log('info', `Topping up partial order at $${partialOrder.price}, filled: ${filledUsdtAmount.toFixed(2)} USDT`);
        
        // Place order for the filled amount
        const topupResult = await this.placeLimitBuyOrder(
          user,
          symbol,
          partialOrder.price,
          filledUsdtAmount,
          symbolInfo
        );

        if (topupResult.success) {
          refilledOrders.push({
            price: partialOrder.price,
            usdtAmount: filledUsdtAmount,
            orderId: topupResult.orderId,
            gcbQuantity: topupResult.gcbQuantity,
            action: 'TOPUP_PARTIAL',
            placedAt: new Date().toISOString()
          });

          await this.db.collection('buywall_bot_trades').insertOne({
            botId: bot._id,
            botName: bot.name,
            userId: bot.userId,
            symbol: symbol,
            side: 'BUY',
            type: 'LIMIT',
            price: partialOrder.price,
            usdtAmount: filledUsdtAmount,
            gcbQuantity: topupResult.gcbQuantity,
            orderId: topupResult.orderId,
            action: 'TOPUP_PARTIAL',
            status: 'success',
            executedAt: new Date()
          });

          this.log('success', `Topped up partial: ${filledUsdtAmount.toFixed(2)} USDT at $${partialOrder.price}`);
        }

        // Reset partial flag
        partialOrder.partiallyFilled = false;
        partialOrder.executedQuantity = 0;
        partialOrder.remainingQuantity = 0;

        await this.sleep(500);
      }

      // Now refill the completely filled order
      const result = await this.placeLimitBuyOrder(
        user,
        symbol,
        order.price,
        order.usdtAmount,
        symbolInfo
      );

      if (result.success) {
        refilledOrders.push({
          price: order.price,
          usdtAmount: order.usdtAmount,
          orderId: result.orderId,
          gcbQuantity: result.gcbQuantity,
          action: 'REFILL',
          placedAt: new Date().toISOString(),
          status: 'OPEN'
        });

        await this.db.collection('buywall_bot_trades').insertOne({
          botId: bot._id,
          botName: bot.name,
          userId: bot.userId,
          symbol: symbol,
          side: 'BUY',
          type: 'LIMIT',
          price: order.price,
          usdtAmount: order.usdtAmount,
          gcbQuantity: result.gcbQuantity,
          orderId: result.orderId,
          action: 'REFILL',
          status: 'success',
          executedAt: new Date()
        });

        this.log('success', `Refilled order: ${order.usdtAmount} USDT at $${order.price}`);
      } else {
        refillFailures.push({
          price: order.price,
          usdtAmount: order.usdtAmount,
          error: result.error
        });
        this.log('error', `Failed to refill at $${order.price}: ${result.error}`);
      }

      await this.sleep(500);
    }

    // Update bot with new order tracking
    const updatedPlacedOrders = [
      ...stillOpenOrders.filter(o => !o.partiallyFilled || o.remainingQuantity > 0),
      ...refilledOrders.filter(o => o.action === 'REFILL')
    ];

    // Merge with original order config to maintain order list
    const originalOrders = bot.buyOrders || [];
    const newPlacedOrders = originalOrders.map(orig => {
      const refilled = refilledOrders.find(r => Math.abs(r.price - orig.price) < 0.0000001 && r.action === 'REFILL');
      const stillOpen = stillOpenOrders.find(s => Math.abs(s.price - orig.price) < 0.0000001);
      
      if (refilled) {
        return {
          ...orig,
          orderId: refilled.orderId,
          gcbQuantity: refilled.gcbQuantity,
          placedAt: refilled.placedAt,
          status: 'OPEN'
        };
      } else if (stillOpen) {
        return stillOpen;
      }
      return orig;
    });

    await this.db.collection('buywall_bots').updateOne(
      { _id: bot._id },
      {
        $set: {
          placedOrders: newPlacedOrders,
          lastRefillAt: new Date(),
          updatedAt: new Date()
        },
        $inc: {
          totalRefills: refilledOrders.length
        }
      }
    );

    // Log refill activity
    await this.db.collection('buywall_bot_logs').insertOne({
      botId: bot._id,
      botName: bot.name,
      userId: bot.userId,
      action: 'REFILL',
      message: `Refilled ${refilledOrders.length} orders, ${refillFailures.length} failed`,
      details: { 
        filledOrders,
        refilledOrders,
        refillFailures,
        marketPrice
      },
      timestamp: new Date()
    });

    // Send Telegram notification
    if (refilledOrders.length > 0 || refillFailures.length > 0) {
      await this.notifyOrdersRefilled(bot, filledOrders, refilledOrders, refillFailures, marketPrice);
    }
  }

  async notifyOrdersPlaced(bot, placedOrders, failedOrders) {
    const totalUsdt = placedOrders.reduce((sum, o) => sum + o.usdtAmount, 0);
    
    let message = `<b>🧱 Buy Wall Bot - Orders Placed</b>\n\n`;
    message += `🤖 <b>Bot:</b> ${bot.name}\n`;
    message += `💱 <b>Symbol:</b> ${bot.symbol || 'GCBUSDT'}\n`;
    message += `✅ <b>Placed:</b> ${placedOrders.length} orders\n`;
    message += `💵 <b>Total USDT:</b> $${totalUsdt.toFixed(2)}\n`;
    
    if (failedOrders.length > 0) {
      message += `❌ <b>Failed:</b> ${failedOrders.length} orders\n`;
    }
    
    message += `\n<b>Orders:</b>\n`;
    for (const order of placedOrders.slice(0, 10)) {
      message += `  • $${order.price.toFixed(6)} = ${order.usdtAmount} USDT\n`;
    }
    if (placedOrders.length > 10) {
      message += `  ... and ${placedOrders.length - 10} more\n`;
    }
    
    message += `\n⏰ <b>Time (UTC):</b> ${new Date().toUTCString()}`;
    
    await telegramService.sendMessage(message);
  }

  async notifyOrdersRefilled(bot, filledOrders, refilledOrders, refillFailures, marketPrice) {
    let message = `<b>🔄 Buy Wall Bot - Orders Refilled</b>\n\n`;
    message += `🤖 <b>Bot:</b> ${bot.name}\n`;
    message += `💱 <b>Symbol:</b> ${bot.symbol || 'GCBUSDT'}\n`;
    message += `📊 <b>Market Price:</b> $${marketPrice.toFixed(6)}\n`;
    message += `📥 <b>Orders Filled:</b> ${filledOrders.length}\n`;
    message += `🔄 <b>Refilled:</b> ${refilledOrders.length} orders\n`;
    
    const totalRefilled = refilledOrders.reduce((sum, o) => sum + o.usdtAmount, 0);
    message += `💵 <b>Total Refilled:</b> $${totalRefilled.toFixed(2)} USDT\n`;
    
    if (refillFailures.length > 0) {
      message += `❌ <b>Failed:</b> ${refillFailures.length} orders\n`;
    }
    
    message += `\n<b>Refilled Orders:</b>\n`;
    for (const order of refilledOrders.slice(0, 5)) {
      const action = order.action === 'TOPUP_PARTIAL' ? '(topup)' : '';
      message += `  • $${order.price.toFixed(6)} = ${order.usdtAmount.toFixed(2)} USDT ${action}\n`;
    }
    if (refilledOrders.length > 5) {
      message += `  ... and ${refilledOrders.length - 5} more\n`;
    }
    
    message += `\n⏰ <b>Time (UTC):</b> ${new Date().toUTCString()}`;
    
    await telegramService.sendMessage(message);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default BuyWallBotMonitor;

import xtTelegramService from './xt-telegram-service.js';
import { generateXtSignature, buildSignatureMessage, getXtTimestamp, syncXtServerTime } from './xt-user-routes.js';

const XT_BASE_URL = process.env.XT_BASE_URL || 'https://sapi.xt.com';

/**
 * XT Liquidity Bot Monitor
 * 
 * Fulfills XT exchange liquidity requirements:
 * 1. Bid-Ask Spread < 1%
 * 2. Order Depth ≥ 500 USDT within ±2% of Mid-Price
 * 3. Price gap between adjacent orders ≤ 1% in top 20
 * 4. Top 20 buy/sell cumulative depth ≥ 1,000 USDT each
 * 5. Minimum 30 buy orders + 30 sell orders
 * 
 * Supports dynamic scaling (e.g., 1000 USDT = 10 USDT for testing)
 * Reuses existing orderbook to minimize USDT usage
 */
class XtLiquidityBotMonitor {
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
    const emoji = type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warning' ? '⚠️' : type === 'trade' ? '💱' : type === 'liquidity' ? '💧' : 'ℹ️';
    console.log(`${emoji} [XtLiquidityBot] ${message}`, data ? JSON.stringify(data).substring(0, 200) : '');
  }

  async start() {
    if (this.isRunning) {
      this.log('warning', 'XT Liquidity Bot monitor already running');
      return;
    }

    this.isRunning = true;
    this.log('success', 'XT Liquidity Bot monitor started');

    // Check every 10 seconds (liquidity maintenance doesn't need to be as frequent)
    this.checkInterval = setInterval(() => this.checkAllLiquidityBots(), 10000);
    
    // Initial check
    await this.checkAllLiquidityBots();
  }

  async stop() {
    if (!this.isRunning) {
      this.log('warning', 'XT Liquidity Bot monitor not running');
      return;
    }

    this.isRunning = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.log('info', 'XT Liquidity Bot monitor stopped');
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

  // Get full order book depth
  async getOrderBook(symbol = 'gcb_usdt', limit = 100) {
    try {
      const response = await fetch(`${XT_BASE_URL}/v4/public/depth?symbol=${symbol}&limit=${limit}`);
      const data = await response.json();
      
      if (data.rc === 0 && data.result) {
        return {
          bids: data.result.bids || [], // [[price, qty], ...]
          asks: data.result.asks || [],
          timestamp: data.result.timestamp
        };
      }
      return null;
    } catch (error) {
      this.log('error', `Failed to fetch order book: ${error.message}`);
      return null;
    }
  }

  // Get market price
  async getMarketPrice(symbol = 'gcb_usdt') {
    try {
      const response = await fetch(`${XT_BASE_URL}/v4/public/ticker/price?symbol=${symbol}`);
      const data = await response.json();
      if (data.rc === 0 && data.result && data.result.length > 0) {
        return parseFloat(data.result[0].p);
      }
      return null;
    } catch (error) {
      this.log('error', `Failed to fetch market price: ${error.message}`);
      return null;
    }
  }

  // Get symbol info for precision
  async getSymbolInfo(symbol = 'gcb_usdt') {
    try {
      const response = await fetch(`${XT_BASE_URL}/v4/public/symbol?symbol=${symbol}`);
      const data = await response.json();
      if (data.rc === 0 && data.result?.symbols?.length > 0) {
        return data.result.symbols[0];
      }
      return null;
    } catch (error) {
      this.log('error', `Failed to fetch symbol info: ${error.message}`);
      return null;
    }
  }

  async getUserCredentials(mexcUserId) {
    try {
      const xtUser = await this.db.collection('xt_users').findOne({ mexcUserId });
      if (!xtUser) return null;
      return { apiKey: xtUser.apiKey, apiSecret: xtUser.apiSecret };
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
            availableAmount: parseFloat(asset.availableAmount) || 0,
            frozenAmount: parseFloat(asset.frozenAmount) || 0,
            totalAmount: parseFloat(asset.totalAmount) || 0
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

  // Get user's open orders
  async getOpenOrders(apiKey, apiSecret, symbol = 'gcb_usdt') {
    try {
      const data = await this.makeXtRequest(apiKey, apiSecret, 'GET', '/v4/open-order', `symbol=${symbol}&bizType=SPOT`);
      if (data.rc === 0) {
        return data.result || [];
      }
      return [];
    } catch (error) {
      this.log('error', `Failed to fetch open orders: ${error.message}`);
      return [];
    }
  }

  // Place a single limit order
  async placeLimitOrder(apiKey, apiSecret, symbol, side, price, quantity) {
    try {
      const orderBody = {
        symbol: symbol.toLowerCase(),
        side: side.toUpperCase(),
        type: 'LIMIT',
        timeInForce: 'GTC',
        bizType: 'SPOT',
        price: price.toString(),
        quantity: quantity.toString()
      };

      const data = await this.makeXtRequest(apiKey, apiSecret, 'POST', '/v4/order', '', orderBody);

      if (data.rc === 0 && data.result?.orderId) {
        return { success: true, orderId: data.result.orderId };
      } else {
        return { success: false, error: data.mc || 'Order failed' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Place batch orders
  async placeBatchOrders(apiKey, apiSecret, orders) {
    try {
      const items = orders.map((order, index) => ({
        symbol: order.symbol.toLowerCase(),
        clientOrderId: `liq_${Date.now()}_${index}`,
        side: order.side.toUpperCase(),
        type: 'LIMIT',
        timeInForce: 'GTC',
        bizType: 'SPOT',
        price: order.price,
        quantity: order.quantity
      }));

      const batchBody = {
        clientBatchId: `liquidity_${Date.now()}`,
        items: items
      };

      const data = await this.makeXtRequest(apiKey, apiSecret, 'POST', '/v4/batch-order', '', batchBody);

      if (data.rc === 0) {
        return { success: true, result: data.result };
      } else {
        return { success: false, error: data.mc || 'Batch order failed' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Cancel an order
  async cancelOrder(apiKey, apiSecret, orderId) {
    try {
      const data = await this.makeXtRequest(apiKey, apiSecret, 'DELETE', `/v4/order/${orderId}`);
      return data.rc === 0;
    } catch (error) {
      this.log('error', `Failed to cancel order ${orderId}: ${error.message}`);
      return false;
    }
  }

  // Cancel ALL open orders for a symbol (uses DELETE /v4/open-order)
  async cancelAllOpenOrders(apiKey, apiSecret, symbol = 'gcb_usdt', side = null) {
    try {
      const cancelBody = {
        bizType: 'SPOT',
        symbol: symbol.toLowerCase()
      };
      
      if (side) {
        cancelBody.side = side.toUpperCase();
      }

      this.log('info', `🗑️ Cancelling all ${side || ''} open orders for ${symbol}...`);
      
      const data = await this.makeXtRequest(apiKey, apiSecret, 'DELETE', '/v4/open-order', '', cancelBody);

      if (data.rc === 0) {
        this.log('success', `✅ Cancelled all ${side || ''} open orders for ${symbol}`);
        return { success: true, data: data.result };
      } else {
        this.log('error', `Failed to cancel orders: ${data.mc}`);
        return { success: false, error: data.mc || 'Cancel failed' };
      }
    } catch (error) {
      this.log('error', `Error cancelling all orders: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // Cancel batch orders by order IDs
  async cancelBatchOrders(apiKey, apiSecret, orderIds) {
    try {
      if (!orderIds || orderIds.length === 0) {
        return { success: true, cancelled: 0 };
      }

      const cancelBody = {
        orderIds: orderIds.map(id => id.toString())
      };

      const data = await this.makeXtRequest(apiKey, apiSecret, 'DELETE', '/v4/batch-order', '', cancelBody);

      if (data.rc === 0) {
        this.log('success', `✅ Cancelled ${orderIds.length} orders`);
        return { success: true, cancelled: orderIds.length };
      } else {
        return { success: false, error: data.mc || 'Batch cancel failed' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Force immediate liquidity adjustment (bypasses cooldown, enables autoManage temporarily)
  async forceAdjustLiquidity(bot) {
    const botId = bot._id.toString();
    this.log('info', `🔧 Force adjusting liquidity for [${bot.name}]`);

    try {
      const symbol = bot.symbol || 'gcb_usdt';
      
      const credentials = await this.getUserCredentials(bot.mexcUserId);
      if (!credentials) {
        this.log('error', `[${bot.name}] XT credentials not found`);
        return { success: false, error: 'Credentials not found' };
      }

      // Get market data
      const [orderBook, marketPrice, symbolInfo] = await Promise.all([
        this.getOrderBook(symbol, 100),
        this.getMarketPrice(symbol),
        this.getSymbolInfo(symbol)
      ]);

      if (!orderBook || !marketPrice) {
        this.log('error', `[${bot.name}] Could not fetch market data`);
        return { success: false, error: 'Could not fetch market data' };
      }

      // Analyze with autoManage forced on
      const tempBot = { ...bot, autoManage: true };
      const analysis = this.analyzeLiquidity(orderBook, marketPrice, tempBot);

      // Check balance
      const balances = await this.getAccountBalance(credentials.apiKey, credentials.apiSecret);
      if (!balances) {
        return { success: false, error: 'Could not fetch balance' };
      }

      // Generate and place orders
      const neededOrders = this.generateNeededOrders(analysis, tempBot, symbolInfo);
      
      let ordersPlaced = 0;
      let ordersFailed = 0;

      // Place buy orders
      if (neededOrders.buys.length > 0) {
        const buyBatches = this.chunkArray(neededOrders.buys.map(o => ({
          symbol,
          side: 'BUY',
          price: o.price,
          quantity: o.quantity
        })), 10);

        for (const batch of buyBatches) {
          const result = await this.placeBatchOrders(credentials.apiKey, credentials.apiSecret, batch);
          if (result.success) {
            ordersPlaced += batch.length;
          } else {
            ordersFailed += batch.length;
          }
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }

      // Place sell orders
      if (neededOrders.sells.length > 0) {
        const sellBatches = this.chunkArray(neededOrders.sells.map(o => ({
          symbol,
          side: 'SELL',
          price: o.price,
          quantity: o.quantity
        })), 10);

        for (const batch of sellBatches) {
          const result = await this.placeBatchOrders(credentials.apiKey, credentials.apiSecret, batch);
          if (result.success) {
            ordersPlaced += batch.length;
          } else {
            ordersFailed += batch.length;
          }
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }

      // Update bot stats
      await this.db.collection('xt_liquidity_bots').updateOne(
        { _id: bot._id },
        { 
          $inc: { totalOrdersPlaced: ordersPlaced, totalMaintenance: 1 },
          $set: { lastMaintenanceAt: new Date(), lastCheckedAt: new Date() }
        }
      );

      this.log('success', `[${bot.name}] Force adjustment complete: ${ordersPlaced} orders placed`);
      return { success: true, ordersPlaced, ordersFailed };

    } catch (error) {
      this.log('error', `[${bot.name}] Force adjust error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Analyze current liquidity status
   * Returns metrics about current orderbook vs requirements
   */
  analyzeLiquidity(orderBook, midPrice, config) {
    const scale = config.scaleFactor || 1; // e.g., 0.01 means 1000 USDT = 10 USDT
    
    // Scale the requirements
    const minDepth2Pct = (config.minDepth2Percent || 500) * scale;
    const minDepthTop20 = (config.minDepthTop20 || 1000) * scale;
    const minOrderCount = config.minOrderCount || 30;
    const maxSpread = config.maxSpread || 1; // 1%
    const maxGap = config.maxOrderGap || 1; // 1%

    const analysis = {
      midPrice,
      buyOrders: [],
      sellOrders: [],
      metrics: {
        spread: 0,
        spreadOk: false,
        buyDepth2Pct: 0,
        sellDepth2Pct: 0,
        depth2PctOk: false,
        buyDepthTop20: 0,
        sellDepthTop20: 0,
        depthTop20Ok: false,
        buyOrderCount: 0,
        sellOrderCount: 0,
        orderCountOk: false,
        buyGapsOk: true,
        sellGapsOk: true,
        gapIssues: []
      },
      neededOrders: {
        buys: [],
        sells: []
      }
    };

    const bids = orderBook.bids.map(b => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) }));
    const asks = orderBook.asks.map(a => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) }));

    // Sort bids descending (highest first), asks ascending (lowest first)
    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);

    analysis.buyOrders = bids;
    analysis.sellOrders = asks;

    // 1. Calculate spread
    if (bids.length > 0 && asks.length > 0) {
      const bestBid = bids[0].price;
      const bestAsk = asks[0].price;
      const calculatedMid = (bestBid + bestAsk) / 2;
      analysis.metrics.spread = ((bestAsk - bestBid) / calculatedMid) * 100;
      analysis.metrics.spreadOk = analysis.metrics.spread < maxSpread;
    }

    // 2. Calculate depth within ±2% of mid-price
    const buyLowerBound = midPrice * 0.98;
    const sellUpperBound = midPrice * 1.02;

    analysis.metrics.buyDepth2Pct = bids
      .filter(b => b.price >= buyLowerBound && b.price <= midPrice)
      .reduce((sum, b) => sum + (b.price * b.qty), 0);
    
    analysis.metrics.sellDepth2Pct = asks
      .filter(a => a.price >= midPrice && a.price <= sellUpperBound)
      .reduce((sum, a) => sum + (a.price * a.qty), 0);

    analysis.metrics.depth2PctOk = 
      analysis.metrics.buyDepth2Pct >= minDepth2Pct && 
      analysis.metrics.sellDepth2Pct >= minDepth2Pct;

    // 3. Calculate top 20 cumulative depth
    const top20Bids = bids.slice(0, 20);
    const top20Asks = asks.slice(0, 20);

    analysis.metrics.buyDepthTop20 = top20Bids.reduce((sum, b) => sum + (b.price * b.qty), 0);
    analysis.metrics.sellDepthTop20 = top20Asks.reduce((sum, a) => sum + (a.price * a.qty), 0);

    analysis.metrics.depthTop20Ok = 
      analysis.metrics.buyDepthTop20 >= minDepthTop20 && 
      analysis.metrics.sellDepthTop20 >= minDepthTop20;

    // 4. Count orders
    analysis.metrics.buyOrderCount = bids.length;
    analysis.metrics.sellOrderCount = asks.length;
    analysis.metrics.orderCountOk = 
      bids.length >= minOrderCount && 
      asks.length >= minOrderCount;

    // 5. Check gaps in top 20
    for (let i = 0; i < Math.min(19, top20Bids.length - 1); i++) {
      const gap = ((top20Bids[i].price - top20Bids[i + 1].price) / top20Bids[i].price) * 100;
      if (gap > maxGap) {
        analysis.metrics.buyGapsOk = false;
        analysis.metrics.gapIssues.push({ side: 'BUY', index: i, gap: gap.toFixed(2) });
      }
    }

    for (let i = 0; i < Math.min(19, top20Asks.length - 1); i++) {
      const gap = ((top20Asks[i + 1].price - top20Asks[i].price) / top20Asks[i].price) * 100;
      if (gap > maxGap) {
        analysis.metrics.sellGapsOk = false;
        analysis.metrics.gapIssues.push({ side: 'SELL', index: i, gap: gap.toFixed(2) });
      }
    }

    return analysis;
  }

  /**
   * Generate orders needed to fulfill liquidity requirements
   */
  generateNeededOrders(analysis, config, symbolInfo) {
    const orders = { buys: [], sells: [] };
    const midPrice = analysis.midPrice;
    const scale = config.scaleFactor || 1;
    
    // Get precision from symbol info
    const pricePrecision = symbolInfo?.pricePrecision || 6;
    const qtyPrecision = symbolInfo?.quantityPrecision || 2;
    
    const minDepth2Pct = (config.minDepth2Percent || 500) * scale;
    const minDepthTop20 = (config.minDepthTop20 || 1000) * scale;
    const minOrderCount = config.minOrderCount || 30;
    const orderSize = (config.orderSizeUsdt || 20) * scale;
    const maxGap = config.maxOrderGap || 1;

    // Helper to format price
    const formatPrice = (price) => parseFloat(price.toFixed(pricePrecision));
    const formatQty = (qty) => parseFloat(qty.toFixed(qtyPrecision));

    // Calculate how many more orders needed
    const buyOrdersNeeded = Math.max(0, minOrderCount - analysis.metrics.buyOrderCount);
    const sellOrdersNeeded = Math.max(0, minOrderCount - analysis.metrics.sellOrderCount);

    // Calculate depth shortfall
    const buyDepthNeeded = Math.max(0, minDepth2Pct - analysis.metrics.buyDepth2Pct);
    const sellDepthNeeded = Math.max(0, minDepth2Pct - analysis.metrics.sellDepth2Pct);

    // Generate buy orders to fill gaps and meet requirements
    if (buyOrdersNeeded > 0 || buyDepthNeeded > 0 || !analysis.metrics.buyGapsOk) {
      const existingBuyPrices = new Set(analysis.buyOrders.map(b => formatPrice(b.price)));
      let currentPrice = midPrice * 0.999; // Start just below mid
      let ordersAdded = 0;
      let depthAdded = 0;
      const maxOrders = Math.max(buyOrdersNeeded, 30);

      while ((ordersAdded < maxOrders || depthAdded < buyDepthNeeded) && currentPrice > midPrice * 0.90) {
        const price = formatPrice(currentPrice);
        
        // Don't add if price already exists
        if (!existingBuyPrices.has(price)) {
          const quantity = formatQty(orderSize / price);
          if (quantity > 0) {
            orders.buys.push({ price: price.toString(), quantity: quantity.toString() });
            depthAdded += orderSize;
            ordersAdded++;
          }
        }
        
        // Step down by ~0.5% to ensure gaps < 1%
        currentPrice = currentPrice * (1 - (maxGap / 200));
      }
    }

    // Generate sell orders to fill gaps and meet requirements
    if (sellOrdersNeeded > 0 || sellDepthNeeded > 0 || !analysis.metrics.sellGapsOk) {
      const existingSellPrices = new Set(analysis.sellOrders.map(a => formatPrice(a.price)));
      let currentPrice = midPrice * 1.001; // Start just above mid
      let ordersAdded = 0;
      let depthAdded = 0;
      const maxOrders = Math.max(sellOrdersNeeded, 30);

      while ((ordersAdded < maxOrders || depthAdded < sellDepthNeeded) && currentPrice < midPrice * 1.10) {
        const price = formatPrice(currentPrice);
        
        // Don't add if price already exists
        if (!existingSellPrices.has(price)) {
          const quantity = formatQty(orderSize / price);
          if (quantity > 0) {
            orders.sells.push({ price: price.toString(), quantity: quantity.toString() });
            depthAdded += orderSize;
            ordersAdded++;
          }
        }
        
        // Step up by ~0.5% to ensure gaps < 1%
        currentPrice = currentPrice * (1 + (maxGap / 200));
      }
    }

    return orders;
  }

  async checkAllLiquidityBots() {
    if (!this.isRunning) return;

    try {
      // Find all active liquidity bots
      const activeBots = await this.db.collection('xt_liquidity_bots').find({
        isActive: true,
        isRunning: true
      }).toArray();

      if (activeBots.length === 0) {
        return;
      }

      this.log('info', `🔍 Checking ${activeBots.length} active XT liquidity bot(s)`);

      for (const bot of activeBots) {
        await this.checkLiquidityBot(bot);
      }
    } catch (error) {
      this.log('error', 'Error checking XT liquidity bots', error.message);
    }
  }

  async checkLiquidityBot(bot) {
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

      // Re-fetch bot from DB
      const freshBot = await this.db.collection('xt_liquidity_bots').findOne({ _id: bot._id });
      if (!freshBot || !freshBot.isRunning) {
        return;
      }

      // Check cooldown
      const cooldownMs = (freshBot.checkIntervalSeconds || 30) * 1000;
      const lastChecked = freshBot.lastCheckedAt ? new Date(freshBot.lastCheckedAt).getTime() : 0;
      const now = Date.now();

      if (now - lastChecked < cooldownMs) {
        return;
      }

      // Get market data
      const [orderBook, marketPrice, symbolInfo] = await Promise.all([
        this.getOrderBook(symbol, 100),
        this.getMarketPrice(symbol),
        this.getSymbolInfo(symbol)
      ]);

      if (!orderBook || !marketPrice) {
        this.log('warning', `[${bot.name}] Could not fetch market data`);
        return;
      }

      const midPrice = marketPrice;

      // Analyze current liquidity
      const analysis = this.analyzeLiquidity(orderBook, midPrice, freshBot);

      // Store analysis in marketData for status endpoint
      this.marketData[symbol] = {
        midPrice,
        analysis: analysis.metrics,
        updatedAt: new Date().toISOString()
      };

      // Log current status
      this.log('liquidity', `[${bot.name}] 📊 Spread: ${analysis.metrics.spread.toFixed(3)}% | Buy Depth: $${analysis.metrics.buyDepth2Pct.toFixed(2)} | Sell Depth: $${analysis.metrics.sellDepth2Pct.toFixed(2)} | Orders: ${analysis.metrics.buyOrderCount}B/${analysis.metrics.sellOrderCount}S`);

      // Check if all requirements are met
      const allOk = analysis.metrics.spreadOk && 
                    analysis.metrics.depth2PctOk && 
                    analysis.metrics.depthTop20Ok && 
                    analysis.metrics.orderCountOk &&
                    analysis.metrics.buyGapsOk &&
                    analysis.metrics.sellGapsOk;

      // Update bot status
      await this.db.collection('xt_liquidity_bots').updateOne(
        { _id: bot._id },
        { 
          $set: { 
            lastCheckedAt: new Date(),
            lastMidPrice: midPrice,
            lastSpread: analysis.metrics.spread,
            lastBuyDepth: analysis.metrics.buyDepth2Pct,
            lastSellDepth: analysis.metrics.sellDepth2Pct,
            lastBuyOrderCount: analysis.metrics.buyOrderCount,
            lastSellOrderCount: analysis.metrics.sellOrderCount,
            liquidityOk: allOk,
            updatedAt: new Date()
          } 
        }
      );

      if (allOk) {
        this.log('success', `[${bot.name}] ✅ All liquidity requirements met`);
        return;
      }

      // Only place orders if autoManage is enabled
      if (!freshBot.autoManage) {
        this.log('info', `[${bot.name}] ⚠️ Liquidity issues detected but autoManage is disabled`);
        
        // Log issues
        if (!analysis.metrics.spreadOk) {
          this.log('warning', `[${bot.name}] Spread ${analysis.metrics.spread.toFixed(3)}% exceeds ${freshBot.maxSpread || 1}%`);
        }
        if (!analysis.metrics.depth2PctOk) {
          this.log('warning', `[${bot.name}] Depth ±2% insufficient - Buy: $${analysis.metrics.buyDepth2Pct.toFixed(2)}, Sell: $${analysis.metrics.sellDepth2Pct.toFixed(2)}`);
        }
        if (!analysis.metrics.orderCountOk) {
          this.log('warning', `[${bot.name}] Order count insufficient - Buy: ${analysis.metrics.buyOrderCount}, Sell: ${analysis.metrics.sellOrderCount}`);
        }
        if (!analysis.metrics.buyGapsOk || !analysis.metrics.sellGapsOk) {
          this.log('warning', `[${bot.name}] Gap issues in top 20: ${JSON.stringify(analysis.metrics.gapIssues)}`);
        }
        return;
      }

      // Check balance before placing orders
      const balances = await this.getAccountBalance(credentials.apiKey, credentials.apiSecret);
      if (!balances) {
        this.log('warning', `[${bot.name}] Could not fetch balance`);
        return;
      }

      const availableUsdt = balances.usdt?.availableAmount || 0;
      const availableGcb = balances.gcb?.availableAmount || 0;

      // Generate needed orders
      const neededOrders = this.generateNeededOrders(analysis, freshBot, symbolInfo);
      
      const totalBuyUsdt = neededOrders.buys.reduce((sum, o) => sum + parseFloat(o.price) * parseFloat(o.quantity), 0);
      const totalSellGcb = neededOrders.sells.reduce((sum, o) => sum + parseFloat(o.quantity), 0);

      this.log('info', `[${bot.name}] 📝 Need ${neededOrders.buys.length} buy orders ($${totalBuyUsdt.toFixed(2)} USDT) and ${neededOrders.sells.length} sell orders (${totalSellGcb.toFixed(2)} GCB)`);

      // Check if we have enough balance
      if (totalBuyUsdt > availableUsdt) {
        this.log('warning', `[${bot.name}] Insufficient USDT: need $${totalBuyUsdt.toFixed(2)}, have $${availableUsdt.toFixed(2)}`);
        // Reduce buy orders to fit budget
        const ratio = availableUsdt / totalBuyUsdt;
        neededOrders.buys = neededOrders.buys.slice(0, Math.floor(neededOrders.buys.length * ratio));
      }

      if (totalSellGcb > availableGcb) {
        this.log('warning', `[${bot.name}] Insufficient GCB: need ${totalSellGcb.toFixed(2)}, have ${availableGcb.toFixed(2)}`);
        // Reduce sell orders to fit budget
        const ratio = availableGcb / totalSellGcb;
        neededOrders.sells = neededOrders.sells.slice(0, Math.floor(neededOrders.sells.length * ratio));
      }

      // Place orders in batches
      let ordersPlaced = 0;
      let ordersFailed = 0;

      // Place buy orders
      if (neededOrders.buys.length > 0) {
        const buyBatches = this.chunkArray(neededOrders.buys.map(o => ({
          symbol,
          side: 'BUY',
          price: o.price,
          quantity: o.quantity
        })), 10); // Batch size of 10

        for (const batch of buyBatches) {
          const result = await this.placeBatchOrders(credentials.apiKey, credentials.apiSecret, batch);
          if (result.success) {
            ordersPlaced += batch.length;
            this.log('success', `[${bot.name}] Placed ${batch.length} buy orders`);
          } else {
            ordersFailed += batch.length;
            this.log('error', `[${bot.name}] Failed to place buy batch: ${result.error}`);
          }
          // Small delay between batches
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // Place sell orders
      if (neededOrders.sells.length > 0) {
        const sellBatches = this.chunkArray(neededOrders.sells.map(o => ({
          symbol,
          side: 'SELL',
          price: o.price,
          quantity: o.quantity
        })), 10);

        for (const batch of sellBatches) {
          const result = await this.placeBatchOrders(credentials.apiKey, credentials.apiSecret, batch);
          if (result.success) {
            ordersPlaced += batch.length;
            this.log('success', `[${bot.name}] Placed ${batch.length} sell orders`);
          } else {
            ordersFailed += batch.length;
            this.log('error', `[${bot.name}] Failed to place sell batch: ${result.error}`);
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // Log activity
      await this.db.collection('xt_liquidity_bot_logs').insertOne({
        mexcUserId: bot.mexcUserId,
        botId: botId,
        botName: bot.name,
        action: 'LIQUIDITY_MAINTENANCE',
        symbol: symbol,
        midPrice: midPrice,
        spread: analysis.metrics.spread,
        buyDepth: analysis.metrics.buyDepth2Pct,
        sellDepth: analysis.metrics.sellDepth2Pct,
        ordersPlaced: ordersPlaced,
        ordersFailed: ordersFailed,
        status: ordersFailed === 0 ? 'SUCCESS' : 'PARTIAL',
        message: `Placed ${ordersPlaced} orders (${ordersFailed} failed) to maintain liquidity`,
        createdAt: new Date()
      });

      // Update bot stats
      await this.db.collection('xt_liquidity_bots').updateOne(
        { _id: bot._id },
        { 
          $inc: {
            totalOrdersPlaced: ordersPlaced,
            totalMaintenance: 1
          },
          $set: {
            lastMaintenanceAt: new Date()
          }
        }
      );

      this.log('success', `[${bot.name}] ✅ Liquidity maintenance complete: ${ordersPlaced} orders placed`);

      // Send Telegram notification if enabled
      if (freshBot.telegramEnabled && ordersPlaced > 0) {
        try {
          await xtTelegramService.sendXtNotification(
            `<b>💧 XT Liquidity Bot Update</b>\n\n` +
            `🤖 <b>Bot:</b> ${bot.name}\n` +
            `💱 <b>Symbol:</b> ${symbol.toUpperCase()}\n` +
            `📊 <b>Mid Price:</b> $${midPrice.toFixed(6)}\n` +
            `📈 <b>Spread:</b> ${analysis.metrics.spread.toFixed(3)}%\n` +
            `💰 <b>Buy Depth:</b> $${analysis.metrics.buyDepth2Pct.toFixed(2)}\n` +
            `💰 <b>Sell Depth:</b> $${analysis.metrics.sellDepth2Pct.toFixed(2)}\n` +
            `📝 <b>Orders Placed:</b> ${ordersPlaced}\n\n` +
            `⏰ <b>Time:</b> ${new Date().toUTCString()}`
          );
        } catch (err) {
          this.log('warning', 'Telegram notification failed', err.message);
        }
      }

    } catch (error) {
      this.log('error', `[${bot.name}] Error: ${error.message}`);
    } finally {
      this.processingBots.delete(botId);
    }
  }

  // Helper to chunk array into smaller batches
  chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}

export default XtLiquidityBotMonitor;

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
      // XT API uses lowercase symbol format (e.g., gcb_usdt)
      const lowerSymbol = symbol.toLowerCase();
      const data = await this.makeXtRequest(apiKey, apiSecret, 'GET', '/v4/open-order', `symbol=${lowerSymbol}&bizType=SPOT`);
      
      if (data.rc === 0) {
        const orders = data.result || [];
        this.log('info', `📋 API returned ${orders.length} open orders for ${lowerSymbol}`);
        return orders;
      }
      
      this.log('warning', `Open orders API returned rc=${data.rc}, mc=${data.mc}`);
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

      // Get existing orders to avoid duplicates
      const myOpenOrders = await this.getOpenOrders(credentials.apiKey, credentials.apiSecret, symbol);
      const myBuyOrders = myOpenOrders.filter(o => o.side?.toUpperCase() === 'BUY');
      const mySellOrders = myOpenOrders.filter(o => o.side?.toUpperCase() === 'SELL');

      // Generate and place orders
      const neededOrders = this.generateNeededOrders(analysis, tempBot, symbolInfo, myBuyOrders, mySellOrders);
      
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
      // Store best bid/ask for spread tightening logic
      analysis.metrics.bestBid = bestBid;
      analysis.metrics.bestAsk = bestAsk;
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
   * Properly calculates depth needed and places orders to meet targets
   * 
   * Order count optimization:
   * - If market already has 10+ orders on BOTH sides, we only need 20 orders per side
   * - Otherwise, we need full 30 orders per side
   */
  generateNeededOrders(analysis, config, symbolInfo, myBuyOrders = [], mySellOrders = []) {
    const orders = { buys: [], sells: [] };
    const midPrice = analysis.midPrice;
    
    // Get precision from symbol info
    const pricePrecision = symbolInfo?.pricePrecision || 6;
    const qtyPrecision = symbolInfo?.quantityPrecision || 2;
    
    // Config values
    const targetDepth2Pct = config.minDepth2Percent || 500;  // Target depth within ±2%
    const targetDepthTop20 = config.minDepthTop20 || 1000;   // Target Top 20 cumulative depth
    const configMinOrderCount = config.minOrderCount || 30;
    
    // Helper functions
    const formatPrice = (price) => parseFloat(price.toFixed(pricePrecision));
    const formatQty = (qty) => Math.max(parseFloat(qty.toFixed(qtyPrecision)), 0.01);

    // Extract prices and track existing order prices to avoid duplicates
    const myBuyPrices = myBuyOrders.map(o => parseFloat(o.price || 0));
    const mySellPrices = mySellOrders.map(o => parseFloat(o.price || 0));
    const existingBuyPrices = new Set(myBuyPrices.map(p => formatPrice(p).toString()));
    const existingSellPrices = new Set(mySellPrices.map(p => formatPrice(p).toString()));

    // ===== ANALYZE CURRENT MARKET =====
    // Current total market depth (includes ALL orders)
    const totalBuyDepth = analysis.metrics?.buyDepth2Pct || 0;
    const totalSellDepth = analysis.metrics?.sellDepth2Pct || 0;
    
    // Get market order counts from analysis (total orders in orderbook)
    const marketBuyOrderCount = analysis.metrics?.buyOrderCount || 0;
    const marketSellOrderCount = analysis.metrics?.sellOrderCount || 0;
    
    // ===== DYNAMIC ORDER COUNT OPTIMIZATION =====
    // If market already has 10+ orders on BOTH sides, we only need 20 orders per side
    // This reduces our order quantity while still meeting the 30 total requirement
    const marketHasEnoughBuys = marketBuyOrderCount >= 10;
    const marketHasEnoughSells = marketSellOrderCount >= 10;
    
    let targetBuyOrderCount = configMinOrderCount;
    let targetSellOrderCount = configMinOrderCount;
    
    if (marketHasEnoughBuys && marketHasEnoughSells) {
      // Market already has 10+ orders on both sides, we only need 20 each
      targetBuyOrderCount = Math.min(20, configMinOrderCount);
      targetSellOrderCount = Math.min(20, configMinOrderCount);
      this.log('info', `📊 Market has ${marketBuyOrderCount}B/${marketSellOrderCount}S orders - reducing target to 20 per side`);
    } else {
      // Check each side individually
      if (marketHasEnoughBuys) {
        targetBuyOrderCount = Math.min(20, configMinOrderCount);
        this.log('info', `📊 Market has ${marketBuyOrderCount} buy orders - reducing buy target to 20`);
      }
      if (marketHasEnoughSells) {
        targetSellOrderCount = Math.min(20, configMinOrderCount);
        this.log('info', `📊 Market has ${marketSellOrderCount} sell orders - reducing sell target to 20`);
      }
    }
    
    // Calculate OUR current depth contribution in ±2% zone
    const criticalBuyZoneMin = midPrice * 0.98;
    const criticalSellZoneMax = midPrice * 1.02;
    
    // Calculate actual depth from our orders in ±2% zone
    const myBuyDepth = myBuyOrders
      .filter(o => {
        const price = parseFloat(o.price || 0);
        return price >= criticalBuyZoneMin && price < midPrice;
      })
      .reduce((sum, o) => {
        const price = parseFloat(o.price || 0);
        const qty = parseFloat(o.origQty || 0);
        return sum + (price * qty);
      }, 0);
    
    const mySellDepth = mySellOrders
      .filter(o => {
        const price = parseFloat(o.price || 0);
        return price > midPrice && price <= criticalSellZoneMax;
      })
      .reduce((sum, o) => {
        const price = parseFloat(o.price || 0);
        const qty = parseFloat(o.origQty || 0);
        return sum + (price * qty);
      }, 0);
    
    // Calculate Top 20 depth from our orders (sort by price and take top 20)
    const sortedBuyOrders = [...myBuyOrders].sort((a, b) => parseFloat(b.price) - parseFloat(a.price)).slice(0, 20);
    const sortedSellOrders = [...mySellOrders].sort((a, b) => parseFloat(a.price) - parseFloat(b.price)).slice(0, 20);
    
    const myBuyDepthTop20 = sortedBuyOrders.reduce((sum, o) => {
      const price = parseFloat(o.price || 0);
      const qty = parseFloat(o.origQty || 0);
      return sum + (price * qty);
    }, 0);
    
    const mySellDepthTop20 = sortedSellOrders.reduce((sum, o) => {
      const price = parseFloat(o.price || 0);
      const qty = parseFloat(o.origQty || 0);
      return sum + (price * qty);
    }, 0);
    
    // Calculate how much MORE depth WE need to add to reach BOTH targets
    // Use the MAX of ±2% depth needed and Top 20 depth needed
    const neededBuyDepth2Pct = Math.max(0, targetDepth2Pct - myBuyDepth);
    const neededSellDepth2Pct = Math.max(0, targetDepth2Pct - mySellDepth);
    const neededBuyDepthTop20 = Math.max(0, targetDepthTop20 - myBuyDepthTop20);
    const neededSellDepthTop20 = Math.max(0, targetDepthTop20 - mySellDepthTop20);
    
    // Use the HIGHER of the two requirements to ensure BOTH are met
    const neededBuyDepth = Math.max(neededBuyDepth2Pct, neededBuyDepthTop20);
    const neededSellDepth = Math.max(neededSellDepth2Pct, neededSellDepthTop20);
    
    // Calculate how many MORE orders we need (using dynamic target)
    const existingBuyCount = myBuyPrices.length;
    const existingSellCount = mySellPrices.length;
    const neededBuyOrders = Math.max(0, targetBuyOrderCount - existingBuyCount);
    const neededSellOrders = Math.max(0, targetSellOrderCount - existingSellCount);

    // Calculate minimum budget required
    const minBudgetNeeded = {
      buy: neededBuyDepth,
      sell: neededSellDepth / midPrice, // Convert USDT value to GCB quantity
      total: neededBuyDepth + neededSellDepth
    };

    this.log('info', `📊 Total Market: Buy $${totalBuyDepth.toFixed(2)}, Sell $${totalSellDepth.toFixed(2)}`);
    this.log('info', `📊 My ±2% Depth: Buy $${myBuyDepth.toFixed(2)}/${targetDepth2Pct}, Sell $${mySellDepth.toFixed(2)}/${targetDepth2Pct}`);
    this.log('info', `📊 My Top20 Depth: Buy $${myBuyDepthTop20.toFixed(2)}/${targetDepthTop20}, Sell $${mySellDepthTop20.toFixed(2)}/${targetDepthTop20}`);
    this.log('info', `📊 Orders: Have ${existingBuyCount}B/${existingSellCount}S, Target ${targetBuyOrderCount}B/${targetSellOrderCount}S, Need ${neededBuyOrders}B/${neededSellOrders}S more`);
    this.log('info', `💰 Need to add: $${neededBuyDepth.toFixed(2)} USDT for buys, $${neededSellDepth.toFixed(2)} USDT for sells`);

    // ===== GENERATE BUY ORDERS =====
    // Split budget: $500 in ±2% zone (top 10 orders), $500 outside zone (next 10 orders)
    if (neededBuyOrders > 0 || neededBuyDepth > 0) {
      const criticalZoneMin = midPrice * 0.98;
      const criticalZoneMax = midPrice * 0.996; // 0.4% below mid-price
      
      // Zone 1: ±2% zone (10 orders with $500 depth)
      const zone1Orders = [];
      const zone1PriceStep = (criticalZoneMax - criticalZoneMin) / 10;
      let currentPrice = criticalZoneMax;
      
      for (let i = 0; i < 10 && currentPrice >= criticalZoneMin; i++) {
        const price = formatPrice(currentPrice);
        const priceStr = price.toString();
        if (!existingBuyPrices.has(priceStr) && price < midPrice) {
          zone1Orders.push(price);
          existingBuyPrices.add(priceStr);
        }
        currentPrice -= zone1PriceStep;
      }
      
      // Zone 2: Outside ±2% zone (10 orders with $500 depth)
      const zone2Orders = [];
      currentPrice = criticalZoneMin - 0.0001;
      const extendedMin = midPrice * 0.90;
      
      while (zone2Orders.length < 10 && currentPrice >= extendedMin) {
        const price = formatPrice(currentPrice);
        const priceStr = price.toString();
        if (!existingBuyPrices.has(priceStr)) {
          zone2Orders.push(price);
          existingBuyPrices.add(priceStr);
        }
        currentPrice *= 0.995; // Step down by 0.5%
      }
      
      // Distribute $500 across Zone 1 orders with RANDOM amounts (±2% zone for requirement 2)
      const zone1Depth = targetDepth2Pct; // $500 for ±2% requirement
      if (zone1Orders.length > 0) {
        // Generate random weights for each order
        const zone1Weights = zone1Orders.map(() => 0.5 + Math.random()); // Random between 0.5 and 1.5
        const zone1TotalWeight = zone1Weights.reduce((a, b) => a + b, 0);
        
        zone1Orders.forEach((price, idx) => {
          const orderDepth = (zone1Weights[idx] / zone1TotalWeight) * zone1Depth;
          const qty = formatQty(orderDepth / price);
          if (qty >= 0.01) {
            orders.buys.push({ price: price.toString(), quantity: qty.toString() });
          }
        });
      }
      
      // Distribute $500 across Zone 2 orders with RANDOM amounts (outside zone for Top 20 requirement)
      const zone2Depth = targetDepthTop20 - targetDepth2Pct; // Remaining $500 for Top 20
      if (zone2Orders.length > 0 && zone2Depth > 0) {
        // Generate random weights for each order
        const zone2Weights = zone2Orders.map(() => 0.5 + Math.random()); // Random between 0.5 and 1.5
        const zone2TotalWeight = zone2Weights.reduce((a, b) => a + b, 0);
        
        zone2Orders.forEach((price, idx) => {
          const orderDepth = (zone2Weights[idx] / zone2TotalWeight) * zone2Depth;
          const qty = formatQty(orderDepth / price);
          if (qty >= 0.01) {
            orders.buys.push({ price: price.toString(), quantity: qty.toString() });
          }
        });
      }
    }

    // ===== GENERATE SELL ORDERS =====
    // Split budget: $500 in ±2% zone (top 10 orders), $500 outside zone (next 10 orders)
    if (neededSellOrders > 0 || neededSellDepth > 0) {
      const criticalZoneMin = midPrice * 1.004; // 0.4% above mid-price
      const criticalZoneMax = midPrice * 1.02;
      
      // Zone 1: ±2% zone (10 orders with $500 depth)
      const zone1Orders = [];
      const zone1PriceStep = (criticalZoneMax - criticalZoneMin) / 10;
      let currentPrice = criticalZoneMin;
      
      for (let i = 0; i < 10 && currentPrice <= criticalZoneMax; i++) {
        const price = formatPrice(currentPrice);
        const priceStr = price.toString();
        if (!existingSellPrices.has(priceStr) && price > midPrice) {
          zone1Orders.push(price);
          existingSellPrices.add(priceStr);
        }
        currentPrice += zone1PriceStep;
      }
      
      // Zone 2: Outside ±2% zone (10 orders with $500 depth)
      const zone2Orders = [];
      currentPrice = criticalZoneMax + 0.0001;
      const extendedMax = midPrice * 1.10;
      
      while (zone2Orders.length < 10 && currentPrice <= extendedMax) {
        const price = formatPrice(currentPrice);
        const priceStr = price.toString();
        if (!existingSellPrices.has(priceStr)) {
          zone2Orders.push(price);
          existingSellPrices.add(priceStr);
        }
        currentPrice *= 1.005; // Step up by 0.5%
      }
      
      // Distribute $500 across Zone 1 orders with RANDOM amounts (±2% zone for requirement 2)
      const zone1Depth = targetDepth2Pct; // $500 for ±2% requirement
      if (zone1Orders.length > 0) {
        // Generate random weights for each order
        const zone1Weights = zone1Orders.map(() => 0.5 + Math.random()); // Random between 0.5 and 1.5
        const zone1TotalWeight = zone1Weights.reduce((a, b) => a + b, 0);
        
        zone1Orders.forEach((price, idx) => {
          const orderDepth = (zone1Weights[idx] / zone1TotalWeight) * zone1Depth;
          const qty = formatQty(orderDepth / price);
          if (qty >= 0.01) {
            orders.sells.push({ price: price.toString(), quantity: qty.toString() });
          }
        });
      }
      
      // Distribute $500 across Zone 2 orders with RANDOM amounts (outside zone for Top 20 requirement)
      const zone2Depth = targetDepthTop20 - targetDepth2Pct; // Remaining $500 for Top 20
      if (zone2Orders.length > 0 && zone2Depth > 0) {
        // Generate random weights for each order
        const zone2Weights = zone2Orders.map(() => 0.5 + Math.random()); // Random between 0.5 and 1.5
        const zone2TotalWeight = zone2Weights.reduce((a, b) => a + b, 0);
        
        zone2Orders.forEach((price, idx) => {
          const orderDepth = (zone2Weights[idx] / zone2TotalWeight) * zone2Depth;
          const qty = formatQty(orderDepth / price);
          if (qty >= 0.01) {
            orders.sells.push({ price: price.toString(), quantity: qty.toString() });
          }
        });
      }
    }

    // Log summary
    const totalBuyValue = orders.buys.reduce((sum, o) => sum + parseFloat(o.price) * parseFloat(o.quantity), 0);
    const totalSellValue = orders.sells.reduce((sum, o) => sum + parseFloat(o.price) * parseFloat(o.quantity), 0);
    const totalSellQty = orders.sells.reduce((sum, o) => sum + parseFloat(o.quantity), 0);
    
    this.log('info', `📊 Generated ${orders.buys.length} buy orders ($${totalBuyValue.toFixed(2)}) and ${orders.sells.length} sell orders (${totalSellQty.toFixed(2)} GCB worth $${totalSellValue.toFixed(2)})`);

    // Store budget requirements for UI
    orders.budgetRequired = minBudgetNeeded;
    
    return orders;
  }

  /**
   * Shuffle orders to make market look active and avoid bot detection
   * Randomly cancels 2-5 orders and re-places them at new positions
   * Direction alternates randomly (high-to-low or low-to-high)
   */
  async shuffleOrders(credentials, buyOrders, sellOrders, midPrice, symbolInfo, config) {
    const pricePrecision = symbolInfo?.pricePrecision || 6;
    const qtyPrecision = symbolInfo?.quantityPrecision || 2;
    
    const formatPrice = (price) => parseFloat(price.toFixed(pricePrecision));
    const formatQty = (qty) => Math.max(parseFloat(qty.toFixed(qtyPrecision)), 0.01);
    
    // Randomly decide how many orders to shuffle (2-4)
    const shuffleCount = Math.floor(Math.random() * 3) + 2;
    
    // Only shuffle sides that have enough orders
    const canShuffleBuys = buyOrders.length >= shuffleCount;
    const canShuffleSells = sellOrders.length >= shuffleCount;
    
    // Random chance to skip shuffle (20%)
    if (Math.random() < 0.2) {
      this.log('info', `🔄 Shuffle skipped this cycle (random cooldown)`);
      return;
    }
    
    if (!canShuffleBuys && !canShuffleSells) {
      this.log('info', `🔄 Not enough orders to shuffle`);
      return;
    }
    
    const ordersToCancel = [];
    const newOrders = { buys: [], sells: [] };
    
    // Get all existing prices to avoid duplicates
    const existingBuyPrices = new Set(buyOrders.map(o => parseFloat(o.price).toFixed(pricePrecision)));
    const existingSellPrices = new Set(sellOrders.map(o => parseFloat(o.price).toFixed(pricePrecision)));
    
    // Shuffle buy orders - ONLY from top 10 (highest price = closest to mid)
    if (canShuffleBuys) {
      // Sort by price descending (highest first = closest to mid-price)
      const sortedByPrice = [...buyOrders].sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
      const top10Buys = sortedByPrice.slice(0, 10);
      
      // Randomly select 2-3 from top 10 to shuffle
      const shuffled = [...top10Buys].sort(() => Math.random() - 0.5);
      const toShuffle = shuffled.slice(0, Math.min(shuffleCount, 3));
      
      for (const order of toShuffle) {
        ordersToCancel.push(order.orderId);
        existingBuyPrices.delete(parseFloat(order.price).toFixed(pricePrecision));
      }
      
      // Generate new prices - randomly high-to-low or low-to-high
      const direction = Math.random() > 0.5 ? 1 : -1;
      const startPrice = direction > 0 ? midPrice * 0.998 : midPrice * 0.96;
      const step = 0.003 * direction;
      
      let currentPrice = startPrice;
      for (const order of toShuffle) {
        let attempts = 0;
        while (attempts < 50) {
          const newPrice = formatPrice(currentPrice * (1 + (Math.random() - 0.5) * 0.01));
          const priceStr = newPrice.toFixed(pricePrecision);
          
          if (!existingBuyPrices.has(priceStr) && newPrice < midPrice && newPrice > midPrice * 0.90) {
            const qty = formatQty(parseFloat(order.origQty) * (0.8 + Math.random() * 0.4));
            newOrders.buys.push({ price: newPrice.toString(), quantity: qty.toString() });
            existingBuyPrices.add(priceStr);
            break;
          }
          currentPrice = currentPrice * (1 - step);
          attempts++;
        }
      }
    }
    
    // Shuffle sell orders - ONLY from top 10 (lowest price = closest to mid)
    if (canShuffleSells) {
      // Sort by price ascending (lowest first = closest to mid-price)
      const sortedByPrice = [...sellOrders].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
      const top10Sells = sortedByPrice.slice(0, 10);
      
      // Randomly select 2-3 from top 10 to shuffle
      const shuffled = [...top10Sells].sort(() => Math.random() - 0.5);
      const toShuffle = shuffled.slice(0, Math.min(shuffleCount, 3));
      
      for (const order of toShuffle) {
        ordersToCancel.push(order.orderId);
        existingSellPrices.delete(parseFloat(order.price).toFixed(pricePrecision));
      }
      
      // Generate new prices - randomly high-to-low or low-to-high
      const direction = Math.random() > 0.5 ? 1 : -1;
      const startPrice = direction > 0 ? midPrice * 1.002 : midPrice * 1.08;
      const step = 0.003 * direction;
      
      let currentPrice = startPrice;
      for (const order of toShuffle) {
        let attempts = 0;
        while (attempts < 50) {
          const newPrice = formatPrice(currentPrice * (1 + (Math.random() - 0.5) * 0.01));
          const priceStr = newPrice.toFixed(pricePrecision);
          
          if (!existingSellPrices.has(priceStr) && newPrice > midPrice && newPrice < midPrice * 1.15) {
            const qty = formatQty(parseFloat(order.origQty) * (0.8 + Math.random() * 0.4));
            newOrders.sells.push({ price: newPrice.toString(), quantity: qty.toString() });
            existingSellPrices.add(priceStr);
            break;
          }
          currentPrice = currentPrice * (1 + step);
          attempts++;
        }
      }
    }
    
    if (ordersToCancel.length === 0) {
      return;
    }
    
    this.log('info', `🔄 Shuffling ${ordersToCancel.length} orders (${newOrders.buys.length}B/${newOrders.sells.length}S) for natural market activity`);
    
    // Cancel selected orders
    await this.cancelBatchOrders(credentials.apiKey, credentials.apiSecret, ordersToCancel);
    await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500)); // Random delay 500-1000ms
    
    // Place new orders
    const allNewOrders = [...newOrders.buys.map(o => ({ ...o, side: 'BUY' })), ...newOrders.sells.map(o => ({ ...o, side: 'SELL' }))];
    
    // Randomize order placement sequence
    allNewOrders.sort(() => Math.random() - 0.5);
    
    for (const order of allNewOrders) {
      try {
        await this.placeLimitOrder(credentials.apiKey, credentials.apiSecret, config.symbol || 'gcb_usdt', order.side, order.price, order.quantity);
        await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 300)); // Random delay between orders
      } catch (error) {
        this.log('warning', `Failed to place shuffled order: ${error.message}`);
      }
    }
    
    this.log('success', `🔄 Shuffle complete: ${allNewOrders.length} orders repositioned`);
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

      // Get MY open orders ONCE for all calculations
      const myOpenOrders = await this.getOpenOrders(credentials.apiKey, credentials.apiSecret, symbol);
      const myBuyOrders = myOpenOrders.filter(o => o.side?.toUpperCase() === 'BUY');
      const mySellOrders = myOpenOrders.filter(o => o.side?.toUpperCase() === 'SELL');
      
      // Calculate budget requirements for UI
      const tempNeededOrders = this.generateNeededOrders(analysis, freshBot, symbolInfo, myBuyOrders, mySellOrders);
      const budgetRequired = tempNeededOrders.budgetRequired || { buy: 0, sell: 0, total: 0 };
      
      // Get balance for status update
      const balancesForStatus = await this.getAccountBalance(credentials.apiKey, credentials.apiSecret);
      
      // Update bot status IMMEDIATELY with fresh market data (reduces UI latency)
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
            budgetRequired: budgetRequired,
            availableBalance: { 
              usdt: balancesForStatus?.usdt?.availableAmount || 0, 
              gcb: balancesForStatus?.gcb?.availableAmount || 0 
            },
            myBuyOrderCount: myBuyOrders.length,
            mySellOrderCount: mySellOrders.length,
            updatedAt: new Date()
          } 
        }
      );

      // Only place orders if autoManage is enabled
      if (!freshBot.autoManage) {
        if (!allOk) {
          this.log('info', `[${bot.name}] ⚠️ Liquidity issues detected but autoManage is disabled`);
          if (!analysis.metrics.spreadOk) {
            this.log('warning', `[${bot.name}] Spread ${analysis.metrics.spread.toFixed(3)}% exceeds ${freshBot.maxSpread || 1}%`);
          }
          if (!analysis.metrics.depth2PctOk) {
            this.log('warning', `[${bot.name}] Depth ±2% insufficient - Buy: $${analysis.metrics.buyDepth2Pct.toFixed(2)}, Sell: $${analysis.metrics.sellDepth2Pct.toFixed(2)}`);
          }
          if (!analysis.metrics.orderCountOk) {
            this.log('warning', `[${bot.name}] Order count insufficient - Buy: ${analysis.metrics.buyOrderCount}, Sell: ${analysis.metrics.sellOrderCount}`);
          }
        } else {
          this.log('success', `[${bot.name}] ✅ All liquidity requirements met (autoManage disabled)`);
        }
        return;
      }

      this.log('info', `[${bot.name}] 🔍 Found ${myOpenOrders.length} total open orders (${myBuyOrders.length}B/${mySellOrders.length}S)`);
      
      const minOrderCount = freshBot.minOrderCount || 30;
      
      // Only cancel orders that are EXTREMELY stale (>25% away from mid-price)
      // Don't cancel based on order size - small orders are fine for outer zones
      const ordersToCancel = [];
      const buyPriceRange = { min: midPrice * 0.75, max: midPrice * 1.02 };  // 25% below to 2% above
      const sellPriceRange = { min: midPrice * 0.98, max: midPrice * 1.25 }; // 2% below to 25% above

      for (const order of myBuyOrders) {
        const price = parseFloat(order.price);
        if (price < buyPriceRange.min || price > buyPriceRange.max) {
          ordersToCancel.push(order.orderId);
        }
      }

      for (const order of mySellOrders) {
        const price = parseFloat(order.price);
        if (price < sellPriceRange.min || price > sellPriceRange.max) {
          ordersToCancel.push(order.orderId);
        }
      }

      // Cancel stale orders if any found
      if (ordersToCancel.length > 0) {
        this.log('info', `[${bot.name}] 🗑️ Cancelling ${ordersToCancel.length} stale orders (>25% from mid-price)`);
        await this.cancelBatchOrders(credentials.apiKey, credentials.apiSecret, ordersToCancel);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Re-fetch orders after cancellation
      const updatedOpenOrders = ordersToCancel.length > 0 
        ? await this.getOpenOrders(credentials.apiKey, credentials.apiSecret, symbol)
        : myOpenOrders;
      const updatedBuyOrders = updatedOpenOrders.filter(o => o.side?.toUpperCase() === 'BUY');
      const updatedSellOrders = updatedOpenOrders.filter(o => o.side?.toUpperCase() === 'SELL');

      // Check if MARKET already meets requirements (not just our orders)
      const targetDepth2Pct = freshBot.minDepth2Percent || 500;
      const targetDepthTop20 = freshBot.minDepthTop20 || 1000;
      const marketBuyDepthOk = analysis.metrics.buyDepth2Pct >= targetDepth2Pct;
      const marketSellDepthOk = analysis.metrics.sellDepth2Pct >= targetDepth2Pct;
      const marketBuyDepthTop20Ok = analysis.metrics.buyDepthTop20 >= targetDepthTop20;
      const marketSellDepthTop20Ok = analysis.metrics.sellDepthTop20 >= targetDepthTop20;
      const marketBuyCountOk = analysis.metrics.buyOrderCount >= minOrderCount;
      const marketSellCountOk = analysis.metrics.sellOrderCount >= minOrderCount;
      const spreadOk = analysis.metrics.spreadOk;
      
      // For gaps, we only care about OUR orders meeting the gap requirement
      // Check gaps in our top 20 orders, not the entire market
      const myTop20Buys = [...updatedBuyOrders].sort((a, b) => parseFloat(b.price) - parseFloat(a.price)).slice(0, 20);
      const myTop20Sells = [...updatedSellOrders].sort((a, b) => parseFloat(a.price) - parseFloat(b.price)).slice(0, 20);
      
      let myBuyGapsOk = true;
      let mySellGapsOk = true;
      const maxGap = freshBot.maxOrderGap || 1;
      
      // Only check gaps within our top 20 orders (not between order 20 and 21)
      // If we have 20 orders, check 19 gaps (between orders 1-2, 2-3, ... 19-20)
      if (myTop20Buys.length >= 2) {
        const buyGapCount = myTop20Buys.length - 1; // Check all gaps within our orders
        for (let i = 0; i < buyGapCount; i++) {
          const gap = ((parseFloat(myTop20Buys[i].price) - parseFloat(myTop20Buys[i + 1].price)) / parseFloat(myTop20Buys[i].price)) * 100;
          if (gap > maxGap) {
            myBuyGapsOk = false;
            break;
          }
        }
      }
      
      // Only check gaps within our top 20 orders (not between order 20 and 21)
      if (myTop20Sells.length >= 2) {
        const sellGapCount = myTop20Sells.length - 1; // Check all gaps within our orders
        for (let i = 0; i < sellGapCount; i++) {
          const gap = ((parseFloat(myTop20Sells[i + 1].price) - parseFloat(myTop20Sells[i].price)) / parseFloat(myTop20Sells[i].price)) * 100;
          if (gap > maxGap) {
            mySellGapsOk = false;
            break;
          }
        }
      }
      
      // Use our gap checks, not market gap checks
      const buyGapsOk = myBuyGapsOk;
      const sellGapsOk = mySellGapsOk;
      
      // Calculate OUR depth contribution
      const criticalBuyZoneMin = midPrice * 0.98;
      const criticalSellZoneMax = midPrice * 1.02;
      
      const myBuyDepth2Pct = updatedBuyOrders
        .filter(o => parseFloat(o.price) >= criticalBuyZoneMin && parseFloat(o.price) < midPrice)
        .reduce((sum, o) => sum + parseFloat(o.price) * parseFloat(o.origQty || 0), 0);
      
      const mySellDepth2Pct = updatedSellOrders
        .filter(o => parseFloat(o.price) > midPrice && parseFloat(o.price) <= criticalSellZoneMax)
        .reduce((sum, o) => sum + parseFloat(o.price) * parseFloat(o.origQty || 0), 0);
      
      const myBuyDepthTop20 = myTop20Buys.reduce((sum, o) => sum + parseFloat(o.price) * parseFloat(o.origQty || 0), 0);
      const mySellDepthTop20 = myTop20Sells.reduce((sum, o) => sum + parseFloat(o.price) * parseFloat(o.origQty || 0), 0);
      
      // Check if OUR orders meet requirements
      const myBuyDepthOk = myBuyDepth2Pct >= targetDepth2Pct;
      const mySellDepthOk = mySellDepth2Pct >= targetDepth2Pct;
      const myBuyDepthTop20Ok = myBuyDepthTop20 >= targetDepthTop20;
      const mySellDepthTop20Ok = mySellDepthTop20 >= targetDepthTop20;
      const myBuyCountOk = updatedBuyOrders.length >= 20; // We target 20 orders
      const mySellCountOk = updatedSellOrders.length >= 20;
      
      // All MY requirements met?
      const myAllOk = spreadOk && myBuyDepthOk && mySellDepthOk && myBuyDepthTop20Ok && mySellDepthTop20Ok && myBuyCountOk && mySellCountOk && buyGapsOk && sellGapsOk;
      
      // If OUR orders already meet all requirements, don't place any more
      if (myAllOk) {
        this.log('success', `[${bot.name}] ✅ My orders already meet all requirements. Orders: ${updatedBuyOrders.length}B/${updatedSellOrders.length}S`);
        return;
      }
      
      // If MARKET already meets all requirements, don't place any orders
      if (allOk) {
        this.log('success', `[${bot.name}] ✅ Market already meets all requirements. My orders: ${updatedBuyOrders.length}B/${updatedSellOrders.length}S`);
        return;
      }
      
      // Log what requirements are failing
      if (!spreadOk) {
        this.log('warning', `[${bot.name}] ⚠️ Spread ${analysis.metrics.spread.toFixed(3)}% exceeds target ${freshBot.maxSpread || 1}% - will place orders to tighten`);
      }
      if (!buyGapsOk) {
        this.log('warning', `[${bot.name}] ⚠️ Buy side has price gaps > ${freshBot.maxOrderGap || 1}% - will place orders to fill`);
      }
      if (!sellGapsOk) {
        this.log('warning', `[${bot.name}] ⚠️ Sell side has price gaps > ${freshBot.maxOrderGap || 1}% - will place orders to fill`);
      }
      if (!marketBuyDepthTop20Ok) {
        this.log('warning', `[${bot.name}] ⚠️ Buy top20 depth $${analysis.metrics.buyDepthTop20.toFixed(2)} below target $${targetDepthTop20}`);
      }
      if (!marketSellDepthTop20Ok) {
        this.log('warning', `[${bot.name}] ⚠️ Sell top20 depth $${analysis.metrics.sellDepthTop20.toFixed(2)} below target $${targetDepthTop20}`);
      }
      
      // SPREAD TIGHTENING: If spread is broken but we already have max orders,
      // we need to cancel far orders and place closer ones
      const dynamicTarget = (analysis.metrics.buyOrderCount >= 10 && analysis.metrics.sellOrderCount >= 10) ? 20 : (freshBot.minOrderCount || 30);
      const haveMaxBuys = updatedBuyOrders.length >= dynamicTarget;
      const haveMaxSells = updatedSellOrders.length >= dynamicTarget;
      
      if (!spreadOk && (haveMaxBuys || haveMaxSells)) {
        this.log('info', `[${bot.name}] 🔄 Spread broken with max orders - need to reposition orders closer to mid-price`);
        
        // Find the best bid and ask to understand where we need orders
        const bestBid = analysis.metrics.bestBid || midPrice * 0.996;
        const bestAsk = analysis.metrics.bestAsk || midPrice * 1.004;
        const targetSpread = (freshBot.maxSpread || 1) / 100; // e.g., 0.01 for 1%
        
        // To fix spread, we need:
        // - Buy orders closer to bestAsk (higher buy prices)
        // - Sell orders closer to bestBid (lower sell prices)
        const targetBuyPrice = midPrice * (1 - targetSpread / 2); // e.g., 0.4% below mid
        const targetSellPrice = midPrice * (1 + targetSpread / 2); // e.g., 0.4% above mid
        
        // Find our orders that are too far from where they should be
        const ordersToRepositionBuy = [];
        const ordersToRepositionSell = [];
        
        if (haveMaxBuys && !spreadOk) {
          // Sort buy orders by price (ascending - lowest first)
          const sortedBuys = [...updatedBuyOrders].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
          // Cancel up to 3 of the lowest (farthest from mid) buy orders
          for (let i = 0; i < Math.min(3, sortedBuys.length); i++) {
            const order = sortedBuys[i];
            const orderPrice = parseFloat(order.price);
            // Only cancel if it's more than 1% below target buy price
            if (orderPrice < targetBuyPrice * 0.99) {
              ordersToRepositionBuy.push(order.orderId);
            }
          }
        }
        
        if (haveMaxSells && !spreadOk) {
          // Sort sell orders by price (descending - highest first)
          const sortedSells = [...updatedSellOrders].sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
          // Cancel up to 3 of the highest (farthest from mid) sell orders
          for (let i = 0; i < Math.min(3, sortedSells.length); i++) {
            const order = sortedSells[i];
            const orderPrice = parseFloat(order.price);
            // Only cancel if it's more than 1% above target sell price
            if (orderPrice > targetSellPrice * 1.01) {
              ordersToRepositionSell.push(order.orderId);
            }
          }
        }
        
        const totalToReposition = ordersToRepositionBuy.length + ordersToRepositionSell.length;
        if (totalToReposition > 0) {
          this.log('info', `[${bot.name}] 🔄 Cancelling ${ordersToRepositionBuy.length} far buy orders and ${ordersToRepositionSell.length} far sell orders to reposition`);
          const allToCancel = [...ordersToRepositionBuy, ...ordersToRepositionSell];
          await this.cancelBatchOrders(credentials.apiKey, credentials.apiSecret, allToCancel);
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Update our order lists after cancellation
          const refreshedOrders = await this.getOpenOrders(credentials.apiKey, credentials.apiSecret, symbol);
          updatedBuyOrders.length = 0;
          updatedSellOrders.length = 0;
          refreshedOrders.forEach(o => {
            if (o.side?.toUpperCase() === 'BUY') updatedBuyOrders.push(o);
            else if (o.side?.toUpperCase() === 'SELL') updatedSellOrders.push(o);
          });
          
          this.log('info', `[${bot.name}] 📋 After repositioning cancel: ${updatedBuyOrders.length}B/${updatedSellOrders.length}S orders`);
        }
      }
      
      // Check which side needs help - use OUR order requirements, not market
      // When any of OUR requirements is broken, we need orders to fix it
      const needMoreBuys = !myBuyDepthOk || !myBuyCountOk || !spreadOk || !buyGapsOk || !myBuyDepthTop20Ok;
      const needMoreSells = !mySellDepthOk || !mySellCountOk || !spreadOk || !sellGapsOk || !mySellDepthTop20Ok;
      
      // Log what needs improvement
      if (needMoreBuys) {
        this.log('info', `[${bot.name}] 📋 Buy side needs help - My Depth: $${myBuyDepth2Pct.toFixed(2)}/${targetDepth2Pct}, My Top20: $${myBuyDepthTop20.toFixed(2)}/${targetDepthTop20}, Count: ${updatedBuyOrders.length}/20`);
      }
      if (needMoreSells) {
        this.log('info', `[${bot.name}] 📋 Sell side needs help - My Depth: $${mySellDepth2Pct.toFixed(2)}/${targetDepth2Pct}, My Top20: $${mySellDepthTop20.toFixed(2)}/${targetDepthTop20}, Count: ${updatedSellOrders.length}/20`);
      }

      // Check balance before placing orders
      const balances = await this.getAccountBalance(credentials.apiKey, credentials.apiSecret);
      if (!balances) {
        this.log('warning', `[${bot.name}] Could not fetch balance`);
        return;
      }

      const availableUsdt = balances.usdt?.availableAmount || 0;
      const availableGcb = balances.gcb?.availableAmount || 0;

      // Generate needed orders ONLY for sides that need help
      this.log('info', `[${bot.name}] 📋 Existing orders - Buy: ${updatedBuyOrders.length}, Sell: ${updatedSellOrders.length}`);
      const neededOrders = this.generateNeededOrders(analysis, freshBot, symbolInfo, updatedBuyOrders, updatedSellOrders);
      
      // Filter out orders for sides that already meet ALL OUR requirements
      // Only skip if OUR depth, count, spread, gaps, AND top20 depth are all OK
      if (myBuyDepthOk && myBuyCountOk && spreadOk && buyGapsOk && myBuyDepthTop20Ok) {
        this.log('info', `[${bot.name}] ✅ Buy side already sufficient - skipping buy orders`);
        neededOrders.buys = [];
      }
      if (mySellDepthOk && mySellCountOk && spreadOk && sellGapsOk && mySellDepthTop20Ok) {
        this.log('info', `[${bot.name}] ✅ Sell side already sufficient - skipping sell orders`);
        neededOrders.sells = [];
      }
      
      const totalBuyUsdt = neededOrders.buys.reduce((sum, o) => sum + parseFloat(o.price) * parseFloat(o.quantity), 0);
      const totalSellGcb = neededOrders.sells.reduce((sum, o) => sum + parseFloat(o.quantity), 0);

      this.log('info', `[${bot.name}] 📝 Will place ${neededOrders.buys.length} buy orders ($${totalBuyUsdt.toFixed(2)} USDT) and ${neededOrders.sells.length} sell orders (${totalSellGcb.toFixed(2)} GCB)`);
      
      // If no orders needed, we're done
      if (neededOrders.buys.length === 0 && neededOrders.sells.length === 0) {
        this.log('success', `[${bot.name}] ✅ No orders needed - market is sufficient`);
        return;
      }

      // ALWAYS use available balance to improve depth, even if partial
      // Helper function for formatting quantities (moved up to avoid reference error)
      const formatQty = (qty) => Math.max(parseFloat(qty.toFixed(2)), 0.01);
      
      if (neededOrders.buys.length > 0) {
        if (totalBuyUsdt > availableUsdt) {
          if (availableUsdt >= 0.5) { // At least $0.50 to place orders
            this.log('info', `[${bot.name}] 💰 Using available $${availableUsdt.toFixed(2)} USDT (need $${totalBuyUsdt.toFixed(2)})`);
            // Prioritize orders closest to mid-price
            let budgetUsed = 0;
            const adjustedBuys = [];
            
            for (const order of neededOrders.buys) {
              const orderValue = parseFloat(order.price) * parseFloat(order.quantity);
              if (budgetUsed + orderValue <= availableUsdt) {
                adjustedBuys.push(order);
                budgetUsed += orderValue;
              } else if (availableUsdt - budgetUsed >= 0.5) {
                // Place smaller order with remaining budget
                const remainingBudget = availableUsdt - budgetUsed;
                const newQty = formatQty(remainingBudget / parseFloat(order.price));
                if (newQty >= 0.01) {
                  adjustedBuys.push({ price: order.price, quantity: newQty.toString() });
                  budgetUsed += remainingBudget;
                }
                break;
              }
            }
            neededOrders.buys = adjustedBuys;
          } else {
            this.log('warning', `[${bot.name}] Insufficient USDT: have $${availableUsdt.toFixed(2)}, need at least $0.50`);
            neededOrders.buys = [];
          }
        }
      }

      if (neededOrders.sells.length > 0) {
        if (totalSellGcb > availableGcb) {
          if (availableGcb >= 0.5) { // At least 0.5 GCB to place orders
            this.log('info', `[${bot.name}] 💰 Using available ${availableGcb.toFixed(2)} GCB (need ${totalSellGcb.toFixed(2)})`);
            // Prioritize orders closest to mid-price
            let gcbUsed = 0;
            const adjustedSells = [];
            
            for (const order of neededOrders.sells) {
              const orderQty = parseFloat(order.quantity);
              if (gcbUsed + orderQty <= availableGcb) {
                adjustedSells.push(order);
                gcbUsed += orderQty;
              } else if (availableGcb - gcbUsed >= 0.5) {
                // Place smaller order with remaining GCB
                const remainingGcb = availableGcb - gcbUsed;
                if (remainingGcb >= 0.01) {
                  adjustedSells.push({ price: order.price, quantity: remainingGcb.toFixed(2) });
                  gcbUsed += remainingGcb;
                }
                break;
              }
            }
            neededOrders.sells = adjustedSells;
          } else {
            this.log('warning', `[${bot.name}] Insufficient GCB: have ${availableGcb.toFixed(2)}, need at least 0.5`);
            neededOrders.sells = [];
          }
        }
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

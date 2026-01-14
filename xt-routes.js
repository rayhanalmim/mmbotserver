import 'dotenv/config';

const XT_BASE_URL = process.env.XT_BASE_URL || 'https://sapi.xt.com';

// Setup XT public routes (no auth needed)
export function setupXtRoutes(app) {
  
  // ============================================
  // XT Exchange Public Endpoints
  // ============================================

  // GET /api/xt/ping - Test XT connectivity (using server time endpoint)
  app.get('/api/xt/ping', async (req, res) => {
    try {
      const response = await fetch(`${XT_BASE_URL}/v4/public/time`);
      const data = await response.json();
      if (data.rc === 0) {
        res.json({ code: '0', msg: 'XT connection successful', data: data.result });
      } else {
        res.json({ code: '-1', msg: 'XT connection failed', data });
      }
    } catch (error) {
      console.error('XT ping error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to connect to XT', data: null });
    }
  });

  // GET /api/xt/time - Get XT server time
  app.get('/api/xt/time', async (req, res) => {
    try {
      const response = await fetch(`${XT_BASE_URL}/v4/public/time`);
      const data = await response.json();
      if (data.rc === 0) {
        res.json({ code: '0', msg: 'Success', data: data.result });
      } else {
        res.json({ code: '-1', msg: data.mc || 'Failed to get server time', data });
      }
    } catch (error) {
      console.error('XT time error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get XT server time', data: null });
    }
  });

  // GET /api/xt/ticker - Get ticker price for symbol
  app.get('/api/xt/ticker', async (req, res) => {
    try {
      const symbol = req.query.symbol || 'gcb_usdt';
      const response = await fetch(`${XT_BASE_URL}/v4/public/ticker/price?symbol=${symbol}`);
      const data = await response.json();
      
      if (data.rc === 0 && data.result && data.result.length > 0) {
        res.json({ 
          code: '0', 
          msg: 'Success', 
          data: {
            symbol: data.result[0].s,
            price: data.result[0].p,
            timestamp: data.result[0].t
          }
        });
      } else {
        res.json({ code: '-1', msg: data.mc || 'Failed to get ticker', data });
      }
    } catch (error) {
      console.error('XT ticker error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get ticker', data: null });
    }
  });

  // GET /api/xt/ticker/24hr - Get 24hr ticker stats
  app.get('/api/xt/ticker/24hr', async (req, res) => {
    try {
      const symbol = req.query.symbol || 'gcb_usdt';
      const response = await fetch(`${XT_BASE_URL}/v4/public/ticker/24h?symbol=${symbol}`);
      const data = await response.json();
      
      if (data.rc === 0 && data.result && data.result.length > 0) {
        const ticker = data.result[0];
        res.json({ 
          code: '0', 
          msg: 'Success', 
          data: {
            symbol: ticker.s,
            priceChange: ticker.cv,
            priceChangePercent: ticker.cr,
            openPrice: ticker.o,
            highPrice: ticker.h,
            lowPrice: ticker.l,
            lastPrice: ticker.c,
            volume: ticker.q,
            quoteVolume: ticker.v,
            timestamp: ticker.t
          }
        });
      } else {
        res.json({ code: '-1', msg: data.mc || 'Failed to get 24hr ticker', data });
      }
    } catch (error) {
      console.error('XT 24hr ticker error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get 24hr ticker', data: null });
    }
  });

  // GET /api/xt/depth - Get order book
  app.get('/api/xt/depth', async (req, res) => {
    try {
      const symbol = req.query.symbol || 'gcb_usdt';
      const limit = req.query.limit || 20;
      const response = await fetch(`${XT_BASE_URL}/v4/public/depth?symbol=${symbol}&limit=${limit}`);
      const data = await response.json();
      
      if (data.rc === 0) {
        res.json({ code: '0', msg: 'Success', data: data.result });
      } else {
        res.json({ code: '-1', msg: data.mc || 'Failed to get order book', data });
      }
    } catch (error) {
      console.error('XT depth error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get order book', data: null });
    }
  });

  // GET /api/xt/ticker/book - Get best bid/ask
  app.get('/api/xt/ticker/book', async (req, res) => {
    try {
      const symbol = req.query.symbol || 'gcb_usdt';
      const response = await fetch(`${XT_BASE_URL}/v4/public/ticker/book?symbol=${symbol}`);
      const data = await response.json();
      
      if (data.rc === 0 && data.result && data.result.length > 0) {
        const book = data.result[0];
        res.json({ 
          code: '0', 
          msg: 'Success', 
          data: {
            symbol: book.s,
            bestBidPrice: book.bp,
            bestBidQty: book.bq,
            bestAskPrice: book.ap,
            bestAskQty: book.aq,
            timestamp: book.t
          }
        });
      } else {
        res.json({ code: '-1', msg: data.mc || 'Failed to get book ticker', data });
      }
    } catch (error) {
      console.error('XT book ticker error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get book ticker', data: null });
    }
  });

  // GET /api/xt/symbol - Get symbol info
  app.get('/api/xt/symbol', async (req, res) => {
    try {
      const symbol = req.query.symbol || 'gcb_usdt';
      const response = await fetch(`${XT_BASE_URL}/v4/public/symbol?symbol=${symbol}`);
      const data = await response.json();
      
      if (data.rc === 0) {
        res.json({ code: '0', msg: 'Success', data: data.result });
      } else {
        res.json({ code: '-1', msg: data.mc || 'Failed to get symbol info', data });
      }
    } catch (error) {
      console.error('XT symbol error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get symbol info', data: null });
    }
  });

  // GET /api/xt/kline - Get K-line data
  app.get('/api/xt/kline', async (req, res) => {
    try {
      const symbol = req.query.symbol || 'gcb_usdt';
      const interval = req.query.interval || '1h';
      const limit = req.query.limit || 100;
      
      let url = `${XT_BASE_URL}/v4/public/kline?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      
      if (req.query.startTime) {
        url += `&startTime=${req.query.startTime}`;
      }
      if (req.query.endTime) {
        url += `&endTime=${req.query.endTime}`;
      }
      
      const response = await fetch(url);
      const data = await response.json();
      
      if (data.rc === 0) {
        res.json({ code: '0', msg: 'Success', data: data.result });
      } else {
        res.json({ code: '-1', msg: data.mc || 'Failed to get kline data', data });
      }
    } catch (error) {
      console.error('XT kline error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get kline data', data: null });
    }
  });

  // GET /api/xt/currencies - Get currency information
  app.get('/api/xt/currencies', async (req, res) => {
    try {
      const response = await fetch(`${XT_BASE_URL}/v4/public/currencies`);
      const data = await response.json();
      
      if (data.rc === 0) {
        res.json({ code: '0', msg: 'Success', data: data.result });
      } else {
        res.json({ code: '-1', msg: data.mc || 'Failed to get currencies', data });
      }
    } catch (error) {
      console.error('XT currencies error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get currencies', data: null });
    }
  });

  console.log('✅ XT public routes initialized');
}

export default setupXtRoutes;

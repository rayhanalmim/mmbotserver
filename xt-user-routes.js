import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

const XT_BASE_URL = process.env.XT_BASE_URL || 'https://sapi.xt.com';
const JWT_SECRET = process.env.JWT_SECRET || 'mexc-bot-secret-key-change-in-production';

// Time sync variables
let xtServerTimeOffset = 0;
let lastTimeSyncAt = 0;
const TIME_SYNC_INTERVAL = 30000; // Resync every 30 seconds

// Get XT server time and calculate offset
async function syncXtServerTime() {
  try {
    const localTime = Date.now();
    const response = await fetch(`${XT_BASE_URL}/v4/public/time`);
    const data = await response.json();
    
    if (data.rc === 0 && data.result?.serverTime) {
      const serverTime = data.result.serverTime;
      xtServerTimeOffset = serverTime - localTime;
      lastTimeSyncAt = localTime;
      console.log(`🕐 XT time synced. Offset: ${xtServerTimeOffset}ms`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('❌ Failed to sync XT server time:', error.message);
    return false;
  }
}

// Get synchronized timestamp for XT API
async function getXtTimestamp() {
  const now = Date.now();
  // Resync if interval has passed
  if (now - lastTimeSyncAt > TIME_SYNC_INTERVAL) {
    await syncXtServerTime();
  }
  return (now + xtServerTimeOffset).toString();
}

// Export for use in other modules
export { getXtTimestamp, syncXtServerTime };

// Generate XT signature
function generateXtSignature(secretKey, original) {
  return crypto
    .createHmac('sha256', secretKey)
    .update(original)
    .digest('hex');
}

// Build signature message for XT API
function buildSignatureMessage(method, path, queryString, bodyJson, headers) {
  // Build X part (headers)
  const headerParts = [];
  headerParts.push(`validate-algorithms=${headers['validate-algorithms']}`);
  headerParts.push(`validate-appkey=${headers['validate-appkey']}`);
  headerParts.push(`validate-recvwindow=${headers['validate-recvwindow']}`);
  headerParts.push(`validate-timestamp=${headers['validate-timestamp']}`);
  const X = headerParts.join('&');

  // Build Y part (request data)
  let Y = `#${method.toUpperCase()}#${path}`;
  if (queryString) {
    // Sort query params alphabetically by key as per XT API docs
    const sortedQuery = queryString.split('&')
      .map(param => param.split('='))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    Y += `#${sortedQuery}`;
  }
  if (bodyJson) {
    Y += `#${bodyJson}`;
  }

  return X + Y;
}

// Validate XT credentials by making a test API call
async function validateXtCredentials(apiKey, apiSecret) {
  // Sync time before validation
  await syncXtServerTime();
  
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const timestamp = await getXtTimestamp();
      const method = 'GET';
      const path = '/v4/balances';
      
      const headers = {
        'validate-algorithms': 'HmacSHA256',
        'validate-appkey': apiKey,
        'validate-recvwindow': '5000',
        'validate-timestamp': timestamp
      };

      const original = buildSignatureMessage(method, path, '', '', headers);
      const signature = generateXtSignature(apiSecret, original);

      const response = await fetch(`${XT_BASE_URL}${path}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'validate-algorithms': 'HmacSHA256',
          'validate-appkey': apiKey,
          'validate-recvwindow': '5000',
          'validate-timestamp': timestamp,
          'validate-signature': signature
        }
      });

      const data = await response.json();
      
      if (data.rc === 0) {
        return { valid: true, data };
      }
      
      // Retry on time-related errors
      if ((data.mc === 'AUTH_104' || data.mc === 'AUTH_105') && attempt < maxRetries) {
        console.log(`⏳ XT auth error ${data.mc}, resyncing time and retrying (attempt ${attempt}/${maxRetries})`);
        await syncXtServerTime();
        continue;
      }
      
      return { valid: false, error: data.mc || 'Invalid credentials' };
    } catch (error) {
      if (attempt < maxRetries) {
        console.log(`⏳ XT validation error, retrying (attempt ${attempt}/${maxRetries}):`, error.message);
        continue;
      }
      return { valid: false, error: error.message };
    }
  }
  return { valid: false, error: 'Max retries exceeded' };
}

// Middleware to verify XT user token (uses same JWT as MEXC but different user collection)
export function verifyXtToken(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ code: '-1', msg: 'No token provided', data: null });
  }

  const token = authHeader.split(' ')[1];
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.xtUser = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ code: '-1', msg: 'Invalid or expired token', data: null });
  }
}

// Setup XT User routes
export function setupXtUserRoutes(app, db) {
  
  // ============================================
  // XT User Credential Management Endpoints
  // These link XT credentials to existing MEXC users
  // ============================================

  // POST /api/xt-user/add-credentials - Add XT credentials for a MEXC user
  app.post('/api/xt-user/add-credentials', verifyXtToken, async (req, res) => {
    try {
      const { apiKey, apiSecret } = req.body;
      const mexcUserId = req.xtUser.id; // The MEXC user ID from token

      if (!apiKey || !apiSecret) {
        return res.status(400).json({ 
          code: '-1', 
          msg: 'API Key and Secret are required', 
          data: null 
        });
      }

      // Validate credentials against XT API
      console.log(`🔐 Validating XT credentials for MEXC user: ${mexcUserId}`);
      const validation = await validateXtCredentials(apiKey, apiSecret);

      if (!validation.valid) {
        console.log(`❌ XT credential validation failed: ${validation.error}`);
        return res.status(401).json({ 
          code: '-1', 
          msg: validation.error || 'Invalid XT credentials', 
          data: null 
        });
      }

      console.log(`✅ XT credentials validated successfully`);

      // Check if XT credentials already exist for this MEXC user
      let xtUser = await db.collection('xt_users').findOne({ mexcUserId });

      if (xtUser) {
        // Update existing XT credentials
        await db.collection('xt_users').updateOne(
          { mexcUserId },
          { 
            $set: { 
              apiKey,
              apiSecret,
              lastUpdatedAt: new Date(),
              updatedAt: new Date()
            } 
          }
        );
        xtUser = await db.collection('xt_users').findOne({ mexcUserId });
      } else {
        // Create new XT user entry
        const newXtUser = {
          mexcUserId,
          apiKey,
          apiSecret,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastUpdatedAt: new Date(),
          isActive: true
        };
        const result = await db.collection('xt_users').insertOne(newXtUser);
        xtUser = { ...newXtUser, _id: result.insertedId };
      }

      console.log(`✅ XT credentials saved for MEXC user: ${mexcUserId}`);

      res.json({
        code: '0',
        msg: 'XT credentials added successfully',
        data: {
          id: xtUser._id.toString(),
          mexcUserId: xtUser.mexcUserId,
          apiKey: xtUser.apiKey.substring(0, 8) + '...',
          createdAt: xtUser.createdAt,
          lastUpdatedAt: xtUser.lastUpdatedAt
        }
      });
    } catch (error) {
      console.error('XT add credentials error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to add XT credentials', data: null });
    }
  });

  // GET /api/xt-user/credentials - Check if XT credentials exist for user
  app.get('/api/xt-user/credentials', verifyXtToken, async (req, res) => {
    try {
      const mexcUserId = req.xtUser.id;
      const xtUser = await db.collection('xt_users').findOne({ mexcUserId });

      if (!xtUser) {
        return res.json({
          code: '0',
          msg: 'No XT credentials found',
          data: {
            hasCredentials: false
          }
        });
      }

      res.json({
        code: '0',
        msg: 'Success',
        data: {
          hasCredentials: true,
          id: xtUser._id.toString(),
          apiKey: xtUser.apiKey.substring(0, 8) + '...',
          createdAt: xtUser.createdAt,
          lastUpdatedAt: xtUser.lastUpdatedAt,
          isActive: xtUser.isActive
        }
      });
    } catch (error) {
      console.error('Get XT credentials error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get XT credentials', data: null });
    }
  });

  // DELETE /api/xt-user/credentials - Remove XT credentials
  app.delete('/api/xt-user/credentials', verifyXtToken, async (req, res) => {
    try {
      const mexcUserId = req.xtUser.id;
      
      const result = await db.collection('xt_users').deleteOne({ mexcUserId });

      if (result.deletedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'XT credentials not found', data: null });
      }

      // Also delete associated bots and logs
      await db.collection('xt_user_bots').deleteMany({ mexcUserId });
      await db.collection('xt_user_bot_logs').deleteMany({ mexcUserId });

      console.log(`🗑️ XT credentials deleted for MEXC user: ${mexcUserId}`);
      res.json({ code: '0', msg: 'XT credentials deleted successfully', data: null });
    } catch (error) {
      console.error('Delete XT credentials error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to delete XT credentials', data: null });
    }
  });

  // GET /api/xt-user/validate - Validate current XT credentials
  app.get('/api/xt-user/validate', verifyXtToken, async (req, res) => {
    try {
      const mexcUserId = req.xtUser.id;
      const xtUser = await db.collection('xt_users').findOne({ mexcUserId });

      if (!xtUser) {
        return res.status(404).json({ code: '-1', msg: 'XT credentials not found', data: null });
      }

      // Validate credentials against XT API
      const validation = await validateXtCredentials(xtUser.apiKey, xtUser.apiSecret);

      if (validation.valid) {
        res.json({ 
          code: '0', 
          msg: 'XT credentials are valid', 
          data: { valid: true } 
        });
      } else {
        res.json({ 
          code: '-1', 
          msg: validation.error || 'XT credentials are invalid', 
          data: { valid: false } 
        });
      }
    } catch (error) {
      console.error('Validate XT credentials error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to validate XT credentials', data: null });
    }
  });

  console.log('✅ XT User routes initialized');
}

// Helper function to get XT user credentials from MEXC user ID
export async function getXtUserCredentials(db, mexcUserId) {
  try {
    const xtUser = await db.collection('xt_users').findOne({ mexcUserId });

    if (!xtUser) {
      return null;
    }

    return {
      apiKey: xtUser.apiKey,
      apiSecret: xtUser.apiSecret,
      xtUserId: xtUser._id.toString()
    };
  } catch (error) {
    console.error('Error getting XT user credentials:', error);
    return null;
  }
}

// Export signature helpers for use in other modules
export { generateXtSignature, buildSignatureMessage };

export default setupXtUserRoutes;

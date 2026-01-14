import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

const MEXC_BASE_URL = process.env.MEXC_BASE_URL || 'https://api.mexc.com';
const JWT_SECRET = process.env.JWT_SECRET || 'mexc-bot-secret-key-change-in-production';

// Generate MEXC signature for a given query string and secret
function generateMexcSignature(queryString, apiSecret) {
  return crypto
    .createHmac('sha256', apiSecret)
    .update(queryString)
    .digest('hex');
}

// Validate MEXC credentials by making a test API call
async function validateMexcCredentials(apiKey, apiSecret) {
  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = generateMexcSignature(queryString, apiSecret);

    const response = await fetch(`${MEXC_BASE_URL}/api/v3/account?${queryString}&signature=${signature}`, {
      method: 'GET',
      headers: {
        'X-MEXC-APIKEY': apiKey,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    
    if (data.balances) {
      return { valid: true, data };
    }
    return { valid: false, error: data.msg || 'Invalid credentials' };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// Middleware to verify MEXC user token
export function verifyMexcToken(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ code: '-1', msg: 'No token provided', data: null });
  }

  const token = authHeader.split(' ')[1];
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.mexcUser = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ code: '-1', msg: 'Invalid or expired token', data: null });
  }
}

// Setup MEXC User routes
export function setupMexcUserRoutes(app, db) {
  
  // ============================================
  // MEXC User Authentication Endpoints
  // ============================================

  // POST /api/mexc-user/login - Login with MEXC API credentials
  app.post('/api/mexc-user/login', async (req, res) => {
    try {
      const { apiKey, apiSecret } = req.body;

      if (!apiKey || !apiSecret) {
        return res.status(400).json({ 
          code: '-1', 
          msg: 'API Key and Secret are required', 
          data: null 
        });
      }

      // Validate credentials against MEXC API
      console.log(`🔐 Validating MEXC credentials for key: ${apiKey.substring(0, 8)}...`);
      const validation = await validateMexcCredentials(apiKey, apiSecret);

      if (!validation.valid) {
        console.log(`❌ MEXC credential validation failed: ${validation.error}`);
        return res.status(401).json({ 
          code: '-1', 
          msg: validation.error || 'Invalid MEXC credentials', 
          data: null 
        });
      }

      console.log(`✅ MEXC credentials validated successfully`);

      // Check if user already exists
      let user = await db.collection('mexc_users').findOne({ apiKey });

      if (user) {
        // Update existing user
        await db.collection('mexc_users').updateOne(
          { apiKey },
          { 
            $set: { 
              apiSecret,
              lastLoginAt: new Date(),
              updatedAt: new Date()
            } 
          }
        );
        user = await db.collection('mexc_users').findOne({ apiKey });
      } else {
        // Create new user
        const newUser = {
          apiKey,
          apiSecret,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastLoginAt: new Date(),
          isActive: true
        };
        const result = await db.collection('mexc_users').insertOne(newUser);
        user = { ...newUser, _id: result.insertedId };
      }

      // Generate JWT token
      const token = jwt.sign(
        { 
          id: user._id.toString(),
          apiKey: user.apiKey 
        },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      console.log(`🎫 JWT token generated for user: ${user._id}`);

      res.json({
        code: '0',
        msg: 'Login successful',
        data: {
          token,
          user: {
            id: user._id.toString(),
            apiKey: user.apiKey.substring(0, 8) + '...',
            createdAt: user.createdAt,
            lastLoginAt: user.lastLoginAt
          }
        }
      });
    } catch (error) {
      console.error('MEXC login error:', error);
      res.status(500).json({ code: '-1', msg: 'Login failed', data: null });
    }
  });

  // GET /api/mexc-user/user - Get current user info
  app.get('/api/mexc-user/user', verifyMexcToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const user = await db.collection('mexc_users').findOne({ 
        _id: new ObjectId(req.mexcUser.id) 
      });

      if (!user) {
        return res.status(404).json({ code: '-1', msg: 'User not found', data: null });
      }

      res.json({
        code: '0',
        msg: 'Success',
        data: {
          id: user._id.toString(),
          apiKey: user.apiKey.substring(0, 8) + '...',
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt,
          isActive: user.isActive
        }
      });
    } catch (error) {
      console.error('Get user error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get user info', data: null });
    }
  });

  // POST /api/mexc-user/logout - Logout (client-side token removal)
  app.post('/api/mexc-user/logout', verifyMexcToken, async (req, res) => {
    // JWT is stateless, so logout is handled client-side
    // But we can log the event
    console.log(`🚪 User logged out: ${req.mexcUser.id}`);
    res.json({ code: '0', msg: 'Logged out successfully', data: null });
  });

  // GET /api/mexc-user/validate - Validate current token
  app.get('/api/mexc-user/validate', verifyMexcToken, async (req, res) => {
    res.json({ 
      code: '0', 
      msg: 'Token is valid', 
      data: { userId: req.mexcUser.id } 
    });
  });

  console.log('✅ MEXC User Auth routes initialized');
}

// Helper function to get user credentials from token
export async function getMexcUserCredentials(db, userId) {
  try {
    const { ObjectId } = await import('mongodb');
    const user = await db.collection('mexc_users').findOne({ 
      _id: new ObjectId(userId) 
    });

    if (!user) {
      return null;
    }

    return {
      apiKey: user.apiKey,
      apiSecret: user.apiSecret
    };
  } catch (error) {
    console.error('Error getting user credentials:', error);
    return null;
  }
}

export default setupMexcUserRoutes;

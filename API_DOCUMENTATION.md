# MMBot API Documentation

Base URL: `https://api.gcbtoken.io`

## Authentication

Most endpoints require authentication via Bearer token in the Authorization header:
```
Authorization: Bearer <your_gcbex_token>
```

---

## Auth Endpoints

### Generate QR Code
**GET** `/api/auth/qrcode`

Generate a new QR code for login.

**Response:**
```json
{
  "code": "0",
  "msg": "Success",
  "data": {
    "qrcodeId": "string",
    "qrcodeUrl": "string"
  }
}
```

### Check QR Code Status
**POST** `/api/auth/qrcode/status`

Check the scan status of a QR code.

**Request Body:**
```json
{
  "qrcodeId": "string"
}
```

**Response:**
```json
{
  "code": "0",
  "msg": "Success",
  "data": {
    "status": "2",
    "token": "string",
    "uid": "string"
  }
}
```

Status codes:
- `0`: Not scanned
- `1`: Scanned, waiting for confirmation
- `2`: Confirmed (login successful)
- `3`: Expired

---

## Market Data Endpoints

### Get Exchange Rates
**POST** `/api/market/rates`

Get current exchange rates for all trading pairs.

**Request Body:**
```json
{
  "fiat": "USD"
}
```

**Response:**
```json
{
  "code": "0",
  "msg": "Success",
  "data": {
    "rate": {
      "USD": {
        "BTC": 91674.21,
        "ETH": 3142.69,
        "GCB": 0.027190393821,
        ...
      }
    },
    "lang_coin": "USD",
    "coin_precision": "4"
  }
}
```

### Get Public Contract Info
**POST** `/api/market/public-info`

Get public information about contracts, trading pairs, and market configuration.

**Response:**
```json
{
  "code": "0",
  "msg": "Succeeded",
  "data": {
    "marginCoinList": ["EXUSD", "USDT"],
    "contractList": [...],
    "currentTimeMillis": 1765201959000,
    "wsUrl": "wss://futuresws.gcbex.com/kline-api/ws"
  }
}
```

### Get Market Ticker
**POST** `/api/market/ticker`

Get real-time market ticker data for specific symbols.

**Request Body:**
```json
{
  "symbols": ["BTC-USDT", "ETH-USDT", "GCB-USDT"]
}
```

**Response:**
```json
{
  "code": "0",
  "msg": "Success",
  "data": {
    "BTC-USDT": {
      "lastPrice": "91674.21",
      "volume24h": "1234567",
      "high24h": "92000",
      "low24h": "91000",
      ...
    }
  }
}
```

### Get OTC Public Info
**POST** `/api/market/otc-public-info`

Get OTC (Over-The-Counter) trading information.

**Response:**
```json
{
  "code": 0,
  "msg": "Success",
  "data": {
    "payments": [...],
    "paycoins": [...],
    "feeOtcList": [...]
  }
}
```

---

## User Endpoints

### Get Current User (Local)
**GET** `/api/users/me`

Get current user information from local database.

**Headers:**
```
Authorization: Bearer <token>
```

**Response:**
```json
{
  "code": "0",
  "msg": "success",
  "data": {
    "uid": "34034822",
    "token": "your_token",
    "last_login": "2025-01-04T12:00:00.000Z",
    "created_at": "2025-01-01T10:00:00.000Z"
  }
}
```

### Get User Info (GCBEX)
**POST** `/api/users/info`

Get detailed user information from GCBEX exchange.

**Headers:**
```
Authorization: Bearer <token>
```

**Response:**
```json
{
  "code": "0",
  "msg": "Success",
  "data": {
    "id": 34034822,
    "nickName": "GCB_34034822",
    "email": "ray***@gmail.com",
    "mobileNumber": "**2176",
    "realName": "Rayhan Al Mim",
    "feeCoin": "GCB",
    "feeCoinRate": "90.0000",
    ...
  }
}
```

### Get Account Balance
**POST** `/api/users/balance`

Get account balance from GCBEX exchange.

**Headers:**
```
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "accountType": 1
}
```

Account Types:
- `1`: Spot Trading
- `2`: Futures Trading
- `3`: Margin Trading

**Response:**
```json
{
  "code": "0",
  "msg": "Success",
  "data": {
    "balances": [
      {
        "coin": "USDT",
        "available": "1000.00",
        "frozen": "50.00",
        "total": "1050.00"
      },
      {
        "coin": "BTC",
        "available": "0.05",
        "frozen": "0.00",
        "total": "0.05"
      }
    ]
  }
}
```

---

## Health Check

### Check Server Health
**GET** `/api/health`

Check if the server and database are running.

**Response:**
```json
{
  "status": "ok",
  "database": "connected"
}
```

---

## Error Responses

All endpoints may return error responses in the following format:

```json
{
  "code": "-1",
  "msg": "Error message description",
  "data": null
}
```

Common HTTP Status Codes:
- `200`: Success
- `400`: Bad Request (missing parameters)
- `401`: Unauthorized (invalid or missing token)
- `404`: Not Found
- `500`: Internal Server Error

---

## Rate Limiting

Currently, there are no rate limits on the local API server. However, the GCBEX exchange API may have its own rate limits.

---

## WebSocket Connection

For real-time market data, connect to:
```
wss://futuresws.gcbex.com/kline-api/ws
```

WebSocket messages should include the `uaTime` parameter in the format: `YYYY-MM-DD HH:mm:ss`

---

## Examples

### JavaScript/Fetch Example

```javascript
// Get market rates
const getRates = async () => {
  const response = await fetch('https://api.gcbtoken.io/api/market/rates', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fiat: 'USD' }),
  });
  const data = await response.json();
  console.log(data);
};

// Get user balance
const getBalance = async (token) => {
  const response = await fetch('https://api.gcbtoken.io/api/users/balance', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ accountType: 1 }),
  });
  const data = await response.json();
  console.log(data);
};
```

### cURL Example

```bash
# Get market rates
curl -X POST https://api.gcbtoken.io/api/market/rates \
  -H "Content-Type: application/json" \
  -d '{"fiat":"USD"}'

# Get user balance
curl -X POST https://api.gcbtoken.io/api/users/balance \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"accountType":1}'
```

---

## Notes

1. All timestamps are in UTC
2. The `uaTime` parameter is automatically added to all GCBEX API requests
3. Tokens are stored securely in MongoDB
4. User authentication is handled via QR code login from the GCBEX mobile app

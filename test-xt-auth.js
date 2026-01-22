import crypto from 'crypto';
import 'dotenv/config';

const XT_BASE_URL = 'https://sapi.xt.com';

// Replace these with your VPS-whitelisted credentials
const API_KEY = 'db15208f-233c-45d0-9ca6-bf6fc7a91177';
const API_SECRET = 'YOUR_VPS_API_SECRET';

function generateXtSignature(secretKey, original) {
  return crypto
    .createHmac('sha256', secretKey)
    .update(original)
    .digest('hex');
}

function buildSignatureMessage(method, path, queryString, bodyJson, headers) {
  const headerParts = [];
  headerParts.push(`validate-algorithms=${headers['validate-algorithms']}`);
  headerParts.push(`validate-appkey=${headers['validate-appkey']}`);
  headerParts.push(`validate-recvwindow=${headers['validate-recvwindow']}`);
  headerParts.push(`validate-timestamp=${headers['validate-timestamp']}`);
  const X = headerParts.join('&');

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

async function testXtAuth() {
  try {
    console.log('🔍 Testing XT API Authentication...\n');
    
    // Step 1: Get XT server time
    console.log('Step 1: Getting XT server time...');
    const timeRes = await fetch(`${XT_BASE_URL}/v4/public/time`);
    const timeData = await timeRes.json();
    console.log('XT Server Time:', timeData.result?.serverTime);
    
    const localTime = Date.now();
    const serverTime = timeData.result?.serverTime || localTime;
    const offset = serverTime - localTime;
    console.log('Local Time:', localTime);
    console.log('Time Offset:', offset, 'ms\n');
    
    // Step 2: Make authenticated request
    console.log('Step 2: Making authenticated request...');
    const timestamp = (localTime + offset).toString();
    const method = 'GET';
    const path = '/v4/balances';
    
    const headers = {
      'validate-algorithms': 'HmacSHA256',
      'validate-appkey': API_KEY,
      'validate-recvwindow': '5000',
      'validate-timestamp': timestamp
    };

    const original = buildSignatureMessage(method, path, '', '', headers);
    const signature = generateXtSignature(API_SECRET, original);

    console.log('Request Details:');
    console.log('- Method:', method);
    console.log('- Path:', path);
    console.log('- Timestamp:', timestamp);
    console.log('- Signature Message:', original.substring(0, 100) + '...');
    console.log('- Signature:', signature.substring(0, 20) + '...\n');

    const response = await fetch(`${XT_BASE_URL}${path}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'validate-algorithms': 'HmacSHA256',
        'validate-appkey': API_KEY,
        'validate-recvwindow': '5000',
        'validate-timestamp': timestamp,
        'validate-signature': signature
      }
    });

    const data = await response.json();
    
    console.log('Response:');
    console.log(JSON.stringify(data, null, 2));
    
    if (data.rc === 0) {
      console.log('\n✅ SUCCESS! Authentication working correctly.');
    } else {
      console.log('\n❌ FAILED! Error:', data.mc);
      console.log('\nPossible issues:');
      console.log('1. API Key not whitelisted for IP:', await (await fetch('https://api.ipify.org')).text());
      console.log('2. API Key or Secret incorrect');
      console.log('3. API Key permissions not set correctly (need Spot Trading)');
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testXtAuth();

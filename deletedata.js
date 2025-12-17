import 'dotenv/config';
import { MongoClient } from 'mongodb';
import readline from 'readline';

// MongoDB connection details
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "mmbot";

// All collections in the MMBot project
const COLLECTIONS = [
  'users',
  'bot_conditions',
  'bot_trades',
  'bot_admin_logs',
  'stabilizer_bots',
  'stabilizer_bot_trades',
  'market_maker_bots',
  'market_maker_bot_trades',
  'bot_config'
];

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bold: '\x1b[1m'
};

// Helper function to ask for confirmation
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}

// Main cleanup function
async function cleanupDatabase() {
  let client;

  try {
    console.log(`\n${colors.cyan}${colors.bold}╔════════════════════════════════════════════════════════════╗${colors.reset}`);
    console.log(`${colors.cyan}${colors.bold}║         MMBot MongoDB Database Cleanup Script              ║${colors.reset}`);
    console.log(`${colors.cyan}${colors.bold}╚════════════════════════════════════════════════════════════╝${colors.reset}\n`);

    // Check MongoDB URI
    if (!MONGODB_URI) {
      console.error(`${colors.red}❌ Error: MONGODB_URI not found in environment variables${colors.reset}`);
      console.error(`${colors.yellow}💡 Make sure your .env file is in the correct location${colors.reset}\n`);
      process.exit(1);
    }

    console.log(`${colors.blue}📊 Database: ${colors.bold}${DB_NAME}${colors.reset}`);
    console.log(`${colors.blue}🗄️  Collections to clean: ${colors.bold}${COLLECTIONS.length}${colors.reset}\n`);

    // Display collections
    console.log(`${colors.yellow}Collections that will be cleared:${colors.reset}`);
    COLLECTIONS.forEach((col, index) => {
      console.log(`   ${index + 1}. ${col}`);
    });
    console.log();

    // First confirmation
    console.log(`${colors.red}${colors.bold}⚠️  WARNING: This will DELETE ALL DATA from the above collections!${colors.reset}`);
    console.log(`${colors.red}${colors.bold}⚠️  This action CANNOT be undone!${colors.reset}\n`);
    
    const firstConfirm = await askQuestion(`${colors.yellow}Are you sure you want to proceed? (yes/no): ${colors.reset}`);
    
    if (firstConfirm.toLowerCase() !== 'yes') {
      console.log(`\n${colors.green}✅ Operation cancelled. No data was deleted.${colors.reset}\n`);
      process.exit(0);
    }

    // Second confirmation for safety
    const secondConfirm = await askQuestion(`${colors.red}${colors.bold}Type 'DELETE ALL DATA' to confirm: ${colors.reset}`);
    
    if (secondConfirm !== 'DELETE ALL DATA') {
      console.log(`\n${colors.green}✅ Operation cancelled. No data was deleted.${colors.reset}\n`);
      process.exit(0);
    }

    // Connect to MongoDB
    console.log(`\n${colors.cyan}🔌 Connecting to MongoDB...${colors.reset}`);
    client = await MongoClient.connect(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
    
    const db = client.db(DB_NAME);
    console.log(`${colors.green}✅ Connected successfully!${colors.reset}\n`);

    // Get existing collections
    const existingCollections = await db.listCollections().toArray();
    const existingCollectionNames = existingCollections.map(c => c.name);

    console.log(`${colors.cyan}${colors.bold}🧹 Starting cleanup process...${colors.reset}\n`);

    let totalDeleted = 0;
    const results = [];

    // Delete data from each collection
    for (const collectionName of COLLECTIONS) {
      try {
        if (!existingCollectionNames.includes(collectionName)) {
          console.log(`${colors.yellow}⚠️  Collection '${collectionName}' does not exist - skipping${colors.reset}`);
          results.push({ collection: collectionName, status: 'not_found', deleted: 0 });
          continue;
        }

        // Count documents before deletion
        const collection = db.collection(collectionName);
        const countBefore = await collection.countDocuments();

        if (countBefore === 0) {
          console.log(`${colors.blue}📭 Collection '${collectionName}' is already empty${colors.reset}`);
          results.push({ collection: collectionName, status: 'empty', deleted: 0 });
          continue;
        }

        // Delete all documents
        const result = await collection.deleteMany({});
        totalDeleted += result.deletedCount;

        console.log(`${colors.green}✅ Deleted ${colors.bold}${result.deletedCount}${colors.reset}${colors.green} document(s) from '${collectionName}'${colors.reset}`);
        results.push({ collection: collectionName, status: 'success', deleted: result.deletedCount });

      } catch (error) {
        console.error(`${colors.red}❌ Error deleting from '${collectionName}': ${error.message}${colors.reset}`);
        results.push({ collection: collectionName, status: 'error', deleted: 0, error: error.message });
      }
    }

    // Summary
    console.log(`\n${colors.cyan}${colors.bold}╔════════════════════════════════════════════════════════════╗${colors.reset}`);
    console.log(`${colors.cyan}${colors.bold}║                    Cleanup Summary                         ║${colors.reset}`);
    console.log(`${colors.cyan}${colors.bold}╚════════════════════════════════════════════════════════════╝${colors.reset}\n`);

    const successCount = results.filter(r => r.status === 'success').length;
    const errorCount = results.filter(r => r.status === 'error').length;
    const notFoundCount = results.filter(r => r.status === 'not_found').length;
    const emptyCount = results.filter(r => r.status === 'empty').length;

    console.log(`${colors.green}✅ Successfully cleaned: ${colors.bold}${successCount}${colors.reset}${colors.green} collection(s)${colors.reset}`);
    console.log(`${colors.blue}📭 Already empty: ${colors.bold}${emptyCount}${colors.reset}${colors.blue} collection(s)${colors.reset}`);
    console.log(`${colors.yellow}⚠️  Not found: ${colors.bold}${notFoundCount}${colors.reset}${colors.yellow} collection(s)${colors.reset}`);
    console.log(`${colors.red}❌ Errors: ${colors.bold}${errorCount}${colors.reset}${colors.red} collection(s)${colors.reset}`);
    console.log(`${colors.cyan}📊 Total documents deleted: ${colors.bold}${totalDeleted}${colors.reset}\n`);

    // Detailed results table
    if (results.some(r => r.deleted > 0 || r.status === 'error')) {
      console.log(`${colors.cyan}Detailed Results:${colors.reset}`);
      console.log('─'.repeat(60));
      results.forEach(r => {
        const statusIcon = {
          success: '✅',
          error: '❌',
          not_found: '⚠️',
          empty: '📭'
        }[r.status];
        
        console.log(`${statusIcon} ${r.collection.padEnd(30)} | ${r.deleted} deleted`);
        if (r.error) {
          console.log(`   ${colors.red}Error: ${r.error}${colors.reset}`);
        }
      });
      console.log('─'.repeat(60));
    }

    console.log(`\n${colors.green}${colors.bold}✅ Database cleanup completed successfully!${colors.reset}\n`);

  } catch (error) {
    console.error(`\n${colors.red}${colors.bold}❌ Fatal Error: ${error.message}${colors.reset}`);
    console.error(`${colors.red}Stack trace: ${error.stack}${colors.reset}\n`);
    process.exit(1);
  } finally {
    if (client) {
      await client.close();
      console.log(`${colors.blue}🔌 MongoDB connection closed${colors.reset}\n`);
    }
  }
}

// Run the cleanup
cleanupDatabase().catch(error => {
  console.error(`${colors.red}❌ Unexpected error: ${error.message}${colors.reset}`);
  process.exit(1);
});

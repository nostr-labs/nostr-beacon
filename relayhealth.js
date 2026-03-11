import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// MongoDB connection details
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'nostr_beacon';
const RELAY_COLLECTION = 'relay_health';

// WebSocket connection timeout (ms)
const CONNECTION_TIMEOUT = 10000;
// Health check interval (ms) - default to every hour
const CHECK_INTERVAL = process.env.CHECK_INTERVAL ? parseInt(process.env.CHECK_INTERVAL) : 3600000;

// NOSTR REQ message to test relay functionality
const TEST_SUBSCRIPTION_ID = 'health_check_' + Math.floor(Math.random() * 1000000);
const TEST_REQ = JSON.stringify([
  "REQ",
  TEST_SUBSCRIPTION_ID,
  {
    "limit": 1,
    "kinds": [1]
  }
]);

// Raw relay list from the array provided
const rawRelayList = [
  'wss://192.168.1.172:4848',
  'wss://21ideas.nostr1.com',
  'wss://akseuzyizvorpc6ndazpjmxuyi4kkp5lm6z7sfje6zvkfxg2em4cn7id.local',
  'wss://algo.utxo.one',
  'wss://atlas.nostr.land',
  'wss://au.purplerelay.com',
  'wss://auth.nostr1.com',
  'wss://auth.nostr1.com/',
  'wss://bitcoiner.social',
  'wss://bitstack.app',
  'wss://blastr.f7z.xyz',
  'wss://blowater.nostr1.com',
  'wss://brb.io',
  'wss://btc.klendazu.com',
  'wss://ca.orangepill.dev',
  'wss://christpill.nostr1.com',
  'wss://relay.ditto.pub',
  'wss://e.nos.lol',
  'wss://eden.nostr.land',
  'wss://eden.nostr.land/',
  'wss://f7z.io',
  'wss://feeds.nostr.band/lang/zh',
  'wss://feeds.nostr.band/tony',
  'wss://fiatjaf.com',
  'wss://filter.nostr.wine',
  'wss://filter.nostr.wine/npub1udedyjm74y86u0yp5uvnfm5slpe9jfredjya9gx0pstahcja7s0sgka4zu?broadcast=true',
  'wss://freelay.sovbit.host',
  'wss://greensoul.space',
  'wss://inbox.azzamo.net',
  'wss://invillage-outvillage.com',
  'wss://ithurtswhenip.ee',
  'wss://kitchen.zap.cooking/',
  'wss://lightningrelay.com',
  'wss://lnbits.satoshibox.io/nostrclient/api/v1/relay',
  'wss://lndiscs.duckdns.org/nostrrelay/jVefQxoZ',
  'wss://lnp2prelaytt.sigmaenterprisesltd.com',
  'wss://lockbox.fiatjaf.com',
  'wss://mnl.v0l.io',
  'wss://multiplextr.coracle.social',
  'wss://n.wingu.se',
  'wss://no.str.cr',
  'wss://node.coincreek.com/nostrclient/api/v1/relay',
  'wss://nos.lol',
  'wss://nos.lol/',
  'wss://nostr-01.yakihonne.com',
  'wss://nostr-02.yakihonne.com',
  'wss://nostr-1.nbo.angani.co',
  'wss://nostr-pub.semisol.dev',
  'wss://nostr-pub.wellorder.net',
  'wss://nostr-relay.app',
  'wss://nostr-relay.app/',
  'wss://nostr-relay.bitcoin.ninja',
  'wss://nostr-relay.derekross.me',
  'wss://nostr-relay.h3z.jp/',
  'wss://nostr-relay.psfoundation.info',
  'wss://nostr-relay.schnitzel.world',
  'wss://nostr-verif.slothy.win',
  'wss://nostr.0x7e.xyz',
  'wss://nostr.azte.co',
  'wss://nostr.babyshark.win',
  'wss://nostr.bitcoiner.social',
  'wss://nostr.bitcoiner.social/',
  'wss://nostr.btc-library.com',
  'wss://nostr.cercatrova.me',
  'wss://nostr.cheeserobot.org',
  'wss://nostr.cizmar.net',
  'wss://nostr.cloud.vinney.xyz',
  'wss://nostr.codingarena.top',
  'wss://nostr.coinfund.app/%20',
  'wss://nostr.comunidadecancaonova.com',
  'wss://nostr.data.haus',
  'wss://nostr.data.haus/',
  'wss://nostr.dlsouza.lol',
  'wss://nostr.einundzwanzig.space',
  'wss://nostr.fbxl.net',
  'wss://nostr.fmt.wiz.biz',
  'wss://nostr.fmt.wiz.biz/',
  'wss://nostr.fort-btc.club',
  'wss://nostr.gerbils.online',
  'wss://nostr.gleeze.com/',
  'wss://nostr.heavyrubberslave.com',
  'wss://nostr.heliodex.cf',
  'wss://nostr.hexhex.online',
  'wss://nostr.hifish.org',
  'wss://nostr.l00p.org',
  'wss://nostr.land',
  'wss://nostr.lol',
  'wss://nostr.lu.ke',
  'wss://nostr.madco.me',
  'wss://nostr.massmux.com',
  'wss://nostr.milou.lol',
  'wss://nostr.mom',
  'wss://nostr.mom/',
  'wss://nostr.monstr.ing',
  'wss://nostr.mutinywallet.com/',
  'wss://nostr.naut.social',
  'wss://nostr.novacisko.cz',
  'wss://nostr.orangepill.dev',
  'wss://nostr.overmind.lol',
  'wss://nostr.oxtr.dev',
  'wss://nostr.oxtr.dev/',
  'wss://nostr.petrkr.net/strfry',
  'wss://nostr.rubberdoll.cc',
  'wss://nostr.sagaciousd.com',
  'wss://nostr.sats.li',
  'wss://nostr.sebastix.dev',
  'wss://nostr.self-determined.de',
  'wss://nostr.sidnlabs.nl',
  'wss://nostr.slothy.win',
  'wss://nostr.sudocarlos.com',
  'wss://nostr.tchaicap.space',
  'wss://nostr.wine',
  'wss://nostr.wine/',
  'wss://nostr02.sharkshake.net',
  'wss://nostr21.com',
  'wss://nostrelites.org',
  'wss://nostril.cam',
  'wss://nostrja-kari-nip50.heguro.com',
  'wss://nostrrelay.win',
  'wss://nostrsatva.net',
  'wss://nostrue.com',
  'wss://nrelay-jp.c-stellar.net/',
  'wss://offchain.pub',
  'wss://offchain.pub/',
  'wss://premis.one',
  'wss://primal-cache.mutinywallet.com/v1',
  'wss://prism.nostr1.com',
  'wss://puravida.nostr.land',
  'wss://purplepag.es',
  'wss://purplepag.es/',
  'wss://purplerelay.com',
  'wss://pyramid.fiatjaf.com',
  'wss://pyramid.fiatjaf.com/',
  'wss://r.hostr.cc',
  'wss://r.kojira.io',
  'wss://r.kojira.io/',
  'wss://ragnar-relay.com',
  'wss://reactions.v0l.io',
  'wss://relay-jp.nostr.wirednet.jp',
  'wss://relay-jp.nostr.wirednet.jp/',
  'wss://relay-pub.deschooling.us',
  'wss://relay.0xchat.com',
  'wss://relay.0xchat.com/',
  'wss://relay.8333.space',
  'wss://relay.artx.market/',
  'wss://relay.bitcoinpark.com',
  'wss://relay.bitmapstr.io',
  'wss://relay.casualcrypto.date',
  'wss://relay.coinos.io/',
  'wss://relay.crimsonleaf363.com',
  'wss://relay.current.fyi',
  'wss://relay.cxplay.org/',
  'wss://relay.damus.io',
  'wss://relay.damus.io/',
  'wss://relay.fountain.fm',
  'wss://relay.gasteazi.net',
  'wss://relay.getalby.com/v1',
  'wss://relay.ingwie.me',
  'wss://relay.keychat.io',
  'wss://relay.leligobit.link:31000',
  'wss://relay.lexingtonbitcoin.org',
  'wss://relay.lnfi.network',
  'wss://relay.minibolt.info',
  'wss://relay.momostr.pink/',
  'wss://relay.mostr.pub',
  'wss://relay.mostr.pub/',
  'wss://relay.mutinywallet.com',
  'wss://relay.nostr.amane.moe',
  'wss://relay.nostr.band',
  'wss://relay.nostr.band/',
  'wss://relay.nostr.bg',
  'wss://relay.nostr.bg/',
  'wss://relay.nostr.com.au',
  'wss://relay.nostr.lighting',
  'wss://relay.nostr.moe/',
  'wss://relay.nostr.nu',
  'wss://relay.nostr.wirednet.jp',
  'wss://relay.nostrdvm.com',
  'wss://relay.nostriches.org',
  'wss://relay.nostrid.com',
  'wss://relay.noswhere.com',
  'wss://relay.noswhere.com/',
  'wss://relay.nsecbunker.com',
  'wss://relay.oke.minds.io/nostr/v1/ws',
  'wss://relay.orangepill.dev',
  'wss://relay.orangepill.ovh',
  'wss://relay.primal.net',
  'wss://relay.primal.net/',
  'wss://relay.proxymana.net',
  'wss://relay.s-w.art',
  'wss://relay.shitforce.one',
  'wss://relay.snort.social',
  'wss://relay.snort.social/',
  'wss://relay.utxo.one',
  'wss://relay.vengeful.eu',
  'wss://relay.verified-nostr.com',
  'wss://relay.wellorder.net',
  'wss://relay.westernbtc.com/',
  'wss://relay01.karma.svaha-chain.online',
  'wss://relay1.nostrchat.io',
  'wss://relayable.org',
  'wss://rly.nostrkid.com',
  'wss://ryan.nostr1.com',
  'wss://sakhalin.nostr1.com',
  'wss://soloco.nl',
  'wss://strfry.iris.to',
  'wss://us.azzamo.net',
  'wss://us.nostr.wine/',
  'wss://wbc.nostr1.com',
  'wss://welcome.nostr.wine',
  'wss://wot.girino.org',
  'wss://wot.nostr.party',
  'wss://wot.sovbit.host',
  'wss://wot.utxo.one',
  'wss://yabu.me',
  'wss://yabu.me/',
  'wss://zap.watch'
];

// De-duplicate relay list by normalizing URLs (removing trailing slashes)
console.log(`Starting with ${rawRelayList.length} relay URLs...`);

// Function to normalize a URL (remove trailing slash)
function normalizeRelayUrl (url) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

// De-duplicate relay list
const relayMap = new Map();
rawRelayList.forEach(url => {
  const normalizedUrl = normalizeRelayUrl(url);
  if (!relayMap.has(normalizedUrl)) {
    relayMap.set(normalizedUrl, url); // Store original URL
  }
});

// Create the deduplicated list
const relayList = Array.from(relayMap.values());

console.log(`Removed ${rawRelayList.length - relayList.length} duplicates, testing ${relayList.length} unique relays`);
console.log('Duplicate entries removed:');
for (let i = 0; i < rawRelayList.length; i++) {
  const url = rawRelayList[i];
  const normalizedUrl = normalizeRelayUrl(url);

  // If this URL is not the one we chose to keep
  if (relayMap.get(normalizedUrl) !== url) {
    const keptUrl = relayMap.get(normalizedUrl);
    console.log(` - Skipping "${url}", using "${keptUrl}" instead`);
  }
}

// Live stats for real-time updates
const liveStats = {
  processed: 0,
  healthy: 0,
  unhealthy: 0,
  error: 0,
  timeout: 0,
  closed: 0,
  'no-response': 0,
  totalConnectTime: 0,
  totalResponseTime: 0,
  connectedRelays: 0,
  respondedRelays: 0,
  fastestRelay: null,
  slowestRelay: null,
  fastestConnectTime: Infinity,
  slowestConnectTime: 0,
  fastestResponseTime: Infinity,
  slowestResponseTime: 0
};

// Function to print current stats
function printCurrentStats () {
  const totalProcessed = liveStats.processed;
  const percentComplete = ((totalProcessed / relayList.length) * 100).toFixed(1);
  const avgConnectTime = liveStats.connectedRelays > 0 ? (liveStats.totalConnectTime / liveStats.connectedRelays).toFixed(2) : 'N/A';
  const avgResponseTime = liveStats.respondedRelays > 0 ? (liveStats.totalResponseTime / liveStats.respondedRelays).toFixed(2) : 'N/A';

  console.log(`\n--- CURRENT STATS (${percentComplete}% complete) ---`);
  console.log(`Processed: ${totalProcessed}/${relayList.length}`);
  console.log(`Healthy: ${liveStats.healthy} (${liveStats.healthy > 0 ? ((liveStats.healthy / totalProcessed) * 100).toFixed(1) : 0}%)`);

  console.log('Status counts:');
  console.log(` - healthy: ${liveStats.healthy}`);
  console.log(` - timeout: ${liveStats.timeout}`);
  console.log(` - error: ${liveStats.error}`);
  console.log(` - no-response: ${liveStats['no-response']}`);
  console.log(` - closed: ${liveStats.closed}`);

  console.log(`Avg connect time: ${avgConnectTime} ms`);
  console.log(`Avg response time: ${avgResponseTime} ms`);

  if (liveStats.fastestRelay) {
    console.log(`Fastest response: ${liveStats.fastestRelay} (${liveStats.fastestResponseTime} ms)`);
  }

  if (liveStats.slowestRelay) {
    console.log(`Slowest response: ${liveStats.slowestRelay} (${liveStats.slowestResponseTime} ms)`);
  }
  console.log('--------------------------------------');
}

// Function to update live stats with a result
function updateLiveStats (result) {
  liveStats.processed++;

  // Update status counts
  if (result.status in liveStats) {
    liveStats[result.status]++;
  }

  if (result.status === 'healthy') {
    liveStats.healthy++;
  } else {
    liveStats.unhealthy++;
  }

  // Update timing stats
  if (result.connectTime) {
    liveStats.totalConnectTime += result.connectTime;
    liveStats.connectedRelays++;

    // Check for fastest/slowest connect time
    if (result.connectTime < liveStats.fastestConnectTime) {
      liveStats.fastestConnectTime = result.connectTime;
    }

    if (result.connectTime > liveStats.slowestConnectTime) {
      liveStats.slowestConnectTime = result.connectTime;
    }
  }

  if (result.responseTime) {
    liveStats.totalResponseTime += result.responseTime;
    liveStats.respondedRelays++;

    // Check for fastest/slowest response time
    if (result.responseTime < liveStats.fastestResponseTime) {
      liveStats.fastestResponseTime = result.responseTime;
      liveStats.fastestRelay = result.url;
    }

    if (result.responseTime > liveStats.slowestResponseTime) {
      liveStats.slowestResponseTime = result.responseTime;
      liveStats.slowestRelay = result.url;
    }
  }

  // Print detailed result info
  const connectTime = result.connectTime ? `${result.connectTime}ms` : 'N/A';
  const responseTime = result.responseTime ? `${result.responseTime}ms` : 'N/A';
  const errorMsg = result.error ? `(${result.error})` : '';

  console.log(`[${liveStats.processed}/${relayList.length}] ${result.url}: ${result.status} | Connect: ${connectTime} | Response: ${responseTime} ${errorMsg}`);

  // Print stats every 10 relays or when all are complete
  if (liveStats.processed % 10 === 0 || liveStats.processed === relayList.length) {
    printCurrentStats();
  }
}

// Function to check if a relay is healthy
async function checkRelayHealth (relayUrl) {
  return new Promise((resolve) => {
    let isResolved = false;
    let hasReceivedResponse = false;
    let startTime = Date.now();
    let endTime;

    const timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        resolve({
          url: relayUrl,
          status: 'timeout',
          connectTime: CONNECTION_TIMEOUT,
          responseTime: null,
          timestamp: new Date(),
          error: 'Connection timeout'
        });
      }
    }, CONNECTION_TIMEOUT);

    try {
      // Initialize WebSocket connection
      const ws = new WebSocket(relayUrl, {
        headers: {
          'User-Agent': 'Nostr Beacon Health Monitor'
        },
        rejectUnauthorized: false, // Accept self-signed certificates
        handshakeTimeout: CONNECTION_TIMEOUT
      });

      // Handle connection open
      ws.on('open', () => {
        endTime = Date.now();
        const connectTime = endTime - startTime;

        // Send a test request to check if relay responds properly
        ws.send(TEST_REQ);

        // Set a timeout for response
        setTimeout(() => {
          if (!hasReceivedResponse && !isResolved) {
            isResolved = true;
            ws.close();
            resolve({
              url: relayUrl,
              status: 'no-response',
              connectTime,
              responseTime: null,
              timestamp: new Date(),
              error: 'No response to test request'
            });
          }
        }, 5000); // Wait 5 seconds for a response
      });

      // Handle messages
      ws.on('message', (data) => {
        hasReceivedResponse = true;
        const responseTime = Date.now() - endTime;

        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);
          ws.close();

          resolve({
            url: relayUrl,
            status: 'healthy',
            connectTime: endTime - startTime,
            responseTime,
            timestamp: new Date(),
            error: null
          });
        }
      });

      // Handle errors
      ws.on('error', (error) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);

          resolve({
            url: relayUrl,
            status: 'error',
            connectTime: null,
            responseTime: null,
            timestamp: new Date(),
            error: error.message
          });
        }
      });

      // Handle close
      ws.on('close', () => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);

          resolve({
            url: relayUrl,
            status: 'closed',
            connectTime: endTime ? endTime - startTime : null,
            responseTime: null,
            timestamp: new Date(),
            error: 'Connection closed without response'
          });
        }
      });
    } catch (error) {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutId);

        resolve({
          url: relayUrl,
          status: 'error',
          connectTime: null,
          responseTime: null,
          timestamp: new Date(),
          error: error.message
        });
      }
    }
  });
}

// Function to check health of all relays
async function checkAllRelays () {
  console.log(`Starting health check for ${relayList.length} unique relays at ${new Date().toISOString()}`);

  let client;
  try {
    // Connect to MongoDB
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    const relayHealthCollection = db.collection(RELAY_COLLECTION);

    // Limit concurrent checks to avoid overwhelming the system
    const batchSize = 10;
    let results = [];

    for (let i = 0; i < relayList.length; i += batchSize) {
      const batch = relayList.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(url => checkRelayHealth(url)));

      // Store each result in MongoDB and update live stats
      for (const result of batchResults) {
        // Update live stats
        updateLiveStats(result);

        // Store in MongoDB
        await relayHealthCollection.updateOne(
          { url: result.url },
          {
            $set: {
              lastCheck: result.timestamp,
              lastStatus: result.status,
              lastConnectTime: result.connectTime,
              lastResponseTime: result.responseTime,
              lastError: result.error,
              normalizedUrl: normalizeRelayUrl(result.url)
            },
            $push: {
              history: {
                $each: [result],
                $slice: -100 // Keep last 100 checks
              }
            },
            $inc: {
              totalChecks: 1,
              ...(result.status === 'healthy' ? { successfulChecks: 1 } : {})
            }
          },
          { upsert: true }
        );

        results.push(result);
      }
    }

    // Calculate averages
    const healthy = liveStats.healthy;
    const unhealthy = liveStats.unhealthy;
    const avgConnectTime = liveStats.connectedRelays > 0 ? liveStats.totalConnectTime / liveStats.connectedRelays : null;
    const avgResponseTime = liveStats.respondedRelays > 0 ? liveStats.totalResponseTime / liveStats.respondedRelays : null;

    // Store summary stats
    await relayHealthCollection.updateOne(
      { url: 'summary' },
      {
        $set: {
          timestamp: new Date(),
          totalRelays: relayList.length,
          healthyRelays: healthy,
          unhealthyRelays: unhealthy,
          healthPercentage: (healthy / relayList.length) * 100,
          avgConnectTime,
          avgResponseTime,
          statusCounts: {
            healthy: liveStats.healthy,
            timeout: liveStats.timeout,
            error: liveStats.error,
            'no-response': liveStats['no-response'],
            closed: liveStats.closed
          },
          fastestRelay: liveStats.fastestRelay,
          fastestResponseTime: liveStats.fastestResponseTime,
          slowestRelay: liveStats.slowestRelay,
          slowestResponseTime: liveStats.slowestResponseTime
        }
      },
      { upsert: true }
    );

    console.log(`\n=== HEALTH CHECK SUMMARY ===`);
    console.log(`Health check completed at ${new Date().toISOString()}`);
    console.log(`Tested ${relayList.length} unique relays (removed ${rawRelayList.length - relayList.length} duplicates)`);
    console.log(`Results: ${healthy} healthy (${((healthy / relayList.length) * 100).toFixed(2)}%), ${unhealthy} unhealthy`);
    console.log(`Average connect time: ${avgConnectTime?.toFixed(2) || 'N/A'}ms, Average response time: ${avgResponseTime?.toFixed(2) || 'N/A'}ms`);
    if (liveStats.fastestRelay) {
      console.log(`Fastest relay: ${liveStats.fastestRelay} (${liveStats.fastestResponseTime}ms)`);
    }
    console.log(`=============================`);

    // Separate healthy and unhealthy relays
    const healthyRelays = results.filter(result => result.status === 'healthy');
    const unhealthyRelays = results.filter(result => result.status !== 'healthy');

    // Sort healthy relays by response time (fastest first)
    healthyRelays.sort((a, b) => {
      if (a.responseTime === null) return 1;
      if (b.responseTime === null) return -1;
      return a.responseTime - b.responseTime;
    });

    // Print healthy relays ordered by fastest first
    console.log(`\n=== HEALTHY RELAYS (${healthyRelays.length}) - ORDERED BY FASTEST RESPONSE ===`);
    healthyRelays.forEach((relay, index) => {
      console.log(`${index + 1}. ${relay.url} - Response: ${relay.responseTime}ms, Connect: ${relay.connectTime}ms`);
    });

    // Print unhealthy relays
    console.log(`\n=== UNHEALTHY RELAYS (${unhealthyRelays.length}) ===`);
    const statusGroups = {};
    unhealthyRelays.forEach(relay => {
      if (!statusGroups[relay.status]) {
        statusGroups[relay.status] = [];
      }
      statusGroups[relay.status].push(relay);
    });

    // Print grouped by status
    for (const [status, relays] of Object.entries(statusGroups)) {
      console.log(`\n-- ${status.toUpperCase()} (${relays.length}) --`);
      relays.forEach((relay, index) => {
        const errorInfo = relay.error ? ` - Error: ${relay.error}` : '';
        console.log(`${index + 1}. ${relay.url}${errorInfo}`);
      });
    }
    console.log(`\n=============================`);

    return results;

  } catch (error) {
    console.error('Error in relay health check:', error);
  } finally {
    if (client) await client.close();
  }
}

// Reset live stats before each run
function resetLiveStats () {
  liveStats.processed = 0;
  liveStats.healthy = 0;
  liveStats.unhealthy = 0;
  liveStats.error = 0;
  liveStats.timeout = 0;
  liveStats.closed = 0;
  liveStats['no-response'] = 0;
  liveStats.totalConnectTime = 0;
  liveStats.totalResponseTime = 0;
  liveStats.connectedRelays = 0;
  liveStats.respondedRelays = 0;
  liveStats.fastestRelay = null;
  liveStats.slowestRelay = null;
  liveStats.fastestConnectTime = Infinity;
  liveStats.slowestConnectTime = 0;
  liveStats.fastestResponseTime = Infinity;
  liveStats.slowestResponseTime = 0;
}

// Run health check once immediately
resetLiveStats();
checkAllRelays().catch(console.error);

// Schedule regular health checks
if (process.env.RUN_ONCE !== 'true') {
  console.log(`Scheduling health checks every ${CHECK_INTERVAL / 60000} minutes`);
  setInterval(() => {
    resetLiveStats();
    checkAllRelays().catch(console.error);
  }, CHECK_INTERVAL);
}

// Export function for external use
export { checkRelayHealth, checkAllRelays, normalizeRelayUrl };


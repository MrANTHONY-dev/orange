// oroswap-bot.js
const { ZigchainClient, Wallet } = require("@zigchain/zigchain-sdk");
const fetch = require("node-fetch");
require("dotenv").config();

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

// Exponential backoff retry wrapper
async function retry(fn, label) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= MAX_RETRIES) throw err;
      const delay = BASE_DELAY_MS * 2 ** attempt;
      console.warn(`${label} failed (attempt ${attempt}), retrying in ${delay}ms`, err.message);
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

async function logBalances(client, address) {
  const balances = await client.getBalances(address);
  console.log("🔍 Balances:", balances);
  return balances;
}

async function main() {
  const client = new ZigchainClient({
    rpc: process.env.RPC_URL,
    api: process.env.API_URL,
    network: "testnet"
  });
  const wallet = Wallet.fromMnemonic(process.env.MNEMONIC);
  console.log("🚀 Wallet:", wallet.bech32Address);

  const pairs = JSON.parse(process.env.PAIR_LIST);
  const swapAmount = parseInt(process.env.SWAP_AMOUNT, 10);

  while (true) {
    try {
      console.log("📅 Starting cycle at", new Date().toISOString());

      // Faucet
      await retry(async () => {
        const res = await fetch(process.env.FAUCET_URL, {
          method: "POST",
          headers: {"Content-Type":"application/json"},
          body: JSON.stringify({address: wallet.bech32Address})
        });
        const json = await res.json();
        console.log("⛽ Faucet claim:", json);
      }, "Faucet");

      await logBalances(client, wallet.bech32Address);

      // Loop through dynamic pairs
      for (const [inToken, outToken] of pairs) {
        console.log(`🔄 Swapping ${swapAmount} ${inToken} → ${outToken}`);
        const swapTx = await retry(
          () => client.swapExactIn(wallet.bech32Address, inToken, outToken, swapAmount),
          `Swap ${inToken}->${outToken}`
        );
        const swapRes = await retry(() => client.signAndBroadcast(swapTx, wallet), `Broadcast swap ${inToken}->${outToken}`);
        console.log(`✅ Swap TX: ${swapRes.transactionHash} status=${swapRes.code}`);

        // Provide and remove LP
        console.log(`➕ Adding liquidity to ${inToken}/${outToken}`);
        const addTx = await retry(
          () => client.addLiquidity(wallet.bech32Address, inToken, outToken, swapAmount/2, swapAmount/2),
          `Add LP ${inToken}/${outToken}`
        );
        const addRes = await retry(() => client.signAndBroadcast(addTx, wallet), `Broadcast add LP ${inToken}/${outToken}`);
        console.log(`✅ LP Add TX: ${addRes.transactionHash} status=${addRes.code}`);

        console.log(`➖ Removing 100% liquidity from ${inToken}/${outToken}`);
        const remTx = await retry(
          () => client.removeLiquidity(wallet.bech32Address, inToken, outToken, "100%"),
          `Remove LP ${inToken}/${outToken}`
        );
        const remRes = await retry(() => client.signAndBroadcast(remTx, wallet), `Broadcast remove LP ${inToken}/${outToken}`);
        console.log(`✅ LP Remove TX: ${remRes.transactionHash} status=${remRes.code}`);
      }

      // Log summary
      console.log("📊 End of cycle balances and points:");
      const balances = await logBalances(client, wallet.bech32Address);
      const points = await client.getPoints(wallet.bech32Address);
      console.log("🏅 Testnet points:", points);

    } catch (err) {
      console.error("❌ Fatal cycle error:", err);
    }

    const wait = parseInt(process.env.LOOP_INTERVAL_S, 10) * 1000;
    console.log(`⏱ Sleeping for ${wait/60000} minutes...\n`);
    await new Promise(res => setTimeout(res, wait));
  }
}

main().catch(console.error);

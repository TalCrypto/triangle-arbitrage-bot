# MEV Bot

Bot script to scan arbitrage opportunities by snipping mempool across multiple DEXs with flash loan and swap feature

# Installation

To run the script, the following steps must be followed:

1. Creating the .env file
   A `.env` file must be created at the root of the project directory.
   To do this, you can copy the `.env.example` file and rename it to `.env`.
   The following variables must be filled in with the urls for your node rpc http and websocket endpoints:

```
HTTPS_URL=...
HTTPS2_URL=...
WSS_URL=...
```

2. Installing dependencies
   To install the dependencies, run the following command:

```
npm install
```

3. Running the script
   To run the script, run the following command:

```
node index.js
```

The script may take quite some time to run for the first time, as there are not yet any cached data in the `data` folder.

## Setting up the scripts

> Assumption: New dev environment, first time running bot on the local machine

You'll need to run the command

```zsh
node src/tokendumpinfo.js
```

Currently we haven't specify passing in arguments, so will need to modify the `CHUNK_SIZE` paramter to be 100 on the first run, then 10, then 1

Then will have to run the command. This script is to eliminate toxic tokens.

```zsh
node src/patchpooltoken.js.js
cd contracts/forge
forge script ./script/FilterTrapToken.s.sol:FilterTrapToken --rpc-url http://127.0.0.1:8545
```

Same logic as above, modify `chunk` to be 100, then 10, then 1

<hr/>

Then you will deploy the TradeContract. The private key you have in your .env file that has the MATIC used to pay for gas for the trade transaction must _also_ be the `owner` defined in TradeContract.sol

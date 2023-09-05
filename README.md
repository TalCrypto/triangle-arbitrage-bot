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
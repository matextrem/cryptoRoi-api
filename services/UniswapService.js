'use strict'

const BigNumber = require('bignumber.js');
const ethers = require('ethers');
const axios = require('axios');
const UNISWAP_CONTRACT = require('../contracts/Uniswap');

require('dotenv').config();


const biteSize = 25000; // how many blocks (or rather logs) should we request at once (for Infura should be much lower)
const providerFeePercent = 0.003;
const UniswapService = {
  initialize: () => {
    UniswapService.providerCurrent = new ethers.providers.JsonRpcProvider('https://mainnet.infura.io/v3/c3ae26636c8646b0a76798e6a23b19cf'); //provider for current blocks, has to keep at least biteSize blocks/
    UniswapService.providerArchive = new ethers.providers.JsonRpcProvider('https://mainnet.infura.io/v3/c3ae26636c8646b0a76798e6a23b19cf'); //provider for "old" blocks
    UniswapService.iface = new ethers.utils.Interface(UNISWAP_CONTRACT.abi);
    UniswapService.numMyShareTokens = new BigNumber(0);
    UniswapService.numMintedShareTokens = new BigNumber(0);
    UniswapService.totalEthFees = 0.0;
    UniswapService.totalTokenFees = 0.0;
    UniswapService.tokenDecimals = 0;
    UniswapService.exchangeAddress = null;
    UniswapService.curPoolShare = 0;
    UniswapService.curPoolShareDisplay = 0;
    UniswapService.provider = UniswapService.providerArchive; // provider
    UniswapService.curEthTotal = 0;
    UniswapService.curTokenTotal = 0;
    UniswapService.data = {
      currentProfit: 0,
      liquidity: {
        eth: 0,
        tokens: 0,
        poolFees: 0,
        poolRate: 0
      },
      deposited: {
        total: 0,
        hasDeposit: false,
        poolShare: 0,
        eth: 0.0,
        tokens: 0.0
      }
    };
  },
  tokens: () => {
    return Object.keys(UNISWAP_CONTRACT.tokens);
  },
  get: async (address, token) => {
    UniswapService.initialize();
    const curSymbol = token || "RLC";
    UniswapService.tokenDecimals = Math.pow(10, UNISWAP_CONTRACT.tokens[curSymbol].decimals);
    UniswapService.exchangeAddress = UNISWAP_CONTRACT.tokens[curSymbol].address;
    const response = await UniswapService.getLogs(UNISWAP_CONTRACT.originBlock, UNISWAP_CONTRACT.originBlock + biteSize, address);
    return response;
  },
  tokenPrice: async token => {
    const response = await axios.get(`https://api.coinmarketcap.com/v1/ticker/${token}/?convert=USD`);
    return response.data[0].price_usd;
  },
  getLogs: async (fromBlock, toBlock, myAddress) => {
    let instance = UniswapService;
    await instance.provider.getLogs({
      fromBlock,
      toBlock,
      address: instance.exchangeAddress
    }).then((result) => {
      result.forEach((r) => {
        let parsedResult = instance.iface.parseLog(r);
        let eth = 0;
        let tokens = 0;
        let ethFee = 0;
        let tokenFee = 0;

        switch (parsedResult.name) {
          case 'AddLiquidity':
            eth = parsedResult.values.eth_amount / 1e18;
            tokens = parsedResult.values.token_amount / instance.tokenDecimals;
            UniswapService.updateDeposit({ ...parsedResult, txHash: r.transactionHash }, myAddress, eth, tokens, true);
            break;
          case 'RemoveLiquidity':
            eth = -parsedResult.values.eth_amount / 1e18;
            tokens = -parsedResult.values.token_amount / instance.tokenDecimals;
            UniswapService.updateDeposit({ ...parsedResult, txHash: r.transactionHash }, myAddress, eth, tokens, instance.data.deposited.hasDeposit);
            break;
          case 'Transfer': {
            let sender = parsedResult.values._from;
            let receiver = parsedResult.values._to;

            let numShareTokens = new BigNumber(parsedResult.values._value);

            if (receiver === "0x0000000000000000000000000000000000000000") {
              instance.numMintedShareTokens = instance.numMintedShareTokens.minus(numShareTokens);
              if (sender.toUpperCase() === myAddress.toUpperCase()) {
                instance.numMyShareTokens = instance.numMyShareTokens.minus(numShareTokens);
              }
            } else if (sender === "0x0000000000000000000000000000000000000000") {
              instance.numMintedShareTokens = instance.numMintedShareTokens.plus(numShareTokens);
              if (receiver.toUpperCase() === myAddress.toUpperCase()) {
                instance.numMyShareTokens = instance.numMyShareTokens.plus(numShareTokens);
              }
            }
            break;
          }
          case 'TokenPurchase':
            tokens = -parsedResult.values.tokens_bought / instance.tokenDecimals;
            eth = parsedResult.values.eth_sold / 1e18;
            tokenFee = (-tokens / (1 - providerFeePercent)) + tokens; // buying tokens, fee was deducted from tokens
            break;
          case 'EthPurchase':
            tokens = parsedResult.values.tokens_sold / instance.tokenDecimals;
            eth = -parsedResult.values.eth_bought / 1e18;
            ethFee = (-eth / (1 - providerFeePercent)) + eth;
            break;
          default:
            break;

        }

        // update eth and tokens
        instance.curEthTotal += eth;
        instance.curTokenTotal += tokens;

        // update current pool share. take users's share tokens and divide by total minted share tokens
        instance.curPoolShare = new BigNumber(
          instance.numMyShareTokens.dividedBy(instance.numMintedShareTokens)
        );
        if (isNaN(instance.curPoolShare) || instance.curPoolShare.toFixed(4) === 0) {
          instance.curPoolShare = 0;
          instance.data.deposited.eth = 0;
          instance.data.deposited.tokens = 0;
        }

        // get a percentage from the pool share
        instance.curPoolShareDisplay = (instance.curPoolShare * 100).toFixed(4);

        instance.totalEthFees += ethFee;
        instance.totalTokenFees += tokenFee;

        let ratio = (
          instance.curEthTotal / instance.curTokenTotal
        )

        let delta = (
          (instance.curPoolShare * instance.curTokenTotal - instance.data.deposited.tokens)
          * (instance.curEthTotal / instance.curTokenTotal)
          + (instance.curPoolShare * instance.curEthTotal - instance.data.deposited.eth)
        ).toPrecision(4);

        instance.data.liquidity.eth = instance.curEthTotal.toPrecision(6);
        instance.data.liquidity.tokens = instance.curTokenTotal.toPrecision(8);
        instance.data.liquidity.poolRate = ratio.toPrecision(4);
        instance.data.liquidity.poolFees = (instance.totalEthFees + instance.totalTokenFees * ratio).toPrecision(4);
        instance.data.currentProfit = delta;
        instance.data.deposited.poolShare = instance.curPoolShareDisplay;
      })

    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.log(err);
    });


    //switch to "current" mode
    if (toBlock > await instance.provider.getBlockNumber() - biteSize) {
      let provider = instance.providerCurrent;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let currentBlock = await provider.getBlockNumber();
        if (currentBlock > toBlock) {
          await UniswapService.getLogs(toBlock + 1, currentBlock, myAddress);
        }
        break;
      }
    } else {
      await UniswapService.getLogs(toBlock + 1, toBlock + biteSize, myAddress);
    }

    return instance.data;
  },
  getTransactionPrice: async txHash => {
    const response = await axios.get(`https://web3api.io/api/v1/transactions/${txHash}`, {
      params: {
        includePrice: true
      },
      // eslint-disable-next-line no-undef
      headers: { 'X-Api-Key': process.env.TX_API_KEY }
    });

    return Number(response.data.payload.price.value.total);
  },
  getDisplayData: async data => {
    const ethPrice = await UniswapService.tokenPrice('ethereum');
    const ethPriceFixed = Number(ethPrice).toFixed(2);
    const yourEth = ((data.liquidity.eth * data.deposited.poolShare) / 100).toFixed(2);
    const investmentToday = ((yourEth * ethPriceFixed) + (data.deposited.eth * ethPriceFixed)).toFixed(2);
    const valueHold = (investmentToday - (data.currentProfit * ethPriceFixed)).toFixed(2);
    const totalDeposited = data.deposited.total.toFixed(2);
    const netRoi = (((investmentToday - totalDeposited) / totalDeposited) * 100).toFixed(2);
    const priceRoi = (((valueHold - totalDeposited) / totalDeposited) * 100).toFixed(2);
    return {
      yourEth,
      yourToken: ((data.liquidity.tokens * data.deposited.poolShare) / 100).toFixed(2),
      investmentToday,
      valueHold,
      netRoi,
      priceRoi,
      uniswapRoi: (netRoi - priceRoi).toFixed(2),
      totalDeposited,
    }
  },
  updateDeposit: async (result, address, eth, tokens, deposited) => {
    if (result.values.provider.toUpperCase() === address.toUpperCase()) {
      UniswapService.data.deposited.eth = UniswapService.data.deposited.eth + eth;
      UniswapService.data.deposited.tokens = UniswapService.data.deposited.tokens + tokens;
      const txValue = await UniswapService.getTransactionPrice(result.txHash);
      UniswapService.data.deposited.total = UniswapService.data.deposited.total + txValue;
      UniswapService.data.deposited.hasDeposit = deposited;
    }
  }
}

module.exports = UniswapService;
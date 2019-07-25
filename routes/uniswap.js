const express = require('express');
const router = express.Router();
const uniswapService = require("../services/UniswapService");

router.get('/:address', async (req, res, next) => {
  try {
    const uniswapRoi = await uniswapService.get(req.params.address, req.query.token);
    const response = await uniswapService.getDisplayData(uniswapRoi);
    res.json(response);
  } catch (e) {
    next(e);
  }
});

module.exports = router;

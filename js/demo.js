/* =========================================================================
   DEMO MODE — §50
   Only used when the user explicitly toggles "Demo Mode" on the homepage.
   Entirely separate from PopDexApi / normalize logic so production never
   silently falls back to this data.
   ========================================================================= */
const DemoData = {
  _rand(seed) {
    let s = seed;
    return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  },

  buildTrades() {
    const rnd = this._rand(42);
    const now = Date.now();
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    const trades = [];
    for (let i = 0; i < 8; i++) {
      const symbol = symbols[i % symbols.length];
      const side = rnd() > 0.5 ? 'LONG' : 'SHORT';
      const basePrice = symbol === 'BTCUSDT' ? 110000 : symbol === 'ETHUSDT' ? 4200 : 210;
      const entryPrice = basePrice * (0.97 + rnd() * 0.06);
      const durationMin = 15 + Math.floor(rnd() * 240);
      const openTimestamp = now - (i + 1) * 86_400_000 - durationMin * 60_000;
      const closeTimestamp = openTimestamp + durationMin * 60_000;
      const move = (rnd() - 0.45) * 0.04; // slightly positive-biased
      const exitPrice = entryPrice * (1 + (side === 'LONG' ? move : -move));
      const size = Number((0.02 + rnd() * 0.3).toFixed(3));
      const leverage = [2, 5, 10, 20][Math.floor(rnd() * 4)];
      const grossPnl = (side === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice) * size;
      const fees = Math.abs(grossPnl) * 0.0006 + entryPrice * size * 0.0004;
      const funding = (rnd() - 0.5) * fees * 4;

      const position = normalizePosition({
        symbol, side, leverage,
        entryPrice, exitPrice, positionSize: size,
        openTime: openTimestamp, closeTime: closeTimestamp,
        realizedPnl: grossPnl,
        fee: fees, funding,
        liquidationPrice: side === 'LONG' ? entryPrice * (1 - 1 / leverage * 0.9) : entryPrice * (1 + 1 / leverage * 0.9),
        positionId: `demo-${i}-${openTimestamp}`,
      });
      trades.push(buildTrade(position, {}));
    }
    return trades;
  },

  enrichTrade(trade) {
    const p = trade.position;
    const rnd = this._rand(Math.abs(hashCode(String(p.positionId))));
    const durationMs = p.closeTimestamp - p.openTimestamp;
    const candleCount = Math.min(300, Math.max(10, Math.round(durationMs / 60000)));
    const candles = [];
    let price = p.entryPrice;
    const drift = (p.exitPrice - p.entryPrice) / candleCount;
    for (let i = 0; i < candleCount; i++) {
      const t = p.openTimestamp + i * (durationMs / candleCount);
      const noise = (rnd() - 0.5) * Math.abs(drift) * 6;
      const open = price;
      price = open + drift + noise;
      const high = Math.max(open, price) + Math.abs(noise) * 0.5;
      const low = Math.min(open, price) - Math.abs(noise) * 0.5;
      candles.push(normalizeCandle([t, open, high, low, price, rnd() * 5, rnd() * 5 * price]));
    }
    if (candles.length) candles[candles.length - 1].close = p.exitPrice;

    const orders = [
      normalizeOrder({ orderId: 'demo-o1', orderType: 'MARKET', side: p.side === 'LONG' ? 'BUY' : 'SELL', price: p.entryPrice, quantity: p.size, createdTime: p.openTimestamp, status: 'FILLED' }),
      normalizeOrder({ orderId: 'demo-o2', orderType: 'MARKET', side: p.side === 'LONG' ? 'SELL' : 'BUY', price: p.exitPrice, quantity: p.size, createdTime: p.closeTimestamp, status: 'FILLED' }),
    ];
    const fills = [
      normalizeFill({ fillId: 'demo-f1', orderId: 'demo-o1', side: p.side === 'LONG' ? 'BUY' : 'SELL', execPrice: p.entryPrice, execQty: p.size, fee: (p.fees ?? 0) / 2, timestamp: p.openTimestamp }),
      normalizeFill({ fillId: 'demo-f2', orderId: 'demo-o2', side: p.side === 'LONG' ? 'SELL' : 'BUY', execPrice: p.exitPrice, execQty: p.size, fee: (p.fees ?? 0) / 2, timestamp: p.closeTimestamp }),
    ];
    const fundingEvents = [];
    if (durationMs > 4 * 3600_000) {
      fundingEvents.push(normalizeFunding({ fundingRate: 0.0001, fundingRateTimestamp: p.openTimestamp + durationMs / 2, amount: p.funding }));
    }

    const enrichedTrade = buildTrade(p, { orders, fills, funding: fundingEvents, liquidations: [] });
    return { trade: enrichedTrade, candles };
  },
};

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; }
  return h || 1;
}

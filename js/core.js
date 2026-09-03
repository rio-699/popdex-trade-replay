/* =========================================================================
   DATA INTEGRITY MARKERS
   Every derived value on screen must be traceable to one of these.
   ========================================================================= */
const SRC = Object.freeze({ API: 'API_DATA', CALC: 'CALCULATED_DATA', NONE: 'UNAVAILABLE' });

/** Wrap a value with its provenance. Renderers key off `.src` to label/format it. */
function tag(value, src = SRC.API) {
  return { value, src };
}
const UNAVAILABLE = tag(null, SRC.NONE);

/* =========================================================================
   NORMALIZERS
   Only map fields that PopDEX actually returns. Never invent a field —
   if a normalizer can't find a value, it tags UNAVAILABLE instead of
   guessing or defaulting to 0 (0 is a real value and must not stand in
   for "no data").
   ========================================================================= */
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

function normalizePosition(p) {
  if (!p) return null;
  // openFee/closeFee come back as separate negative values from PopDEX's
  // live API (e.g. "-0.0293"); combine into one positive total fee.
  const openFee = num(p.openFee);
  const closeFee = num(p.closeFee);
  const combinedFee = (openFee === null && closeFee === null)
    ? null
    : Math.abs(openFee ?? 0) + Math.abs(closeFee ?? 0);
  return {
    raw: p,
    symbol: p.symbol ?? p.pair ?? null,
    side: (p.side ?? p.positionSide ?? '').toString().toUpperCase() || null,
    leverage: num(p.leverage ?? p.symbolLeverage),
    entryPrice: num(p.entryPrice ?? p.avgEntryPrice ?? p.avgOpenPrice),
    exitPrice: num(p.exitPrice ?? p.avgExitPrice ?? p.closePrice ?? p.avgClosePrice),
    size: num(p.positionSize ?? p.size ?? p.qty ?? p.maxQty ?? p.totalOpenQty ?? p.closeQty ?? p.dealQty ?? p.filledQty),
    // Prefer PopDEX's own reported trade volume when the API provides one
    // directly — that's the exact number the DEX itself shows, so it's the
    // only way to guarantee this matches their site. Only falls back to a
    // locally-derived notional (see renderSummary) when absent.
    volume: num(p.volume ?? p.tradeVolume ?? p.dealVolume ?? p.totalVolume ?? p.turnover),
    openTimestamp: num(p.openTime ?? p.createdTime ?? p.openTimestamp ?? p.createdAt),
    closeTimestamp: num(p.closeTime ?? p.updatedTime ?? p.closeTimestamp ?? p.updatedAt),
    realizedPnl: num(p.realizedPnl ?? p.pnl ?? p.closedPnl),
    fees: num(p.fee ?? p.totalFee ?? p.tradingFee) ?? combinedFee,
    funding: num(p.funding ?? p.totalFunding ?? p.fundingFee),
    liquidationPrice: num(p.liquidationPrice ?? p.liqPrice),
    positionId: p.positionId ?? p.id ?? null,
  };
}

/**
 * Lifetime volume rollup from /history/portfolio. The endpoint always
 * returns an array of period buckets (Day/Week/Month/Alltime) regardless
 * of the window/scope query params — confirmed against a real response.
 * Pick out the "Alltime" bucket and use its own `totalVolume` field
 * directly (PopDEX already sums futures + spot for us there).
 */
function normalizePortfolioHistory(data) {
  const list = Array.isArray(data) ? data : [];
  const allTime = list.find((p) => (p?.period ?? '').toString().toLowerCase() === 'alltime');
  if (!allTime) return null;
  return { raw: allTime, totalVolume: num(allTime.totalVolume) };
}

function normalizeOrder(o) {
  if (!o) return null;
  // Confirmed against a real /account/{wallet}/history/orders response
  // (PopDEX API docs): the fee is nested in `feeDetail[0].fee`, same shape
  // as fills (see normalizeFill). Extracted here so an order's own fee is
  // available even when it's not backed by a normalized fill.
  const feeDetail = Array.isArray(o.feeDetail) ? o.feeDetail[0] : null;
  return {
    raw: o,
    orderId: o.orderId ?? o.id ?? null,
    orderType: o.type ?? o.orderType ?? null,
    side: (o.side ?? '').toString().toUpperCase() || null,
    price: num(o.price),
    // Average price actually dealt — the real field is `avgDealPrice`, not
    // `price` (which is just the order's set/limit price and can be null
    // or stale relative to what actually filled). Kept separate from
    // `price` rather than replacing it, so callers can show both.
    avgDealPrice: num(o.avgDealPrice),
    // TP/SL prices live inside the nested `tpsl` object on the real API
    // (`tpsl.takeProfitPrice` / `tpsl.stopLossPrice`), not top-level
    // `triggerPrice`/`stopPrice` fields, which this endpoint never sends.
    triggerPrice: num(o.tpsl?.takeProfitPrice ?? o.tpsl?.stopLossPrice ?? o.triggerPrice ?? o.stopPrice),
    quantity: num(o.qty ?? o.quantity ?? o.size),
    // Actually-filled quantity, distinct from the requested `qty` above —
    // needed to tell a fully-filled order from a partially-filled one
    // without depending on `status` alone.
    filledQuantity: num(o.filledQty ?? o.filledQuantity),
    fee: num(feeDetail?.fee ?? o.fee ?? o.commission),
    // Real field is `createdAt` (ms). The old fallback chain
    // (createdTime/timestamp/time) never matches anything the live API
    // actually returns, so every order normalized to timestamp: null —
    // which meant buildTrade's `relevantOrders` filter (requires
    // timestamp != null) silently dropped every order from every trade.
    // That's what made the order history panel and replay timeline never
    // line up with a position's PnL: the orders were always there in the
    // API response, they just never survived normalization.
    timestamp: num(o.createdAt ?? o.createdTime ?? o.timestamp ?? o.time),
    status: o.status ?? null,
    reduceOnly: o.reduceOnly ?? null,
  };
}

/**
 * Confirmed against a real /account/{wallet}/trade/fills response (PopDEX
 * API docs, Sep 2026): the fee is NOT a top-level `fee`/`commission` field —
 * it's nested one level down in `feeDetail[0].fee`. Maker/taker isn't a
 * `liquidity`/`execType` field either — the real field is `tradeScope`,
 * with values "Maker"/"Taker" exactly. The fill id is `execId`, and the
 * timestamp is `createdAt` (ms). Getting any of these wrong silently
 * produces `fee: null` / `timestamp: null` for every fill, which is why
 * Maker/Taker was always rendering "Unavailable" — every fill got filtered
 * out by the `f.fee == null` / `f.timestamp != null` guards downstream in
 * fees.js before it ever reached computeMakerTakerFromFills.
 */
function normalizeFill(f) {
  if (!f) return null;
  const feeDetail = Array.isArray(f.feeDetail) ? f.feeDetail[0] : null;
  return {
    raw: f,
    fillId: f.execId ?? f.fillId ?? f.id ?? f.tradeId ?? null,
    orderId: f.orderId ?? null,
    side: (f.side ?? '').toString().toUpperCase() || null,
    price: num(f.execPrice ?? f.price ?? f.fillPrice),
    quantity: num(f.execQty ?? f.quantity ?? f.qty ?? f.fillQty),
    fee: num(feeDetail?.fee ?? f.fee ?? f.commission),
    timestamp: num(f.createdAt ?? f.timestamp ?? f.execTime ?? f.time),
    liquidity: f.tradeScope ?? f.liquidity ?? f.execType ?? null, // maker/taker
  };
}

/**
 * Confirmed against a real /account/{wallet}/history/funding-rate response:
 * the settlement timestamp field is `createdAt`, not `fundingRateTimestamp`
 * (that name belongs to the separate *market-level* funding-rate history
 * endpoint, a different endpoint this app doesn't call for wallet data).
 * Getting this wrong left every entry's timestamp as null, which meant
 * fetchAllAccountFunding's dedupe key collapsed to the same value for every
 * page and silently dropped almost the entire funding history down to one
 * record (see the dedupe-key fix in api.js alongside this).
 */
function normalizeFunding(entry) {
  if (!entry) return null;
  return {
    raw: entry,
    fundingRate: num(entry.fundingRate),
    timestamp: num(entry.createdAt ?? entry.fundingRateTimestamp ?? entry.timestamp),
    blockNumber: entry.blockNumber ?? entry.createdBlock ?? null,
    // Only present when PopDEX returns an actual wallet payment, not just a
    // market rate. Confirmed sign convention from the docs: positive =
    // received, negative = paid — matches computeFundingSplit in fees.js.
    paymentAmount: entry.fundingFee !== undefined ? num(entry.fundingFee)
      : entry.amount !== undefined ? num(entry.amount)
      : entry.payment !== undefined ? num(entry.payment)
      : null,
  };
}

function normalizeLiquidation(entry) {
  if (!entry) return null;
  return {
    raw: entry,
    timestamp: num(entry.timestamp ?? entry.liqTime),
    liquidationPrice: num(entry.liquidationPrice ?? entry.price),
    quantity: num(entry.quantity ?? entry.qty),
    side: (entry.side ?? '').toString().toUpperCase() || null,
  };
}

function normalizeCandle(row) {
  // [timestamp, open, high, low, close, baseVolume, quoteVolume]
  if (!Array.isArray(row) || row.length < 5) return null;
  return {
    time: Math.floor(Number(row[0]) / 1000), // lightweight-charts wants seconds
    timeMs: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    baseVolume: row[5] !== undefined ? Number(row[5]) : null,
    quoteVolume: row[6] !== undefined ? Number(row[6]) : null,
  };
}

/* =========================================================================
   CANDLESTICK TIMEFRAMES — §46
   Shared between the auto-picker (avoids truncated / missing candles on
   long trades) and the manual "Candles" dropdown on the replay screen.
   ========================================================================= */
const TIMEFRAME_ORDER = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const INTERVAL_MS = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

/**
 * Picks the replay's candle interval from the trade's total duration alone
 * — not from how many bars that would produce. Longer trades get coarser
 * candles so a multi-hour or multi-day replay doesn't turn into thousands
 * of barely-visible frames; shorter trades keep full 1-minute detail. The
 * old version instead picked the finest interval that stayed under a
 * 1000-bar cap, which is no longer the constraint it used to be now that
 * candle history is paged in fully (see fetchAllHistoricalCandles) — but
 * kept that logic, a 9+ hour trade would still land on 1-minute candles
 * purely because 1000 bars technically fit, which is why "Auto" was
 * rendering hundreds of frames worth of near-identical 1-minute detail
 * instead of a cleaner, faster-reading replay.
 *   \u2264 5h  \u2192 1m
 *   \u2264 24h \u2192 5m
 *   > 24h  \u2192 15m
 */
function pickAutoInterval(windowMs) {
  if (!windowMs || windowMs <= 0) return '1m';
  const hours = windowMs / INTERVAL_MS['1h'];
  if (hours <= 5) return '1m';
  if (hours <= 24) return '5m';
  return '15m';
}

/** Aggregates a finer candle series up into a coarser one (used for Demo Mode, where there's no server to re-query). */
function resampleCandles(candles, interval) {
  const bucketMs = INTERVAL_MS[interval];
  if (!bucketMs || !candles || !candles.length) return candles || [];
  const buckets = new Map();
  for (const c of candles) {
    const bucketStart = Math.floor(c.timeMs / bucketMs) * bucketMs;
    let b = buckets.get(bucketStart);
    if (!b) {
      b = { timeMs: bucketStart, time: Math.floor(bucketStart / 1000), open: c.open, high: c.high, low: c.low, close: c.close, baseVolume: 0, quoteVolume: 0 };
      buckets.set(bucketStart, b);
    }
    b.high = Math.max(b.high, c.high);
    b.low = Math.min(b.low, c.low);
    b.close = c.close;
    b.baseVolume += c.baseVolume || 0;
    b.quoteVolume += c.quoteVolume || 0;
  }
  return Array.from(buckets.values()).sort((a, b) => a.timeMs - b.timeMs);
}

/* =========================================================================
   TRADE BUILDER — assembles one replayable "trade" from a closed position
   plus everything else loaded for it. Optional pieces may be null; that
   never blocks the replay from starting (per spec §25).
   ========================================================================= */
function buildTrade(position, { orders = [], fills = [], funding = [], liquidations = [] } = {}) {
  if (!position) return null;
  const tradeId = position.positionId ?? `${position.symbol}-${position.openTimestamp}`;

  const relevantOrders = orders.filter((o) => o.timestamp != null
    && withinWindow(o.timestamp, position.openTimestamp, position.closeTimestamp));
  const relevantFills = fills.filter((f) => f.timestamp != null
    && withinWindow(f.timestamp, position.openTimestamp, position.closeTimestamp));
  const relevantFunding = funding.filter((f) => f.timestamp != null
    && withinWindow(f.timestamp, position.openTimestamp, position.closeTimestamp));
  const relevantLiqs = liquidations.filter((l) => l.timestamp != null
    && withinWindow(l.timestamp, position.openTimestamp, position.closeTimestamp));

  return {
    id: tradeId,
    position,
    orders: relevantOrders,
    fills: relevantFills,
    funding: relevantFunding,
    liquidations: relevantLiqs,
  };
}

function withinWindow(ts, start, end) {
  if (start == null) return true;
  const lo = start;
  const hi = end ?? Infinity;
  return ts >= lo - 1000 && ts <= hi + 1000; // 1s slack for boundary events
}

/* =========================================================================
   EVENT TIMELINE
   ========================================================================= */
function buildTimeline(trade) {
  const events = [];
  const p = trade.position;

  if (p.openTimestamp != null) {
    events.push({ type: 'Position opened', timestamp: p.openTimestamp, data: { side: p.side, entryPrice: p.entryPrice } });
  }

  for (const o of trade.orders) {
    if (o.timestamp != null) {
      // Real API returns PascalCase status strings ("Filled",
      // "PartiallyFilled", "New", "Cancelled", "Rejected"...) — checking
      // against the literal 'FILLED' (all caps) never matched a real
      // value, so every order rendered as "Order created" even when it
      // was fully filled.
      const isFilled = (o.status ?? '').toString().toLowerCase() === 'filled';
      events.push({ type: isFilled ? 'Order filled' : 'Order created', timestamp: o.timestamp, data: o });
    }
  }

  let runningQty = 0;
  for (const f of trade.fills) {
    if (f.timestamp == null) continue;
    const isPartial = trade.fills.filter((x) => x.orderId === f.orderId).length > 1;
    events.push({ type: isPartial ? 'Partial fill' : (f.side === p.side ? 'Position increased' : 'Position reduced'), timestamp: f.timestamp, data: f });
  }

  for (const fu of trade.funding) {
    if (fu.timestamp != null) events.push({ type: 'Funding', timestamp: fu.timestamp, data: fu });
  }

  for (const l of trade.liquidations) {
    if (l.timestamp != null) events.push({ type: 'Liquidation', timestamp: l.timestamp, data: l });
  }

  if (p.closeTimestamp != null) {
    events.push({ type: 'Position closed', timestamp: p.closeTimestamp, data: { exitPrice: p.exitPrice } });
  }

  events.sort((a, b) => a.timestamp - b.timestamp);
  return events;
}

/* =========================================================================
   CALCULATIONS — §37–41
   ========================================================================= */

/** Unrealized/point-in-time PnL for LONG/SHORT given a size and current price. */
function calculatePnL({ side, entryPrice, currentPrice, size }) {
  if (entryPrice == null || currentPrice == null || size == null) return UNAVAILABLE;
  const diff = side === 'SHORT' ? (entryPrice - currentPrice) : (currentPrice - entryPrice);
  return tag(diff * size, SRC.CALC);
}

function calculateFees(trade) {
  // Prefer authoritative position-level fee if present.
  if (trade.position.fees != null) return tag(trade.position.fees, SRC.API);
  const fills = trade.fills.filter((f) => f.fee != null);
  if (!fills.length) return UNAVAILABLE;
  return tag(fills.reduce((s, f) => s + f.fee, 0), SRC.CALC);
}

function calculateFunding(trade) {
  if (trade.position.funding != null) return tag(trade.position.funding, SRC.API);
  const withPayments = trade.funding.filter((f) => f.paymentAmount != null);
  if (!withPayments.length) return UNAVAILABLE;
  return tag(withPayments.reduce((s, f) => s + f.paymentAmount, 0), SRC.CALC);
}

function calculateNetPnl(grossPnl, fees, funding) {
  if (grossPnl.src === SRC.NONE) return UNAVAILABLE;
  const feeVal = fees.src === SRC.NONE ? 0 : fees.value;
  const fundVal = funding.src === SRC.NONE ? 0 : funding.value;
  const anyCalc = [grossPnl, fees, funding].some((t) => t.src === SRC.CALC);
  return tag(grossPnl.value - Math.abs(feeVal) + fundVal, anyCalc ? SRC.CALC : SRC.API);
}

function calculateLiquidationDistance(currentPrice, liquidationPrice) {
  if (currentPrice == null || liquidationPrice == null) return UNAVAILABLE;
  const pct = Math.abs(currentPrice - liquidationPrice) / currentPrice * 100;
  return tag(pct, SRC.CALC);
}

/** Maximum favorable / adverse excursion across the candle path from entry to a given point. */
function calculateExcursions({ side, entryPrice, size }, candles) {
  if (!candles.length || entryPrice == null || size == null) return { mfe: UNAVAILABLE, mae: UNAVAILABLE, maxDrawdown: UNAVAILABLE };
  let bestPrice = entryPrice;
  let worstPrice = entryPrice;
  for (const c of candles) {
    if (side === 'SHORT') {
      bestPrice = Math.min(bestPrice, c.low);
      worstPrice = Math.max(worstPrice, c.high);
    } else {
      bestPrice = Math.max(bestPrice, c.high);
      worstPrice = Math.min(worstPrice, c.low);
    }
  }
  const mfe = calculatePnL({ side, entryPrice, currentPrice: bestPrice, size });
  const mae = calculatePnL({ side, entryPrice, currentPrice: worstPrice, size });
  const maxDrawdown = mae.src === SRC.NONE ? UNAVAILABLE : tag(Math.abs(mae.value), SRC.CALC);
  return { mfe, mae, maxDrawdown };
}

function calculateTradeAnalytics(trade, candlesUpToExit) {
  const p = trade.position;
  const grossPnl = p.realizedPnl != null
    ? tag(p.realizedPnl, SRC.API)
    : calculatePnL({ side: p.side, entryPrice: p.entryPrice, currentPrice: p.exitPrice, size: p.size });
  const fees = calculateFees(trade);
  const funding = calculateFunding(trade);
  const netPnl = calculateNetPnl(grossPnl, fees, funding);
  const { mfe, mae, maxDrawdown } = calculateExcursions(p, candlesUpToExit);
  const duration = (p.openTimestamp != null && p.closeTimestamp != null)
    ? tag(p.closeTimestamp - p.openTimestamp, SRC.CALC)
    : UNAVAILABLE;
  const liqDistances = candlesUpToExit
    .map((c) => calculateLiquidationDistance(c.close, p.liquidationPrice))
    .filter((d) => d.src !== SRC.NONE)
    .map((d) => d.value);
  const minLiqDistance = liqDistances.length ? tag(Math.min(...liqDistances), SRC.CALC) : UNAVAILABLE;

  return {
    entryPrice: p.entryPrice != null ? tag(p.entryPrice) : UNAVAILABLE,
    exitPrice: p.exitPrice != null ? tag(p.exitPrice) : UNAVAILABLE,
    grossPnl, fees, funding, netPnl,
    duration,
    mfe, mae, maxDrawdown,
    bestUnrealized: mfe,
    worstUnrealized: mae,
    numOrders: tag(trade.orders.length, SRC.CALC),
    numFills: tag(trade.fills.length, SRC.CALC),
    minLiquidationDistance: minLiqDistance,
  };
}

/* =========================================================================
   LEARNING INSIGHTS — §42, generated only from real computed values
   ========================================================================= */
function generateInsights(analytics, trade) {
  const insights = [];
  const p = trade.position;

  if (analytics.mfe.src !== SRC.NONE && p.entryPrice) {
    const pct = (analytics.mfe.value / (p.entryPrice * p.size)) * 100;
    if (isFinite(pct)) insights.push(`Price moved ${Math.abs(pct).toFixed(1)}% in your favor at its best point before exit.`);
  }
  if (analytics.maxDrawdown.src !== SRC.NONE && p.entryPrice) {
    const pct = (analytics.maxDrawdown.value / (p.entryPrice * p.size)) * 100;
    if (isFinite(pct)) insights.push(`Maximum drawdown during the trade was ${Math.abs(pct).toFixed(1)}%.`);
  }
  if (analytics.fees.src !== SRC.NONE && analytics.grossPnl.src !== SRC.NONE && analytics.grossPnl.value !== 0) {
    const pct = (Math.abs(analytics.fees.value) / Math.abs(analytics.grossPnl.value)) * 100;
    if (isFinite(pct)) insights.push(`Fees reduced gross PnL by ${pct.toFixed(1)}%.`);
  }
  if (analytics.minLiquidationDistance.src !== SRC.NONE) {
    insights.push(`Closest liquidation distance during the trade was ${analytics.minLiquidationDistance.value.toFixed(1)}%.`);
  }
  if (analytics.duration.src !== SRC.NONE) {
    insights.push(`Trade duration was ${formatDuration(analytics.duration.value)}.`);
  }
  if (analytics.funding.src !== SRC.NONE && analytics.funding.value !== 0) {
    insights.push(`Funding contributed ${analytics.funding.value >= 0 ? '+' : ''}${analytics.funding.value.toFixed(2)} to net PnL.`);
  }
  return insights;
}

function formatDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin} minute${totalMin === 1 ? '' : 's'}`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const days = Math.floor(h / 24);
  if (days > 0) return `${days}d ${h % 24}h`;
  return `${h}h ${m}m`;
}

/* =========================================================================
   CENTRALIZED REPLAY STATE — §26
   A single object; every UI component reads from it. No independent timers.
   ========================================================================= */
class ReplayState {
  constructor() {
    this.listeners = new Set();
    this.reset();
  }

  reset() {
    Object.assign(this, {
      trade: null,
      candles: [],       // full candle path for the trade window
      timeline: [],
      isPlaying: false,
      currentTimestamp: null,
      replaySpeed: 5,
      startTimestamp: null,
      endTimestamp: null,
      currentPrice: null,
      entryPrice: null,
      exitPrice: null,
      currentPnl: UNAVAILABLE,
      currentFunding: UNAVAILABLE,
      currentFees: UNAVAILABLE,
      liquidationPrice: null,
      liquidationDistance: UNAVAILABLE,
      visibleOrders: [],
      visibleExecutions: [],
      visibleEvents: [],
      finished: false,
    });
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.listeners.forEach((fn) => fn(this)); }

  load(trade, candles, timeline) {
    this.reset();
    this.trade = trade;
    this.candles = candles;
    this.timeline = timeline;
    this.startTimestamp = trade.position.openTimestamp ?? (candles[0] && candles[0].timeMs) ?? null;
    this.endTimestamp = trade.position.closeTimestamp ?? (candles[candles.length - 1] && candles[candles.length - 1].timeMs) ?? null;
    this.currentTimestamp = this.startTimestamp;
    this.entryPrice = trade.position.entryPrice;
    this.exitPrice = trade.position.exitPrice;
    this.liquidationPrice = trade.position.liquidationPrice;
    this.recompute();
  }

  seekTo(ts) {
    if (this.startTimestamp == null) return;
    this.currentTimestamp = Math.min(Math.max(ts, this.startTimestamp), this.endTimestamp ?? ts);
    this.finished = this.endTimestamp != null && this.currentTimestamp >= this.endTimestamp;
    if (this.finished) this.isPlaying = false;
    this.recompute();
  }

  step(deltaMs) {
    this.seekTo(this.currentTimestamp + deltaMs);
  }

  setSpeed(x) { this.replaySpeed = x; this.emit(); }

  play() { if (!this.finished) { this.isPlaying = true; this.emit(); } }
  pause() { this.isPlaying = false; this.emit(); }
  restart() { this.seekTo(this.startTimestamp); this.isPlaying = false; }

  recompute() {
    const t = this.trade;
    const p = t.position;
    const ts = this.currentTimestamp;

    const visibleCandles = this.candles.filter((c) => c.timeMs <= ts);
    const lastCandle = visibleCandles[visibleCandles.length - 1];

    // Once the replay has actually reached the trade's real close time, stop
    // approximating from candle data and snap to the exchange's own recorded
    // numbers — otherwise the final numbers here (a candle-close-based
    // estimate) don't quite match the authoritative totals shown on the
    // trade list, even though both are describing the same finished trade.
    const isSettled = p.closeTimestamp != null && ts >= p.closeTimestamp;

    this.currentPrice = isSettled ? (p.exitPrice ?? (lastCandle ? lastCandle.close : this.entryPrice))
      : (lastCandle ? lastCandle.close : this.entryPrice);

    this.visibleOrders = t.orders.filter((o) => o.timestamp <= ts);
    this.visibleExecutions = t.fills.filter((f) => f.timestamp <= ts);
    this.visibleEvents = this.timeline.filter((e) => e.timestamp <= ts);

    if (isSettled && p.realizedPnl != null) {
      this.currentPnl = tag(p.realizedPnl, SRC.API);
    } else {
      const sizeAtPoint = this._sizeAtTimestamp(ts);
      this.currentPnl = calculatePnL({ side: p.side, entryPrice: p.entryPrice, currentPrice: this.currentPrice, size: sizeAtPoint });
    }
    this.currentFees = calculateFees({ position: p, fills: this.visibleExecutions });
    // Prefer the authoritative position-level funding total (same source the
    // trade list uses) once it's known; only fall back to summing individual
    // funding events for the still-in-progress, mid-replay view.
    this.currentFunding = isSettled
      ? calculateFunding({ position: p, funding: t.funding.filter((f) => f.timestamp <= ts) })
      : calculateFunding({ position: { funding: null }, funding: t.funding.filter((f) => f.timestamp <= ts) });
    this.liquidationDistance = calculateLiquidationDistance(this.currentPrice, this.liquidationPrice);

    this.emit();
  }

  _sizeAtTimestamp(ts) {
    // Sum signed fill quantities up to ts; fall back to full position size if no fills known yet.
    const fillsSoFar = this.trade.fills.filter((f) => f.timestamp <= ts && f.quantity != null);
    if (!fillsSoFar.length) return this.trade.position.size;
    const signed = fillsSoFar.reduce((s, f) => s + (f.side === this.trade.position.side ? f.quantity : -f.quantity), 0);
    return signed || this.trade.position.size;
  }
}

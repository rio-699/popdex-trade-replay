/* =========================================================================
   FEE ANALYTICS — trading-cost + rewards dashboard for the wallet already
   loaded by App (see app.js searchWallet). Reuses App.trades (already
   fetched via PopDexApi.fetchAllHistoricalPositions) as its primary,
   always-available data source, and lazily fetches full-history fills and
   funding events in the background for the two figures that need
   execution-level detail (Maker/Taker split, Funding Paid/Received).
   Nothing here invents a number — every card either shows a value sourced
   from PopDEX data (or calculated from it) or an explicit "Unavailable",
   matching the SRC/tag convention used by core.js.
   ========================================================================= */

/* =========================================================================
   REWARDS / AIRDROPS — §6, §7

   RESOLVED: PopDEX has no *dedicated* airdrop/rewards/points endpoint —
   that part of the original investigation was correct, and is still true.
   But team distributions turn out to be identifiable anyway: they arrive
   as ordinary `TransferIn` entries on the ALREADY-DOCUMENTED wallet-activity
   feed (GET /account/{wallet}/history/funds-transfer — see
   PopDexApi.fetchAllAccountFundsTransfer), sent from a small, fixed set of
   team-controlled wallets. Confirmed directly against a live response for
   this build's own test wallet: two `TransferIn` records (+200 USDT,
   +50 USDT) both from the same sender address, which does not match any
   deposit/vault/trading counterparty address seen elsewhere in that
   wallet's history — i.e. an external, one-directional, team-to-user
   transfer, not a peer transfer or a vault flow.

   TEAM_REWARD_SENDERS is that allowlist. It is a real limitation, not a
   general "any TransferIn is a reward" rule — PopDEX's own transfer-in
   history includes ordinary peer-to-peer sends too, which must NOT be
   counted as rewards. If the team ever distributes from a different
   wallet, this array needs that address added; nothing else in this file
   needs to change.
   ========================================================================= */
const TEAM_REWARD_SENDERS = new Set([
  '0x2a3adf5c8d93def10fc85b1609ef442f7f665126',
]);

/** Tokens treated as 1:1 USD without an exchange-rate lookup. */
const USD_STABLE_TOKENS = new Set(['USDT', 'USDC', 'USD', 'DAI']);

const RewardsData = {
  /**
   * @param {string} walletId
   * @returns {Promise<{items: Array<{wallet:string, type:string, amount:number, token:string, usdValue:number|null, timestamp:number, source:string, txHash:string, status:string}>, src: string, reason?: string}>}
   */
  async fetchForWallet(walletId) {
    const raw = await softLoad(() => PopDexApi.fetchAllAccountFundsTransfer(walletId, {}));
    if (!Array.isArray(raw)) {
      return {
        items: [],
        src: SRC.NONE,
        reason: 'Could not load this wallet\u2019s transfer history from PopDEX, so rewards can\u2019t be checked right now.',
      };
    }

    const matches = raw.filter((r) => {
      const type = (r.transactionType ?? r.type ?? '').toString();
      const from = (r.fromAddress ?? '').toString().toLowerCase();
      return type === 'TransferIn' && TEAM_REWARD_SENDERS.has(from);
    });

    if (!matches.length) {
      return {
        items: [],
        src: SRC.NONE,
        reason: 'No transfers from a known PopDEX team distribution wallet were found for this wallet.',
      };
    }

    // usdValue: stablecoin rewards (the only kind seen so far) are 1:1 by
    // definition. For anything else, best-effort a live exchange rate
    // rather than assume 1:1 for an arbitrary token — and if that lookup
    // fails, report the item with usdValue: null (excluded from the USD
    // total, but still visible) instead of silently mis-pricing it.
    const uniqueTokens = [...new Set(matches.map((r) => r.token).filter((t) => t && !USD_STABLE_TOKENS.has(t)))];
    const rateByToken = new Map();
    if (uniqueTokens.length) {
      await Promise.all(uniqueTokens.map(async (token) => {
        const res = await softLoad(() => PopDexApi.fetchExchangeRates({ token, quoteToken: 'USD' }));
        const list = Array.isArray(res) ? res : [];
        const rate = num(list.find((r) => r.token === token)?.rate);
        if (rate != null) rateByToken.set(token, rate);
      }));
    }

    const items = matches.map((r) => {
      const amount = num(r.amount);
      const token = r.token ?? null;
      const rate = token && USD_STABLE_TOKENS.has(token) ? 1 : (token ? rateByToken.get(token) : null);
      return {
        wallet: walletId,
        type: r.transactionTypeDisplay ?? r.transactionType ?? 'Transfer In',
        amount,
        token,
        usdValue: (amount != null && rate != null) ? amount * rate : null,
        timestamp: num(r.createdAt),
        source: 'PopDEX team wallet',
        txHash: r.txHash ?? null,
        status: r.status ?? null,
      };
    });

    return { items, src: SRC.API };
  },
};

/* =========================================================================
   AGGREGATION HELPERS — pure functions over already-normalized trades /
   fills / funding events (see core.js normalizers). No fabrication: every
   helper either returns a real sum or SRC.NONE when it has nothing to sum.
   ========================================================================= */
function rangeWindowMs(rangeKey) {
  const now = Date.now();
  if (rangeKey === '30d') {
    return { start: now - 30 * 86_400_000, end: now, prevStart: now - 60 * 86_400_000, prevEnd: now - 30 * 86_400_000 };
  }
  if (rangeKey === '90d') {
    return { start: now - 90 * 86_400_000, end: now, prevStart: now - 180 * 86_400_000, prevEnd: now - 90 * 86_400_000 };
  }
  return { start: null, end: now, prevStart: null, prevEnd: null };
}

function tradesInWindow(trades, start, end) {
  return trades.filter((t) => {
    const ts = t.position.closeTimestamp;
    if (ts == null) return false;
    if (start != null && ts < start) return false;
    if (end != null && ts > end) return false;
    return true;
  });
}

function sumFeesTag(trades) {
  const vals = trades.map((t) => t.position.fees).filter((v) => v != null);
  if (!vals.length) return UNAVAILABLE;
  return tag(vals.reduce((s, v) => s + Math.abs(v), 0), SRC.API);
}

function sumFundingTag(trades) {
  const vals = trades.map((t) => t.position.funding).filter((v) => v != null);
  if (!vals.length) return UNAVAILABLE;
  return tag(vals.reduce((s, v) => s + v, 0), SRC.API);
}

/**
 * Maker/Taker split from real fill records. Only trusts fills that actually
 * carry a `liquidity` flag (see normalizeFill) — if PopDEX never reports
 * one for this wallet's fills, returns null rather than guessing a split.
 * Returns counts alongside dollar amounts so a $0.00 maker total is
 * distinguishable from "no maker fills at all" (e.g. this VIP tier's maker
 * fee rate can legitimately be 0.0000%, in which case every maker fill
 * still shows up in makerCount, just contributing $0 to makerFees).
 */
function computeMakerTakerFromFills(fills) {
  let maker = 0;
  let taker = 0;
  let makerCount = 0;
  let takerCount = 0;
  let sawFlag = false;
  for (const f of fills) {
    if (f.fee == null || !f.liquidity) continue;
    const flag = String(f.liquidity).toLowerCase();
    if (flag.includes('maker')) { maker += Math.abs(f.fee); makerCount += 1; sawFlag = true; }
    else if (flag.includes('taker')) { taker += Math.abs(f.fee); takerCount += 1; sawFlag = true; }
  }
  if (!sawFlag) return null;
  return { maker, taker, makerCount, takerCount };
}

/** Paid/Received split from real funding-payment events (signed: negative = paid, positive = received). */
function computeFundingSplit(events) {
  let paid = 0;
  let received = 0;
  let saw = false;
  for (const f of events) {
    if (f.paymentAmount == null) continue;
    saw = true;
    if (f.paymentAmount < 0) paid += Math.abs(f.paymentAmount);
    else if (f.paymentAmount > 0) received += f.paymentAmount;
  }
  if (!saw) return null;
  return { paid, received };
}

/* =========================================================================
   FEE ANALYTICS — rendering + lazy background loads
   ========================================================================= */
const FeeAnalytics = {
  wallet: null,
  app: null,
  range: 'all',            // 'all' | '90d' | '30d'
  trendBucket: 'weekly',   // 'daily' | 'weekly' | 'monthly'
  detailedFills: null,     // null (not started) | 'loading' | 'error' | Array<normalizedFill>
  detailedFunding: null,   // null | 'loading' | 'error' | Array<normalizedFunding>
  rewards: null,           // null | 'loading' | {items, src, reason}
  chart: null,
  _trendSeries: null,
  _trendBucketMap: null,
  _bound: false,

  /** Called from App.changeWallet() — wipes everything back to first-load state. */
  reset() {
    this.wallet = null;
    this.app = null;
    this.range = 'all';
    this.trendBucket = 'weekly';
    this.detailedFills = null;
    this.detailedFunding = null;
    this.rewards = null;
    if (this.chart) { this.chart.remove(); this.chart = null; this._trendSeries = null; }
    $$('#fa-range-controls .filter-chip').forEach((b) => b.classList.toggle('is-active', b.dataset.range === 'all'));
    $$('#fa-trend-controls .filter-chip').forEach((b) => b.classList.toggle('is-active', b.dataset.trend === 'weekly'));
  },

  bindOnce() {
    if (this._bound) return;
    this._bound = true;
    $$('#fa-range-controls .filter-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('#fa-range-controls .filter-chip').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        this.range = btn.dataset.range;
        this.renderTotalFees();
        this.renderMakerTaker();
        this.renderFunding();
        this.renderTrend();
      });
    });
    $$('#fa-trend-controls .filter-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('#fa-trend-controls .filter-chip').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        this.trendBucket = btn.dataset.trend;
        this.renderTrend();
      });
    });
  },

  /** Entry point — called every time the Fee Analytics tab becomes active (§ setActiveTab in app.js). */
  render(app) {
    this.bindOnce();
    this.app = app;

    if (this.wallet !== app.wallet) {
      // A different wallet than the one we last loaded detailed data for —
      // drop the stale background-fetch results so we don't show one
      // wallet's maker/taker split under another wallet's total.
      this.detailedFills = null;
      this.detailedFunding = null;
      this.rewards = null;
      this.wallet = app.wallet;
    }

    const hasTrades = app.trades && app.trades.length > 0;
    $('#fa-empty').hidden = hasTrades;
    $('#fa-content').hidden = !hasTrades;
    if (!hasTrades) return;

    this.renderTotalFees();
    this.renderMakerTaker();
    this.renderFunding();
    this.renderTrend();
    this.renderRewards();

    this.ensureRewardsLoaded();
    this.ensureDetailedDataLoaded();
  },

  /* ---- Total Fees Paid ---- */
  renderTotalFees() {
    const win = rangeWindowMs(this.range);
    const current = tradesInWindow(this.app.trades, win.start, win.end);
    const totalTag = sumFeesTag(current);

    const valueEl = $('#fa-total-fees');
    valueEl.textContent = totalTag.src === SRC.NONE ? 'Unavailable' : formatCurrency(totalTag.value);
    valueEl.classList.toggle('unavailable', totalTag.src === SRC.NONE);

    const rangeLabel = this.range === 'all' ? 'All time' : this.range === '90d' ? 'Last 90 days' : 'Last 30 days';
    $('#fa-total-fees-range').textContent = `${rangeLabel}${current.length ? ` \u00b7 ${current.length} trade${current.length === 1 ? '' : 's'}` : ''}`;

    const deltaEl = $('#fa-total-fees-delta');
    if (win.prevStart == null || totalTag.src === SRC.NONE) {
      deltaEl.hidden = true;
      return;
    }
    const prevTag = sumFeesTag(tradesInWindow(this.app.trades, win.prevStart, win.prevEnd));
    if (prevTag.src === SRC.NONE || prevTag.value === 0) {
      deltaEl.hidden = true;
      return;
    }
    const pct = ((totalTag.value - prevTag.value) / prevTag.value) * 100;
    deltaEl.hidden = false;
    // Fees are a cost: paying MORE than the previous period is the "bad"
    // direction (red), paying less is "good" (green) — opposite of the
    // usual PnL-style coloring elsewhere in the app.
    deltaEl.className = `fa-hero__delta ${pct >= 0 ? 'negative' : 'positive'}`;
    deltaEl.textContent = `${pct >= 0 ? '\u2191' : '\u2193'} ${Math.abs(pct).toFixed(1)}% vs previous period`;
  },

  /* ---- Maker vs Taker ---- */
  renderMakerTaker() {
    const noteEl = $('#fa-split-note');
    const barEl = $('#fa-split-bar');

    if (this.detailedFills === null || this.detailedFills === 'loading') {
      $('#fa-maker-value').textContent = '\u2014';
      $('#fa-taker-value').textContent = '\u2014';
      $('#fa-maker-pct').textContent = '';
      $('#fa-taker-pct').textContent = '';
      barEl.hidden = true;
      noteEl.textContent = 'Calculating maker/taker split from trade executions\u2026';
      return;
    }
    if (this.detailedFills === 'error') {
      $('#fa-maker-value').textContent = 'Unavailable';
      $('#fa-taker-value').textContent = 'Unavailable';
      barEl.hidden = true;
      noteEl.textContent = 'Could not load execution-level fee data for this wallet.';
      return;
    }

    const win = rangeWindowMs(this.range);
    const inRange = this.detailedFills.filter((f) => f.timestamp != null && (win.start == null || f.timestamp >= win.start) && f.timestamp <= win.end);
    const split = computeMakerTakerFromFills(inRange);

    if (!split) {
      $('#fa-maker-value').textContent = 'Unavailable';
      $('#fa-taker-value').textContent = 'Unavailable';
      barEl.hidden = true;
      noteEl.textContent = 'PopDEX doesn\u2019t report a maker/taker flag on this wallet\u2019s executions, so this split can\u2019t be shown.';
      return;
    }

    const total = split.maker + split.taker;
    $('#fa-maker-value').textContent = formatCurrency(split.maker);
    $('#fa-taker-value').textContent = formatCurrency(split.taker);
    // Fill counts alongside the % — makes a $0.00 maker total legible as
    // either "0 maker fills happened" or "N maker fills happened, all at a
    // 0% maker rate for this VIP tier" instead of just looking broken.
    $('#fa-maker-pct').textContent = total
      ? `${((split.maker / total) * 100).toFixed(1)}% \u00b7 ${split.makerCount} fill${split.makerCount === 1 ? '' : 's'}`
      : `${split.makerCount} fill${split.makerCount === 1 ? '' : 's'}`;
    $('#fa-taker-pct').textContent = total
      ? `${((split.taker / total) * 100).toFixed(1)}% \u00b7 ${split.takerCount} fill${split.takerCount === 1 ? '' : 's'}`
      : `${split.takerCount} fill${split.takerCount === 1 ? '' : 's'}`;
    barEl.hidden = false;
    $('#fa-split-bar-maker').style.width = total ? `${(split.maker / total) * 100}%` : '0%';
    $('#fa-split-bar-taker').style.width = total ? `${(split.taker / total) * 100}%` : '0%';
    noteEl.textContent = 'Calculated from this wallet\u2019s individual trade executions.';
  },

  /* ---- Funding Fees ---- */
  renderFunding() {
    const win = rangeWindowMs(this.range);
    const current = tradesInWindow(this.app.trades, win.start, win.end);
    const netTag = sumFundingTag(current);

    const netEl = $('#fa-funding-net');
    netEl.textContent = netTag.src === SRC.NONE ? 'Unavailable' : formatSignedCurrency(netTag.value);
    netEl.className = `fa-funding-row__value ${netTag.src === SRC.NONE ? '' : netTag.value > 0 ? 'positive' : netTag.value < 0 ? 'negative' : ''}`;

    const paidEl = $('#fa-funding-paid');
    const receivedEl = $('#fa-funding-received');
    const noteEl = $('#fa-funding-note');

    if (this.detailedFunding === null || this.detailedFunding === 'loading') {
      paidEl.textContent = '\u2014';
      receivedEl.textContent = '\u2014';
      paidEl.className = 'fa-funding-row__value';
      receivedEl.className = 'fa-funding-row__value';
      noteEl.textContent = 'Calculating the funding paid/received breakdown\u2026';
      return;
    }
    if (this.detailedFunding === 'error') {
      paidEl.textContent = 'Unavailable';
      receivedEl.textContent = 'Unavailable';
      paidEl.className = 'fa-funding-row__value';
      receivedEl.className = 'fa-funding-row__value';
      noteEl.textContent = 'Could not load event-level funding history for this wallet \u2014 Net Funding above is still accurate.';
      return;
    }

    const inRange = this.detailedFunding.filter((f) => f.timestamp != null && (win.start == null || f.timestamp >= win.start) && f.timestamp <= win.end);
    const split = computeFundingSplit(inRange);

    if (!split) {
      paidEl.textContent = formatCurrency(0);
      receivedEl.textContent = formatCurrency(0);
      paidEl.className = 'fa-funding-row__value';
      receivedEl.className = 'fa-funding-row__value';
      noteEl.textContent = '';
      return;
    }

    paidEl.textContent = formatCurrency(split.paid);
    paidEl.className = 'fa-funding-row__value negative';
    receivedEl.textContent = formatCurrency(split.received);
    receivedEl.className = 'fa-funding-row__value positive';
    noteEl.textContent = '';
  },

  /* ---- Fee Trend ---- */
  buildTrendBuckets(trades, win) {
    const bucketMs = this.trendBucket === 'daily' ? 86_400_000 : this.trendBucket === 'monthly' ? 30 * 86_400_000 : 7 * 86_400_000;
    const map = new Map();
    const useDetailed = Array.isArray(this.detailedFills) && Array.isArray(this.detailedFunding);
    const inRange = (ts) => ts != null && (win.start == null || ts >= win.start) && ts <= win.end;

    const bucketFor = (key) => {
      let b = map.get(key);
      if (!b) { b = { time: key / 1000, trading: 0, funding: 0 }; map.set(key, b); }
      return b;
    };

    if (useDetailed) {
      for (const f of this.detailedFills) {
        if (!inRange(f.timestamp) || f.fee == null) continue;
        bucketFor(Math.floor(f.timestamp / bucketMs) * bucketMs).trading += Math.abs(f.fee);
      }
      for (const fu of this.detailedFunding) {
        if (!inRange(fu.timestamp) || fu.paymentAmount == null) continue;
        bucketFor(Math.floor(fu.timestamp / bucketMs) * bucketMs).funding += fu.paymentAmount;
      }
    } else {
      for (const t of trades) {
        const ts = t.position.closeTimestamp;
        if (!inRange(ts)) continue;
        const b = bucketFor(Math.floor(ts / bucketMs) * bucketMs);
        if (t.position.fees != null) b.trading += Math.abs(t.position.fees);
        if (t.position.funding != null) b.funding += t.position.funding;
      }
    }

    return Array.from(map.values())
      .map((b) => ({ ...b, total: b.trading - b.funding }))
      .sort((a, b) => a.time - b.time);
  },

  renderTrend() {
    const container = $('#fa-trend-chart');
    const win = rangeWindowMs(this.range);
    const current = tradesInWindow(this.app.trades, win.start, win.end);
    const buckets = this.buildTrendBuckets(current, win);

    const hasEnough = buckets.length >= 2;
    $('#fa-trend-empty').hidden = hasEnough;
    container.hidden = !hasEnough;
    $('#fa-trend-tooltip').hidden = true;
    if (!hasEnough) {
      if (this.chart) { this.chart.remove(); this.chart = null; this._trendSeries = null; }
      return;
    }

    if (!this.chart) {
      this.chart = LightweightCharts.createChart(container, {
        layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#9aa4b2', fontFamily: 'Arial, sans-serif' },
        grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
        timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: false },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        autoSize: true,
      });
      this._trendSeries = this.chart.addHistogramSeries({ priceFormat: { type: 'price', precision: 2, minMove: 0.01 } });
      this.chart.subscribeCrosshairMove((param) => this.handleTrendHover(param));
    }

    this._trendBucketMap = new Map(buckets.map((b) => [b.time, b]));
    this._trendSeries.setData(buckets.map((b) => ({ time: b.time, value: b.total, color: b.total >= 0 ? '#4c9be8' : '#ff4d5e' })));
    this.chart.timeScale().fitContent();
  },

  handleTrendHover(param) {
    const tooltip = $('#fa-trend-tooltip');
    const wrap = $('.fa-trend-chart-wrap');
    if (!param || param.time == null || !this._trendBucketMap || !param.point) { tooltip.hidden = true; return; }
    const b = this._trendBucketMap.get(param.time);
    if (!b) { tooltip.hidden = true; return; }

    const rect = wrap.getBoundingClientRect();
    const left = Math.min(Math.max(param.point.x - 90, 4), Math.max(rect.width - 190, 4));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = '8px';
    tooltip.innerHTML = `
      <div class="fa-trend-tooltip__date">${formatDate(b.time * 1000)}</div>
      <div class="fa-trend-tooltip__row"><span>Trading fees</span><span>${formatCurrency(b.trading)}</span></div>
      <div class="fa-trend-tooltip__row"><span>Funding fees</span><span>${formatSignedCurrency(b.funding)}</span></div>
      <div class="fa-trend-tooltip__row"><span>Total fees</span><span>${formatSignedCurrency(b.total)}</span></div>
    `;
    tooltip.hidden = false;
  },

  /* ---- Fees vs Rewards ---- */
  renderRewards() {
    // Rewards are shown all-time regardless of the Total Fees date-range
    // filter above — airdrops/rewards aren't naturally bucketed into the
    // same trading-activity windows a fee range picker implies.
    const feesTag = sumFeesTag(this.app.trades);
    const feesTotal = feesTag.src === SRC.NONE ? 0 : feesTag.value;
    $('#fa-rewards-fees').textContent = formatCurrency(feesTotal);

    const receivedEl = $('#fa-rewards-received');
    const netEl = $('#fa-rewards-net');
    const badgeEl = $('#fa-rewards-badge');
    const ratioEl = $('#fa-rewards-ratio');
    const noteEl = $('#fa-rewards-note');

    if (this.rewards === null || this.rewards === 'loading') {
      receivedEl.textContent = '\u2014';
      netEl.textContent = '\u2014';
      netEl.className = 'fa-rewards__net';
      badgeEl.textContent = 'Checking for rewards\u2026';
      badgeEl.className = 'fa-rewards__badge fa-rewards__badge--neutral';
      ratioEl.textContent = '';
      noteEl.textContent = '';
      return;
    }

    const rewardsTotal = (this.rewards.items || []).reduce((s, r) => s + (Number(r.usdValue) || 0), 0);
    receivedEl.textContent = formatCurrency(rewardsTotal);

    const net = rewardsTotal - feesTotal;
    netEl.textContent = formatSignedCurrency(net);
    netEl.className = `fa-rewards__net ${net > 0 ? 'positive' : net < 0 ? 'negative' : ''}`;

    if (net > 0) {
      badgeEl.textContent = 'Rewards > Fees \u2713';
      badgeEl.className = 'fa-rewards__badge fa-rewards__badge--up';
    } else if (net < 0) {
      badgeEl.textContent = 'Fees > Rewards';
      badgeEl.className = 'fa-rewards__badge fa-rewards__badge--down';
    } else {
      badgeEl.textContent = 'Even';
      badgeEl.className = 'fa-rewards__badge fa-rewards__badge--neutral';
    }

    ratioEl.textContent = (feesTotal > 0 && rewardsTotal > 0)
      ? `Fee-to-reward ratio: ${(feesTotal / rewardsTotal).toFixed(2)}x`
      : '';

    noteEl.textContent = this.rewards.items.length
      ? ''
      : (this.rewards.reason || 'No rewards/airdrops found for this wallet yet.');
  },

  /* ---- background loads: rewards ---- */
  async ensureRewardsLoaded() {
    if (this.rewards !== null) return;
    const walletId = this.wallet;
    this.rewards = 'loading';
    this.renderRewards();
    const result = await RewardsData.fetchForWallet(walletId);
    if (this.wallet !== walletId) return; // wallet changed while this was in flight
    this.rewards = result;
    this.renderRewards();
  },

  /* ---- background loads: execution-level fills + funding events ---- */
  async ensureDetailedDataLoaded() {
    if (this.detailedFills !== null || this.detailedFunding !== null) return;

    if (this.app.demoMode) {
      // Demo data (js/demo.js) doesn't model per-fill liquidity flags or
      // standalone funding events — be honest about that instead of
      // fabricating a split from fabricated data.
      this.detailedFills = 'error';
      this.detailedFunding = 'error';
      this.renderMakerTaker();
      this.renderFunding();
      return;
    }

    const opens = this.app.trades.map((t) => t.position.openTimestamp).filter((v) => v != null);
    if (!opens.length) {
      this.detailedFills = 'error';
      this.detailedFunding = 'error';
      this.renderMakerTaker();
      this.renderFunding();
      return;
    }

    const walletId = this.wallet;
    const startTime = Math.min(...opens);
    const endTime = Date.now();

    this.detailedFills = 'loading';
    this.detailedFunding = 'loading';
    this.renderMakerTaker();
    this.renderFunding();

    const [fillsRaw, fundingRaw] = await Promise.all([
      softLoad(() => PopDexApi.fetchAllFills(walletId, { startTime, endTime })),
      softLoad(() => PopDexApi.fetchAllAccountFunding(walletId, { startTime, endTime })),
    ]);

    if (this.wallet !== walletId) return; // wallet changed while this was in flight

    this.detailedFills = Array.isArray(fillsRaw) ? normalizeList(fillsRaw, normalizeFill) : 'error';
    this.detailedFunding = Array.isArray(fundingRaw) ? normalizeList(fundingRaw, normalizeFunding) : 'error';

    this.renderMakerTaker();
    this.renderFunding();
    this.renderTrend(); // now that the detailed data is in, upgrade the trend to event-level granularity
  },
};

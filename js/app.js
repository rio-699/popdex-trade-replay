/* =========================================================================
   APP — screens, routing, and glue between API / core / chart layers
   ========================================================================= */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const App = {
  wallet: null,
  overview: null,        // normalized /history/portfolio rollup (authoritative volume source, when available)
  trades: [],           // built Trade objects for the list screen
  filteredTrades: [],
  filter: 'All',
  sort: 'Newest',
  demoMode: false,
  chart: null,
  replayTimer: null,
  timeframePref: 'auto',   // 'auto' or one of TIMEFRAME_ORDER — sticky across trades until changed
  _demoBaseCandles: null,
  _recording: false,
  _replayToken: 0,         // bumped every time a new trade starts loading — stale async loads check this before touching state/UI

  screens: {
    home: $('#screen-home'),
    tradeList: $('#screen-trade-list'),
    feeAnalytics: $('#screen-fee-analytics'),
    replay: $('#screen-replay'),
  },

  activeTab: 'tradeReplay', // 'tradeReplay' | 'feeAnalytics' — which tab is selected once a wallet is loaded

  init() {
    this.bindHomepage();
    this.bindTradeListControls();
    this.bindReplayControls();
    this.bindWorkspaceHeader();
    this.handleInitialRoute();
  },

  showScreen(name) {
    for (const key of Object.keys(this.screens)) {
      this.screens[key].classList.toggle('screen--active', key === name);
    }
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  },

  /* ----------------------------------------------------------------------
     ROUTING — §52 shareable replay URLs
     ---------------------------------------------------------------------- */
  handleInitialRoute() {
    const params = new URLSearchParams(window.location.search);
    const wallet = params.get('wallet');
    const tradeId = params.get('trade');
    const tab = params.get('tab');
    if (wallet) {
      $('#wallet-input').value = wallet;
      this.searchWallet(wallet).then(() => {
        if (tradeId) {
          const trade = this.trades.find((t) => String(t.id) === String(tradeId));
          if (trade) { this.openReplay(trade); return; }
        }
        if (tab === 'feeAnalytics') this.setActiveTab('feeAnalytics');
      });
    }
  },

  pushRoute({ wallet, tradeId, tab } = {}) {
    const params = new URLSearchParams();
    if (wallet) params.set('wallet', wallet);
    if (tradeId) params.set('trade', tradeId);
    if (tab && tab !== 'tradeReplay') params.set('tab', tab);
    const qs = params.toString();
    history.pushState({}, '', qs ? `?${qs}` : window.location.pathname);
  },

  /* ----------------------------------------------------------------------
     HOMEPAGE — §2, §21
     ---------------------------------------------------------------------- */
  bindHomepage() {
    const input = $('#wallet-input');
    const form = $('#wallet-form');
    const clearBtn = $('#wallet-clear');
    const demoToggle = $('#demo-mode-toggle');

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.searchWallet(input.value);
    });

    input.addEventListener('input', () => {
      clearBtn.hidden = input.value.length === 0;
      this.clearHomeError();
    });

    clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.hidden = true;
      input.focus();
      this.clearHomeError();
    });

    demoToggle.addEventListener('click', () => {
      this.demoMode = !this.demoMode;
      demoToggle.setAttribute('aria-pressed', String(this.demoMode));
      demoToggle.classList.toggle('is-active', this.demoMode);
      $('#demo-banner-home').hidden = !this.demoMode;
    });
  },

  clearHomeError() {
    const el = $('#home-error');
    el.hidden = true;
    el.textContent = '';
  },

  showHomeError(message) {
    const el = $('#home-error');
    el.hidden = false;
    el.textContent = message;
  },

  setHomeLoading(isLoading, message) {
    const btn = $('#wallet-submit');
    const loadingEl = $('#home-loading');
    btn.disabled = isLoading;
    btn.classList.toggle('is-loading', isLoading);
    loadingEl.hidden = !isLoading;
    if (message) loadingEl.textContent = message;
  },

  async searchWallet(raw) {
    const address = sanitizeWalletInput(raw);
    this.clearHomeError();

    if (!address) {
      this.showHomeError('Enter a wallet address to continue.');
      return;
    }
    if (!looksLikeWalletAddress(address) && !this.demoMode) {
      this.showHomeError('That doesn\u2019t look like a valid wallet address. Please check it and try again.');
      return;
    }

    this.wallet = address;
    this.setHomeLoading(true, 'Finding your trades\u2026');

    try {
      if (this.demoMode) {
        await sleep(500);
        this.setHomeLoading(true, 'Loading trade history\u2026');
        await sleep(400);
        this.trades = DemoData.buildTrades();
        this.overview = null;
      } else {
        this.setHomeLoading(true, 'Loading trade history\u2026');
        // Pages through the FULL closed-position history, not just the
        // first page — the API only returns ~20 trades per page by default.
        const [positions, portfolioRaw] = await Promise.all([
          PopDexApi.fetchAllHistoricalPositions(address, {
            onPage: (count) => this.setHomeLoading(true, `Loading trade history\u2026 (${count} found)`),
          }),
          // Non-blocking: the summary strip still works off the calculated
          // fallback if this fails or the wallet has no history yet.
          softLoad(() => PopDexApi.fetchPortfolioHistory(address, { window: 'All', scope: 'All' })),
        ]);
        const normalizedPositions = positions
          .map(normalizePosition)
          .filter((p) => p && p.closeTimestamp != null); // only completed/closed trades

        this.setHomeLoading(true, 'Preparing your trades\u2026');
        this.trades = normalizedPositions.map((p) => buildTrade(p, {}));
        this.overview = normalizePortfolioHistory(portfolioRaw);
      }

      this.pushRoute({ wallet: address });
      this.renderTradeList();
      this.enterWorkspace();
    } catch (err) {
      this.handleFetchError(err, { context: 'home' });
    } finally {
      this.setHomeLoading(false);
    }
  },

  handleFetchError(err, { context }) {
    let message;
    if (err instanceof PopDexApi.ApiError) {
      if (PopDexApi.isInvalidWalletError(err)) {
        message = 'Invalid wallet address. Please check the address and try again.';
      } else {
        message = err.message;
      }
    } else {
      message = 'Something unexpected went wrong. Please try again.';
    }
    if (context === 'home') this.showHomeError(message);
    else this.showToast(message);
    console.error(err);
  },

  showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.hidden = false;
    toast.classList.add('toast--visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.classList.remove('toast--visible');
      toast.hidden = true;
    }, 4000);
  },

  /* ----------------------------------------------------------------------
     TRADE LIST SCREEN — §22, §23
     ---------------------------------------------------------------------- */
  bindTradeListControls() {
    $$('.filter-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        $$('.filter-chip').forEach((c) => c.classList.remove('is-active'));
        chip.classList.add('is-active');
        this.filter = chip.dataset.filter;
        this.renderTradeList();
      });
    });

    $('#sort-select').addEventListener('change', (e) => {
      this.sort = e.target.value;
      this.renderTradeList();
    });
  },

  /* ----------------------------------------------------------------------
     WORKSPACE HEADER — wallet display + tab nav, shared by the
     Trade Replay (trade-list) and Fee Analytics screens (§1, §10)
     ---------------------------------------------------------------------- */
  bindWorkspaceHeader() {
    $$('[data-change-wallet]').forEach((btn) => {
      btn.addEventListener('click', () => this.changeWallet());
    });
    $$('[data-tab-btn]').forEach((btn) => {
      btn.addEventListener('click', () => this.setActiveTab(btn.dataset.tabBtn));
    });
  },

  /** Wallet analyzed successfully — show the tabbed workspace (§1, §9). */
  enterWorkspace({ preserveTab = false } = {}) {
    $('#trade-list-wallet').textContent = shortenAddress(this.wallet);
    $('#fee-analytics-wallet').textContent = shortenAddress(this.wallet);
    this.setActiveTab(preserveTab ? this.activeTab : 'tradeReplay');
  },

  /** Clears the loaded wallet and returns to the wallet-entry screen (§1 "Change Wallet"). */
  changeWallet() {
    this.wallet = null;
    this.overview = null;
    this.trades = [];
    this.filteredTrades = [];
    if (typeof FeeAnalytics !== 'undefined') FeeAnalytics.reset();
    history.pushState({}, '', window.location.pathname);
    $('#wallet-input').value = '';
    $('#wallet-clear').hidden = true;
    this.clearHomeError();
    this.showScreen('home');
    $('#wallet-input').focus();
  },

  setActiveTab(tab) {
    this.activeTab = tab;
    $$('[data-tab-btn]').forEach((btn) => {
      const isActive = btn.dataset.tabBtn === tab;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });
    if (tab === 'feeAnalytics') {
      this.showScreen('feeAnalytics');
      if (typeof FeeAnalytics !== 'undefined') FeeAnalytics.render(this);
    } else {
      this.showScreen('tradeList');
    }
    if (this.wallet) this.pushRoute({ wallet: this.wallet, tab });
  },

  applyFilterSort() {
    let list = [...this.trades];
    const p = (t) => t.position;

    switch (this.filter) {
      case 'Profitable': list = list.filter((t) => netPnlValue(t) > 0); break;
      case 'Losing': list = list.filter((t) => netPnlValue(t) < 0); break;
      case 'Long': list = list.filter((t) => p(t).side === 'LONG'); break;
      case 'Short': list = list.filter((t) => p(t).side === 'SHORT'); break;
      default: break;
    }

    const byTime = (a, b) => (p(a).closeTimestamp ?? 0) - (p(b).closeTimestamp ?? 0);
    switch (this.sort) {
      case 'Newest': list.sort((a, b) => byTime(b, a)); break;
      case 'Oldest': list.sort(byTime); break;
      case 'Highest PnL': list.sort((a, b) => netPnlValue(b) - netPnlValue(a)); break;
      case 'Lowest PnL': list.sort((a, b) => netPnlValue(a) - netPnlValue(b)); break;
      case 'Largest Position': list.sort((a, b) => (p(b).size ?? 0) - (p(a).size ?? 0)); break;
      case 'Longest Trade': list.sort((a, b) => duration(b) - duration(a)); break;
      default: break;
    }
    return list;
  },

  renderTradeList() {
    $('#trade-list-wallet').textContent = shortenAddress(this.wallet);
    this.renderSummary();
    this.filteredTrades = this.applyFilterSort();

    const container = $('#trade-list');
    container.innerHTML = '';

    if (!this.trades.length) {
      $('#trade-list-empty').hidden = false;
      container.hidden = true;
      return;
    }
    $('#trade-list-empty').hidden = true;
    container.hidden = false;

    if (!this.filteredTrades.length) {
      container.innerHTML = `<div class="empty-inline">No trades match this filter.</div>`;
      return;
    }

    for (const trade of this.filteredTrades) {
      container.appendChild(this.renderTradeRow(trade));
    }
  },

  renderSummary() {
    const total = this.trades.length;
    const wins = this.trades.filter((t) => netPnlValue(t) > 0).length;
    const losses = this.trades.filter((t) => netPnlValue(t) < 0).length;
    const pnl = this.trades.reduce((s, t) => s + netPnlValue(t), 0);

    $('#stat-total').textContent = total;
    $('#stat-wins').textContent = wins;
    $('#stat-losses').textContent = losses;

    const volumeEl = $('#stat-volume');
    const volumeTag = this.totalVolumeTag();
    if (volumeTag.src === SRC.NONE) {
      volumeEl.innerHTML = '\u2014';
    } else {
      const badge = volumeTag.src === SRC.CALC
        ? ' <span class="calc-badge" title="PopDEX portfolio-volume data unavailable — summed from loaded trades instead">calc</span>'
        : '';
      volumeEl.innerHTML = `${formatCurrency(volumeTag.value)}${badge}`;
    }

    const pnlEl = $('#stat-pnl');
    pnlEl.textContent = total ? formatSignedCurrency(pnl) : '\u2014';
    pnlEl.classList.toggle('positive', pnl > 0);
    pnlEl.classList.toggle('negative', pnl < 0);

    // Avg Trade Time — only over trades with a real open+close timestamp
    // pair; duration() returns 0 for trades missing either one, and a
    // 0-duration trade is indistinguishable from a missing one, so those
    // are excluded rather than silently dragging the average down.
    const durations = this.trades
      .filter((t) => t.position.openTimestamp != null && t.position.closeTimestamp != null)
      .map((t) => duration(t));
    const avgEl = $('#stat-avg-duration');
    if (avgEl) {
      avgEl.textContent = durations.length
        ? formatDuration(durations.reduce((s, d) => s + d, 0) / durations.length)
        : '\u2014';
    }
  },

  /**
   * Total volume, provenance-tagged. Prefers PopDEX's own /history/portfolio
   * rollup (window: 'All') — that's the lifetime figure their own site
   * displays, so it's the only value guaranteed to match theirs. Falls back
   * to summing each loaded trade's own volume only when that data isn't
   * available (demo mode, a fetch failure, or a wallet the endpoint doesn't
   * recognize).
   */
  totalVolumeTag() {
    if (this.overview && this.overview.totalVolume != null) {
      return tag(this.overview.totalVolume, SRC.API);
    }
    if (!this.trades.length) return UNAVAILABLE;
    const sum = this.trades.reduce((s, t) => s + tradeVolumeValue(t), 0);
    return tag(sum, SRC.CALC);
  },

  renderTradeRow(trade) {
    const p = trade.position;
    const row = document.createElement('div');
    row.className = 'trade-row';
    // Net PnL = realized PnL, minus trading fees, plus/minus funding — same
    // formula the summary strip (renderSummary) and the live replay panel's
    // "Net PnL" metric already use. Previously this cell printed the raw
    // p.realizedPnl (gross, pre-fee) while only *coloring* itself off the
    // net figure — so a trade could show green here while its fees/funding
    // actually put it underwater. `pnl` below is the one true net number;
    // it's what gets both the color and the printed value now.
    const pnl = netPnlValue(trade);
    row.innerHTML = `
      <div class="trade-row__cell trade-row__pair">
        <span class="side-badge side-badge--${(p.side || '').toLowerCase()}">${p.side || '\u2014'}</span>
        <span>${p.symbol || '\u2014'}</span>
      </div>
      <div class="trade-row__cell">${formatPrice(p.entryPrice)}</div>
      <div class="trade-row__cell">${formatPrice(p.exitPrice)}</div>
      <div class="trade-row__cell">${p.size != null ? p.size : '\u2014'}</div>
      <div class="trade-row__cell">${p.leverage != null ? p.leverage + 'x' : '\u2014'}</div>
      <div class="trade-row__cell ${pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : ''}" title="Gross PnL: ${p.realizedPnl != null ? formatSignedCurrency(p.realizedPnl) : '\u2014'}">${p.realizedPnl != null ? formatSignedCurrency(pnl) : '\u2014'}</div>
      <div class="trade-row__cell">${p.fees != null ? formatCurrency(p.fees) : '\u2014'}</div>
      <div class="trade-row__cell">${p.funding != null ? formatSignedCurrency(p.funding) : '\u2014'}</div>
      <div class="trade-row__cell">${duration(trade) ? formatDuration(duration(trade)) : '\u2014'}</div>
      <div class="trade-row__cell">${p.closeTimestamp ? formatDate(p.closeTimestamp) : '\u2014'}</div>
      <div class="trade-row__cell trade-row__action">
        <button class="btn btn--small btn--outline" type="button">Replay Trade</button>
      </div>
    `;
    row.querySelector('button').addEventListener('click', () => this.openReplay(trade));
    return row;
  },

  /* ----------------------------------------------------------------------
     REPLAY SCREEN — §24–§42
     ---------------------------------------------------------------------- */
  bindReplayControls() {
    $('#back-to-list').addEventListener('click', () => {
      this.teardownReplay();
      this.setActiveTab('tradeReplay');
    });

    $('#replay-play').addEventListener('click', () => this.togglePlay());
    $('#replay-restart').addEventListener('click', () => { ReplayStateInstance.restart(); this.renderReplayFrame(); });
    $('#replay-prev').addEventListener('click', () => this.stepEvent(-1));
    $('#replay-next').addEventListener('click', () => this.stepEvent(1));

    $('#replay-seek').addEventListener('input', (e) => {
      const pct = Number(e.target.value) / 1000;
      const { startTimestamp, endTimestamp } = ReplayStateInstance;
      if (startTimestamp == null || endTimestamp == null) return;
      ReplayStateInstance.seekTo(startTimestamp + pct * (endTimestamp - startTimestamp));
      this.renderReplayFrame();
    });

    $$('.speed-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.speed-btn').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        ReplayStateInstance.setSpeed(Number(btn.dataset.speed));
        $('#speed-custom').value = '';
      });
    });
    $('#speed-custom').addEventListener('change', (e) => {
      const v = Math.min(100, Math.max(5, Number(e.target.value) || 5));
      $$('.speed-btn').forEach((b) => b.classList.remove('is-active'));
      ReplayStateInstance.setSpeed(v);
    });

    $('#share-replay').addEventListener('click', () => this.shareReplay());

    // Candlestick timeframe — §46
    $('#chart-timeframe').addEventListener('change', (e) => this.changeTimeframe(e.target.value));

    // Download clip — §48
    // Only the desktop (widescreen) cut is offered — the phone cut has been
    // retired, so this is a single direct action rather than a dropdown.
    $('#download-clip').addEventListener('click', () => this.downloadClip('desktop'));

    // Right-click "Reset Chart" — §49
    // Restores the chart's own view (position/zoom/scroll) back to the
    // default fitToFullRange framing. Deliberately scoped to just the
    // viewport: it never touches trade data, markers, or replay state, and
    // reuses fitToFullRange (the same "sensible default" logic used on
    // load) rather than a separate reset implementation.
    const chartContainer = $('#chart-container');
    const contextMenu = $('#chart-context-menu');
    chartContainer.addEventListener('contextmenu', (e) => {
      const s = ReplayStateInstance;
      if (!s.trade || !this.chart) return; // nothing loaded yet — let the browser menu show
      e.preventDefault();
      contextMenu.style.left = `${e.clientX}px`;
      contextMenu.style.top = `${e.clientY}px`;
      contextMenu.hidden = false;
    });
    $('#chart-context-reset').addEventListener('click', () => {
      contextMenu.hidden = true;
      const s = ReplayStateInstance;
      if (s.trade && this.chart) this.chart.fitToFullRange(s.trade.position.openTimestamp);
    });
    document.addEventListener('click', (e) => {
      if (!contextMenu.hidden && !e.target.closest('.chart-context-menu')) contextMenu.hidden = true;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') contextMenu.hidden = true;
    });
    window.addEventListener('scroll', () => { contextMenu.hidden = true; }, true);
  },

  async openReplay(trade) {
    // Every call gets its own token. If the user jumps to another trade before
    // this one's data comes back (a slow fetchOrders/fetchFills/fetchHistoricalCandles
    // call resolving late), the stale response is discarded instead of overwriting
    // the newer trade's state — this was the source of a replay showing the
    // PREVIOUS trade's exit price after switching.
    const token = ++this._replayToken;

    this.pushRoute({ wallet: this.wallet, tradeId: trade.id });
    this.showScreen('replay');
    this.renderReplaySkeleton(trade);

    try {
      const p = trade.position;
      const windowMs = (p.closeTimestamp ?? p.openTimestamp) - p.openTimestamp;
      const resolvedInterval = (this.timeframePref && this.timeframePref !== 'auto')
        ? this.timeframePref
        : pickAutoInterval(windowMs);

      let enriched;
      if (this.demoMode) {
        enriched = DemoData.enrichTrade(trade);
        if (token !== this._replayToken) return; // superseded — bail before touching state
        this._demoBaseCandles = enriched.candles;
        if (resolvedInterval !== '1m') enriched = { ...enriched, candles: resampleCandles(enriched.candles, resolvedInterval) };
      } else {
        enriched = await this.loadReplayData(trade, resolvedInterval);
        if (token !== this._replayToken) return; // a newer openReplay() started while we were fetching
        this._demoBaseCandles = null;
      }
      const candles = enriched.candles;
      const timeline = buildTimeline(enriched.trade);

      ReplayStateInstance.load(enriched.trade, candles, timeline);
      // Orders/executions panels skip their rebuild when the visible count
      // hasn't changed since last frame (see renderOrdersPanel) — reset that
      // cache here so a new trade with a coincidentally-matching count still
      // gets a real rebuild instead of showing the previous trade's rows.
      delete $('#orders-panel').dataset.count;
      delete $('#executions-panel').dataset.count;
      $('#event-timeline')._builtForEvents = null;
      this.setupChart();
      this.chart.setFullPath(candles);
      this.chart.setEntryLine(enriched.trade.position.entryPrice);
      this.chart.setExitLine(enriched.trade.position.exitPrice);
      this.chart.setLiquidationLine(enriched.trade.position.liquidationPrice);
      this.chart.setMarkers({
        orders: enriched.trade.orders,
        entryTs: enriched.trade.position.openTimestamp,
        exitTs: enriched.trade.position.closeTimestamp,
      });

      this.analytics = null;
      this.renderReplayFrame();
      this.updateTimeframeUI(resolvedInterval);
      $('#chart-processing').hidden = true;
      // Unhide the replay body BEFORE fitting the chart's view — fitToFullRange
      // now sizes the visible candle range off the chart container's actual
      // pixel width, which is 0 while the panel is still [hidden]. The double
      // rAF gives the browser one real layout/paint pass first, so the width
      // it reads is the real, laid-out one (matters most on mobile, where the
      // container's width isn't known until this panel is on screen).
      $('#replay-body').hidden = false;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          this.chart.fitToFullRange(enriched.trade.position.openTimestamp);
        });
      });
    } catch (err) {
      if (token !== this._replayToken) return; // don't surface errors from a superseded load
      $('#chart-processing').hidden = true;
      this.handleFetchError(err, { context: 'replay' });
      $('#replay-fatal-error').hidden = false;
      $('#replay-fatal-error').textContent = err.message || 'Could not load this trade.';
    }
  },

  renderReplaySkeleton(trade) {
    // Show the replay shell right away instead of blocking the whole screen
    // behind a full-page loader — the processing indicator now lives as a
    // slim strip under the chart and disappears once the result is ready.
    $('#replay-body').hidden = false;
    $('#replay-fatal-error').hidden = true;
    $('#chart-processing').hidden = false;
    $('#chart-processing-text').textContent = 'Loading historical position\u2026';

    // Fully reset every panel so nothing from the PREVIOUS trade lingers
    // while the new one loads (this was the source of stale entry/exit
    // banners and analysis showing the wrong trade's numbers).
    this.stopTicker();
    this.analytics = null;
    if (this.chart) { this.chart.destroy(); this.chart = null; }
    $('#entry-banner').hidden = true;
    $('#exit-banner').hidden = true;
    $('#entry-banner-price').textContent = '\u2014';
    $('#exit-banner-price').textContent = '\u2014';
    $('#trade-analysis').hidden = true;
    $('#orders-panel').innerHTML = '';
    $('#executions-panel').innerHTML = '';
    $('#event-timeline').innerHTML = '';
    $('#replay-seek').value = '0';
    $('#replay-timestamp').textContent = '\u2014';
    $('#chart-timeframe-resolved').textContent = '';
    $$('.speed-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.speed === '5'));
    $('#speed-custom').value = '';
    ReplayStateInstance.setSpeed(5);
    this.updatePlayButton();

    const p = trade.position;
    $('#replay-pair').textContent = p.symbol || '\u2014';
    $('#replay-side').textContent = p.side || '\u2014';
  },

  /** Loads everything for one trade; optional pieces fail soft (§25). */
  async loadReplayData(trade, interval) {
    const p = trade.position;
    const walletId = this.wallet;
    const setLoading = (msg) => { $('#chart-processing-text').textContent = msg; };

    const category = p.raw?.category || p.raw?.instrumentType || 'Futures';
    // Enough surrounding context so the entry candle can sit centered in the
    // chart's initial view instead of flush against the left edge (§45).
    // fitToFullRange (chart.js) targets roughly containerWidth/7 visible
    // bars with entry at the horizontal midpoint — a pad sized only as a
    // percentage of the trade's own duration was too thin for short trades
    // (and for wide screens), leaving too few real candles before entry for
    // that centering to have anywhere to put them, so it fell back to
    // clamping the entry candle near the left edge instead.
    const windowMs = (p.closeTimestamp ?? p.openTimestamp) - p.openTimestamp;
    const intervalMs = INTERVAL_MS[interval] || 60_000;
    const MIN_PAD_BARS = 150; // covers ~half the widest chart's visible bars
    const pad = Math.max(MIN_PAD_BARS * intervalMs, Math.round(windowMs * 0.05), 60_000);

    // None of these five calls depend on each other, so fire them all at once
    // instead of awaiting one at a time — this is the main fix for slow load times.
    setLoading('Loading trade data\u2026');
    const [orders, fills, candlesRaw, funding, liquidations] = await Promise.all([
      softLoad(() => PopDexApi.fetchAllOrders(walletId, {
        startTime: p.openTimestamp, endTime: p.closeTimestamp,
      })),
      softLoad(() => PopDexApi.fetchFills(walletId, {
        startTime: p.openTimestamp, endTime: p.closeTimestamp,
      })),
      softLoad(() => PopDexApi.fetchAllHistoricalCandles({
        category,
        symbol: p.symbol,
        interval,
        type: 'Market',
        startTime: p.openTimestamp - pad,
        endTime: (p.closeTimestamp ?? p.openTimestamp) + pad,
        pageSize: 1000,
      })),
      softLoad(() => PopDexApi.fetchAccountFunding(walletId, {
        startTime: p.openTimestamp, endTime: p.closeTimestamp,
      })),
      softLoad(() => PopDexApi.fetchLiquidations(walletId, {
        startTime: p.openTimestamp, endTime: p.closeTimestamp,
      })),
    ]);

    setLoading('Preparing replay\u2026');
    const normOrders = normalizeList(orders, normalizeOrder);
    const normFills = normalizeList(fills, normalizeFill);
    const normFunding = normalizeList(funding, normalizeFunding);
    const normLiqs = normalizeList(liquidations, normalizeLiquidation);
    const candles = (Array.isArray(candlesRaw) ? candlesRaw : candlesRaw?.list || [])
      .map(normalizeCandle).filter(Boolean).sort((a, b) => a.timeMs - b.timeMs);

    const enrichedTrade = buildTrade(p, { orders: normOrders, fills: normFills, funding: normFunding, liquidations: normLiqs });
    return { trade: enrichedTrade, candles };
  },

  /** Re-fetches (or, in Demo Mode, resamples) candles at a new interval without touching orders/fills/etc. */
  async changeTimeframe(value) {
    const s = ReplayStateInstance;
    if (!s.trade) return;
    const token = this._replayToken; // guards against a trade switch landing mid-fetch
    this.timeframePref = value;
    const p = s.trade.position;
    const windowMs = (p.closeTimestamp ?? p.openTimestamp) - p.openTimestamp;
    const resolvedInterval = value === 'auto' ? pickAutoInterval(windowMs) : value;

    $('#chart-processing').hidden = false;
    $('#chart-processing-text').textContent = 'Reloading candles\u2026';
    try {
      let candles;
      if (this.demoMode) {
        candles = resolvedInterval === '1m' ? this._demoBaseCandles : resampleCandles(this._demoBaseCandles, resolvedInterval);
      } else {
        const enriched = await this.loadReplayData(s.trade, resolvedInterval);
        if (token !== this._replayToken) return; // a different trade loaded while this candle fetch was in flight
        candles = enriched.candles;
      }
      s.candles = candles;
      this.chart.setFullPath(candles);
      this.chart.setEntryLine(p.entryPrice);
      this.chart.setExitLine(p.exitPrice);
      this.chart.setLiquidationLine(p.liquidationPrice);
      this.chart.setMarkers({
        orders: s.trade.orders,
        entryTs: p.openTimestamp,
        exitTs: p.closeTimestamp,
      });
      this.renderReplayFrame();
      this.chart.fitToFullRange(p.openTimestamp);
      this.updateTimeframeUI(resolvedInterval);
    } catch (err) {
      if (token !== this._replayToken) return;
      this.handleFetchError(err, { context: 'replay' });
    } finally {
      if (token === this._replayToken) $('#chart-processing').hidden = true;
    }
  },

  updateTimeframeUI(resolvedInterval) {
    $('#chart-timeframe').value = this.timeframePref || 'auto';
    $('#chart-timeframe-resolved').textContent = (!this.timeframePref || this.timeframePref === 'auto') ? `(${resolvedInterval})` : '';
  },

  /**
   * Records the full trade (entry \u2192 exit) as one real widescreen video
   * clip, for the browser. It plays the replay through off-screen, capturing
   * one high-res frame of the trade card (info panel + chart + live metrics)
   * per step and compositing it into the output canvas. Each frame is
   * pushed to the recorder the instant it's ready \u2014 there's no artificial
   * real-time wait baked in, so this finishes as fast as the device can
   * actually render the frames, with a small adaptive pacing step that only
   * waits when rendering was faster than the target playback rate (never on
   * top of it). Falls back to a PNG snapshot in browsers that can't do
   * canvas video capture.
   */
  async downloadClip(format = 'desktop') {
    const s = ReplayStateInstance;
    if (!s.trade || !this.chart) { this.showToast('Load a trade first.'); return; }
    if (this._recording) return;

    const target = $('.replay-grid');
    const chartPanel = $('.replay-chart');
    if (!target || !chartPanel) { this.showToast('Nothing to download yet.'); return; }

    this._recording = true;
    const btn = $('#download-clip');
    btn.disabled = true;
    const originalLabel = btn.innerHTML;
    btn.textContent = 'Preparing clip\u2026';

    const canRecordVideo = typeof html2canvas === 'function'
      && typeof MediaRecorder !== 'undefined'
      && typeof HTMLCanvasElement.prototype.captureStream === 'function'
      && s.startTimestamp != null && s.endTimestamp != null && s.endTimestamp > s.startTimestamp;

    if (!canRecordVideo) {
      await this.downloadSnapshot(target, chartPanel, s, format);
      this._recording = false;
      btn.disabled = false;
      btn.innerHTML = originalLabel;
      return;
    }

    // Recording drives the playhead through the whole trade itself \u2014 remember
    // where the person actually was so we can put it back when we're done.
    const wasPlaying = s.isPlaying;
    const resumeTs = s.currentTimestamp;
    if (wasPlaying) { s.pause(); this.stopTicker(); this.updatePlayButton(); }

    // Clip length scales with the trade itself — a couple of minutes of
    // scalping gets a tight 15s recap, a multi-hour/day swing trade gets the
    // full 30s so there's room to actually see the move play out.
    //
    // SAMPLES_PER_SEC is effectively the exported video's frame rate (each
    // rendered frame is held via track.requestFrame() for HOLD_MS). 15/sec
    // is the highest rate that's actually reliable here: every sample costs
    // one html2canvas rasterization of the whole trade card, which is the
    // real bottleneck (tens of ms per frame, not sub-millisecond like a
    // canvas-only redraw), so pushing this much higher (e.g. 30/60fps) would
    // multiply total render time for a marginal smoothness gain and risk
    // the tab stalling out on longer clips or slower devices. The adaptive
    // pacing below never blocks *beyond* however long a frame actually took
    // to render, so a slower device gracefully renders below this target
    // instead of stuttering or failing outright.
    const SAMPLES_PER_SEC = 15;
    const targetDurationSec = targetClipSeconds(s.endTimestamp - s.startTimestamp);
    const RENDER_SAMPLES = Math.round(targetDurationSec * SAMPLES_PER_SEC);
    const HOLD_MS = 1000 / SAMPLES_PER_SEC;
    const scale = Math.min(2, window.devicePixelRatio || 1);
    const mimeType = pickVideoMimeType();
    const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
    const recorderOpts = { videoBitsPerSecond: 12_000_000, ...(mimeType ? { mimeType } : {}) };
    const isMobile = format === 'mobile';

    let stream = null;

    try {
      const gridRect = target.getBoundingClientRect();
      const chartRect = chartPanel.getBoundingClientRect();
      // Chart panel's position relative to the captured bitmap, in bitmap pixels.
      const chartCrop = {
        x: (chartRect.left - gridRect.left) * scale,
        y: (chartRect.top - gridRect.top) * scale,
        w: chartRect.width * scale,
        h: chartRect.height * scale,
      };

      const MOBILE_W = 1080;
      const MOBILE_H = 1920;
      const outCanvas = document.createElement('canvas');
      outCanvas.width = isMobile ? MOBILE_W : Math.max(2, Math.round(gridRect.width * scale));
      outCanvas.height = isMobile ? MOBILE_H : Math.max(2, Math.round(gridRect.height * scale));
      const outCtx = outCanvas.getContext('2d');

      stream = outCanvas.captureStream(0);
      const track = stream.getVideoTracks()[0];

      const chunks = [];
      const recorder = new MediaRecorder(stream, recorderOpts);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
      recorder.start();

      for (let i = 0; i <= RENDER_SAMPLES; i++) {
        const frameStart = performance.now();
        btn.textContent = `Rendering \u2026 ${Math.round((i / RENDER_SAMPLES) * 100)}%`;
        const ts = s.startTimestamp + (s.endTimestamp - s.startTimestamp) * (i / RENDER_SAMPLES);
        s.seekTo(ts);
        this.renderReplayFrame();
        // Give the chart/DOM a moment to actually paint the new frame before capturing it.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const frame = await html2canvas(target, { backgroundColor: '#0E0E0E', scale, useCORS: true, logging: false });

        if (isMobile) {
          drawMobileFrame(outCtx, frame, chartCrop, MOBILE_W, MOBILE_H, s.trade);
        } else {
          outCtx.clearRect(0, 0, outCanvas.width, outCanvas.height);
          outCtx.drawImage(frame, 0, 0, outCanvas.width, outCanvas.height);
          // Entry/exit are drawn on top of every frame (not just when the
          // playhead happens to cross them) so the full trade card is always
          // readable, even paused on a single frame of the finished clip.
          drawEntryExitOverlay(outCtx, outCanvas.width, outCanvas.height, s.trade);
        }

        track.requestFrame();

        // Adaptive pacing: only wait if rendering finished faster than the
        // hold time each sample needs to fill out the target clip length.
        // On a slow device this never adds a single extra millisecond \u2014
        // the loop just runs at whatever pace the device can manage.
        const elapsed = performance.now() - frameStart;
        if (elapsed < HOLD_MS) await sleep(HOLD_MS - elapsed);
      }

      recorder.stop();
      await stopped;

      const outType = (mimeType.split(';')[0]) || 'video/webm';
      const blob = new Blob(chunks, { type: outType });
      if (!blob.size) throw new Error('Recording produced no data');

      downloadBlob(blob, clipFilename(s.trade, ext, format));
      this.showToast(isMobile ? 'Phone clip downloaded.' : 'Desktop clip downloaded.');
    } catch (err) {
      console.error(err);
      await this.downloadSnapshot(target, chartPanel, s, format);
    } finally {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      s.seekTo(resumeTs);
      this.renderReplayFrame();
      if (wasPlaying) { s.play(); this.startTicker(); this.updatePlayButton(); }
      this._recording = false;
      btn.disabled = false;
      btn.innerHTML = originalLabel;
    }
  },

  /** Fallback used when this browser can't record canvas video (or recording failed): a single PNG still for the chosen format instead of a clip. */
  async downloadSnapshot(target, chartPanel, s, format = 'desktop') {
    const isMobile = format === 'mobile';
    try {
      if (typeof html2canvas !== 'function') throw new Error('html2canvas unavailable');
      const scale = Math.min(2, window.devicePixelRatio || 1);
      // backgroundColor matches the app's real dark background \u2014 without it
      // html2canvas fills transparent areas with white, which looked like a
      // stray "box" behind the chart in downloads.
      const frame = await html2canvas(target, { backgroundColor: '#0E0E0E', scale, useCORS: true, logging: false });

      if (!isMobile) {
        const frameCtx = frame.getContext('2d');
        drawEntryExitOverlay(frameCtx, frame.width, frame.height, s.trade);
        downloadCanvasAsPng(frame, clipFilename(s.trade, 'png', 'desktop'));
        this.showToast('Video recording isn\u2019t supported in this browser \u2014 downloaded a desktop snapshot instead.');
        return;
      }

      const gridRect = target.getBoundingClientRect();
      const chartRect = chartPanel.getBoundingClientRect();
      const chartCrop = {
        x: (chartRect.left - gridRect.left) * scale,
        y: (chartRect.top - gridRect.top) * scale,
        w: chartRect.width * scale,
        h: chartRect.height * scale,
      };
      const mobileCanvas = document.createElement('canvas');
      mobileCanvas.width = 1080;
      mobileCanvas.height = 1920;
      drawMobileFrame(mobileCanvas.getContext('2d'), frame, chartCrop, 1080, 1920, s.trade);
      downloadCanvasAsPng(mobileCanvas, clipFilename(s.trade, 'png', 'mobile'));
      this.showToast('Video recording isn\u2019t supported in this browser \u2014 downloaded a phone snapshot instead.');
    } catch (err) {
      console.error(err);
      const shot = this.chart.takeScreenshot();
      if (shot) {
        downloadCanvasAsPng(shot, clipFilename(s.trade, 'png', 'chart'));
        this.showToast('Downloaded the chart \u2014 the full card capture wasn\u2019t available.');
      } else {
        this.showToast('Could not download right now.');
      }
    }
  },

  setupChart() {
    if (this.chart) this.chart.destroy();
    this.chart = new ReplayChart($('#chart-container'));
  },

  togglePlay() {
    const s = ReplayStateInstance;
    if (s.isPlaying) { s.pause(); this.stopTicker(); }
    else { s.play(); this.startTicker(); }
    this.updatePlayButton();
  },

  updatePlayButton() {
    const btn = $('#replay-play');
    btn.textContent = ReplayStateInstance.isPlaying ? 'Pause' : 'Play';
    btn.setAttribute('aria-label', ReplayStateInstance.isPlaying ? 'Pause replay' : 'Play replay');
  },

  startTicker() {
    this.stopTicker();
    const TICK_MS = 200; // wall-clock tick
    this.replayTimer = setInterval(() => {
      const s = ReplayStateInstance;
      if (!s.isPlaying) return;
      // Map replay speed to sim-time advance per tick. Base: 1x = 1 real minute per tick.
      const simMsPerTick = 60_000 * s.replaySpeed * (TICK_MS / 1000);
      s.step(simMsPerTick);
      this.renderReplayFrame();
      if (s.finished) {
        this.stopTicker();
        this.updatePlayButton();
        this.onTradeComplete();
      }
    }, TICK_MS);
  },

  stopTicker() {
    if (this.replayTimer) clearInterval(this.replayTimer);
    this.replayTimer = null;
  },

  stepEvent(direction) {
    const s = ReplayStateInstance;
    const events = s.timeline;
    if (!events.length) return;
    const idx = events.findIndex((e) => e.timestamp > s.currentTimestamp);
    let target;
    if (direction > 0) {
      target = idx === -1 ? s.endTimestamp : events[idx].timestamp;
    } else {
      const priorEvents = events.filter((e) => e.timestamp < s.currentTimestamp);
      target = priorEvents.length ? priorEvents[priorEvents.length - 1].timestamp : s.startTimestamp;
    }
    s.seekTo(target);
    this.renderReplayFrame();
  },

  onTradeComplete() {
    this.showToast('Replay reached exit \u2014 trade analysis ready.');
    $('#trade-analysis').hidden = false;
    $('#trade-analysis').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  renderReplayFrame() {
    const s = ReplayStateInstance;
    if (!s.trade) return;
    const p = s.trade.position;

    this.chart.revealUpTo(s.currentTimestamp);

    // Seek slider + timestamp
    if (s.startTimestamp != null && s.endTimestamp != null && s.endTimestamp > s.startTimestamp) {
      const pct = ((s.currentTimestamp - s.startTimestamp) / (s.endTimestamp - s.startTimestamp)) * 1000;
      $('#replay-seek').value = String(Math.round(pct));
    }
    $('#replay-timestamp').textContent = s.currentTimestamp ? formatDateTime(s.currentTimestamp) : '\u2014';

    // Live metrics — §36
    setMetric('#m-pair', p.symbol);
    setMetric('#m-side', p.side);
    setMetric('#m-leverage', p.leverage != null ? p.leverage + 'x' : null);
    setMetric('#m-entry', formatPriceOrNull(p.entryPrice));
    setMetric('#m-current', formatPriceOrNull(s.currentPrice));
    setMetric('#m-exit', formatPriceOrNull(p.exitPrice));
    setMetric('#m-size', p.size);
    setMetricTag('#m-pnl', s.currentPnl, formatSignedCurrency);
    setMetricTag('#m-fees', s.currentFees, formatCurrency);
    setMetricTag('#m-funding', s.currentFunding, formatSignedCurrency);
    const net = calculateNetPnl(s.currentPnl, s.currentFees, s.currentFunding);
    setMetricTag('#m-net-pnl', net, formatSignedCurrency);
    setMetric('#m-liquidation', formatPriceOrNull(s.liquidationPrice));
    setMetricTag('#m-liq-distance', s.liquidationDistance, (v) => v.toFixed(2) + '%');
    const elapsed = (s.currentTimestamp != null && s.startTimestamp != null) ? s.currentTimestamp - s.startTimestamp : null;
    setMetric('#m-time-in-trade', elapsed != null ? formatDuration(elapsed) : null);

    // Orders / executions panels — §33, §34
    renderOrdersPanel(s.visibleOrders);
    renderExecutionsPanel(s.visibleExecutions);

    // Event timeline — §35
    renderTimelinePanel(s.timeline, s.currentTimestamp, (ts) => { s.seekTo(ts); this.renderReplayFrame(); });

    // Entry/exit banners — §31, §32
    const entryReached = s.currentTimestamp >= (p.openTimestamp ?? -Infinity);
    $('#entry-banner').hidden = !entryReached;
    if (entryReached) {
      $('#entry-banner-price').textContent = formatPrice(p.entryPrice);
      $('#entry-banner-side').textContent = `${p.side || ''} ${p.leverage ? p.leverage + 'x' : ''}`.trim();
    }
    const exitReached = p.closeTimestamp != null && s.currentTimestamp >= p.closeTimestamp;
    $('#exit-banner').hidden = !exitReached;
    if (exitReached) $('#exit-banner-price').textContent = formatPrice(p.exitPrice);

    if (exitReached && !this.analytics) {
      this.analytics = calculateTradeAnalytics(s.trade, s.candles.filter((c) => c.timeMs <= p.closeTimestamp));
      renderTradeAnalysis(this.analytics, s.trade);
      $('#trade-analysis').hidden = false;
    }
  },

  teardownReplay() {
    this.stopTicker();
    if (this.chart) { this.chart.destroy(); this.chart = null; }
    ReplayStateInstance.reset();
  },

  shareReplay() {
    const url = `${window.location.origin}${window.location.pathname}?wallet=${encodeURIComponent(this.wallet)}&trade=${encodeURIComponent(ReplayStateInstance.trade.id)}`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => this.showToast('Replay link copied to clipboard.'));
    } else {
      this.showToast(url);
    }
  },
};

/* ---- helpers used only within app.js ---- */
async function softLoad(fn) {
  try { return await fn(); } catch (err) { console.warn('Optional load failed:', err); return null; }
}

function normalizeList(raw, normalizer) {
  const arr = Array.isArray(raw) ? raw : raw?.list || raw?.items || [];
  return arr.map(normalizer).filter(Boolean);
}

function netPnlValue(trade) {
  const p = trade.position;
  if (p.realizedPnl == null) return 0;
  const fees = p.fees ?? 0;
  const funding = p.funding ?? 0;
  return p.realizedPnl - Math.abs(fees) + funding;
}

/**
 * Trade volume for the summary strip and totals. Uses PopDEX's own reported
 * volume field when the API provides one (guaranteed to match their site);
 * otherwise falls back to the position's full notional turnover — entry leg
 * plus exit leg, not just the opening notional — which is the standard way
 * exchanges count a closed position's volume.
 */
function tradeVolumeValue(trade) {
  const p = trade.position;
  if (p.volume != null) return p.volume;
  const size = p.size ?? 0;
  const entryNotional = (p.entryPrice ?? 0) * size;
  const exitNotional = (p.exitPrice ?? 0) * size;
  return entryNotional + exitNotional;
}

function duration(trade) {
  const p = trade.position;
  if (p.openTimestamp == null || p.closeTimestamp == null) return 0;
  return p.closeTimestamp - p.openTimestamp;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---- clip download helpers ---- */
function clipFilename(trade, ext, variant) {
  const sym = (trade.position.symbol || 'trade').replace(/[^a-z0-9]/gi, '_');
  const suffix = variant ? `-${variant}` : '';
  return `popdex-replay-${sym}-${trade.position.side || ''}${suffix}.${ext}`;
}

/**
 * Maps a trade's real duration to a clip length between 15s and 30s \u2014
 * a two-minute scalp gets a tight 15s recap, a multi-hour-or-longer swing
 * trade gets the full 30s. Log-scaled since trade durations range from
 * minutes to days.
 */
function targetClipSeconds(tradeDurationMs) {
  const minutes = Math.max((tradeDurationMs || 0) / 60_000, 0);
  const TWO_DAYS_MIN = 2880;
  const t = Math.log10(minutes + 1) / Math.log10(TWO_DAYS_MIN + 1);
  const clamped = Math.min(Math.max(t, 0), 1);
  return Math.round(15 + clamped * 15);
}

/**
 * Burns a persistent Entry / Exit strip onto a desktop frame so both are
 * always readable in the finished clip, rather than only flashing on
 * screen for the instant the playhead happens to cross them live.
 */
function drawEntryExitOverlay(ctx, w, h, trade) {
  const p = trade.position;
  const TEXT_0 = '#f2f4f7';
  const TEXT_2 = '#7c8794';
  const UP = '#1fd67a';
  const DOWN = '#ff4d5e';
  const FONT = 'Arial, sans-serif';
  const barH = 56;

  ctx.fillStyle = 'rgba(10,12,16,0.88)';
  ctx.fillRect(0, 0, w, barH);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  ctx.moveTo(0, barH);
  ctx.lineTo(w, barH);
  ctx.stroke();

  const entryPrice = formatPriceOrNull(p.entryPrice) || '\u2014';
  const exitPrice = formatPriceOrNull(p.exitPrice) || '\u2014';
  const entryTime = p.openTimestamp != null ? formatTime(p.openTimestamp) : '\u2014';
  const exitTime = p.closeTimestamp != null ? formatTime(p.closeTimestamp) : '\u2014';
  // The clip's final result, not the live mid-replay PnL \u2014 a recap
  // should always summarize the same finished trade, frame to frame.
  const net = netPnlValue(trade);

  const midY = barH / 2;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  ctx.font = `700 18px ${FONT}`;
  ctx.fillStyle = UP;
  ctx.fillText('ENTRY', 24, midY);
  ctx.fillStyle = TEXT_0;
  ctx.font = `600 18px ${FONT}`;
  ctx.fillText(`${entryPrice}  \u00b7  ${entryTime}`, 24 + 66, midY);

  ctx.font = `700 18px ${FONT}`;
  ctx.fillStyle = DOWN;
  ctx.fillText('EXIT', w / 2 + 24, midY);
  ctx.fillStyle = TEXT_0;
  ctx.font = `600 18px ${FONT}`;
  ctx.fillText(`${exitPrice}  \u00b7  ${exitTime}`, w / 2 + 24 + 58, midY);

  ctx.textAlign = 'right';
  ctx.font = `700 20px ${FONT}`;
  ctx.fillStyle = net > 0 ? UP : net < 0 ? DOWN : TEXT_2;
  ctx.fillText(`NET PNL ${formatSignedCurrency(net)}`, w - 24, midY);
}

/** Best available high-quality video mime type this browser can actually encode. */
function pickVideoMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  return [
    'video/mp4;codecs=avc1.640028',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ].find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

/**
 * Composites one already-captured desktop frame (the expensive part \u2014
 * rendered once and reused) into a 9:16 "mobile" frame: the chart cropped
 * out of that same bitmap on top, and a crisp, directly-drawn (not
 * rasterized) info band with the live pair/side/price/PnL underneath. Reads
 * current values straight off the DOM metric elements, which renderReplayFrame
 * has already updated for this same tick.
 */
function drawMobileFrame(ctx, frameBitmap, chartCrop, mobileW, mobileH, trade) {
  const BG = '#0E0E0E';
  const BAND_BG = '#171819';
  const TEXT_0 = '#f2f4f7';
  const TEXT_2 = '#7c8794';
  const ACCENT = '#4c9be8';
  const UP = '#1fd67a';
  const DOWN = '#ff4d5e';
  const FONT = 'Arial, sans-serif';

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, mobileW, mobileH);

  // Top brand strip
  const topBar = 90;
  ctx.fillStyle = TEXT_2;
  ctx.font = `600 30px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.fillText('PopDEX \u00b7 Trade Replay', 40, topBar / 2);

  // Chart, cropped straight out of the already-rendered frame \u2014 no extra
  // rasterization work. Given a bit more of the frame than before so the
  // chart reads as the dominant element, with the data band underneath
  // proportioned to match rather than feeling like an afterthought.
  const chartBandTop = topBar;
  const chartBandH = Math.round(mobileH * 0.54);
  if (chartCrop.w > 0 && chartCrop.h > 0) {
    const destAspect = mobileW / chartBandH;
    const srcAspect = chartCrop.w / chartCrop.h;
    let sx = chartCrop.x, sy = chartCrop.y, sw = chartCrop.w, sh = chartCrop.h;
    // Crop to fill (cover), rather than letterbox, so the chart reads clearly.
    if (srcAspect > destAspect) {
      const newSw = sh * destAspect;
      sx += (sw - newSw) / 2;
      sw = newSw;
    } else {
      const newSh = sw / destAspect;
      sy += (sh - newSh) / 2;
      sh = newSh;
    }
    ctx.drawImage(frameBitmap, sx, sy, sw, sh, 0, chartBandTop, mobileW, chartBandH);
  }

  // Info band
  const bandTop = chartBandTop + chartBandH;
  const bandH = mobileH - bandTop;
  ctx.fillStyle = BAND_BG;
  ctx.fillRect(0, bandTop, mobileW, bandH);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  ctx.moveTo(0, bandTop);
  ctx.lineTo(mobileW, bandTop);
  ctx.stroke();

  const p = trade?.position || {};
  const pair = $('#m-pair')?.textContent || p.symbol || '\u2014';
  const side = $('#m-side')?.textContent || p.side || '\u2014';
  const current = $('#m-current')?.textContent || '\u2014';
  const netEl = $('#m-net-pnl');
  const netPnl = netEl?.textContent || formatSignedCurrency(netPnlValue(trade));
  const netColor = netEl?.classList.contains('positive') ? UP
    : netEl?.classList.contains('negative') ? DOWN
    : (netPnlValue(trade) > 0 ? UP : netPnlValue(trade) < 0 ? DOWN : TEXT_0);
  const sideColor = /short/i.test(side) ? DOWN : /long/i.test(side) ? UP : ACCENT;

  const entryPrice = formatPriceOrNull(p.entryPrice) || '\u2014';
  const exitPrice = formatPriceOrNull(p.exitPrice) || '\u2014';
  const entryTime = p.openTimestamp != null ? formatTime(p.openTimestamp) : '\u2014';
  const exitTime = p.closeTimestamp != null ? formatTime(p.closeTimestamp) : '\u2014';
  const leverage = p.leverage != null ? p.leverage + 'x' : '\u2014';
  const fees = p.fees != null ? formatCurrency(p.fees) : '\u2014';
  const tradeDurationMs = duration(trade);
  const tradeDuration = tradeDurationMs ? formatDuration(tradeDurationMs) : '\u2014';

  const leftX = 40;
  const rightX = mobileW / 2 + 20;
  const rowGap = 130;
  // Content starts a bit further down from the chart/band divider than
  // before, so the data doesn't feel jammed up against the chart.
  let y = bandTop + 96;

  // Pair + side
  ctx.textAlign = 'left';
  ctx.fillStyle = TEXT_0;
  ctx.font = `700 52px ${FONT}`;
  ctx.fillText(pair, leftX, y);
  ctx.textAlign = 'right';
  ctx.fillStyle = sideColor;
  ctx.font = `700 40px ${FONT}`;
  ctx.fillText(side.toUpperCase(), mobileW - 40, y);

  // Entry (left column) / Exit (right column)
  y += rowGap;
  ctx.textAlign = 'left';
  ctx.fillStyle = UP;
  ctx.font = `700 24px ${FONT}`;
  ctx.fillText('ENTRY', leftX, y - 30);
  ctx.fillStyle = DOWN;
  ctx.fillText('EXIT', rightX, y - 30);
  ctx.fillStyle = TEXT_0;
  ctx.font = `600 32px ${FONT}`;
  ctx.fillText(entryPrice, leftX, y);
  ctx.fillText(exitPrice, rightX, y);
  ctx.fillStyle = TEXT_2;
  ctx.font = `400 24px ${FONT}`;
  ctx.fillText(entryTime, leftX, y + 32);
  ctx.fillText(exitTime, rightX, y + 32);

  // Current price (left column) / Net PnL (right column)
  y += rowGap;
  ctx.fillStyle = TEXT_2;
  ctx.font = `400 24px ${FONT}`;
  ctx.fillText('CURRENT', leftX, y - 30);
  ctx.fillText('NET PNL', rightX, y - 30);
  ctx.fillStyle = TEXT_0;
  ctx.font = `700 38px ${FONT}`;
  ctx.fillText(current, leftX, y);
  ctx.fillStyle = netColor;
  ctx.fillText(netPnl, rightX, y);

  // Leverage (left column) / Fees (right column) \u2014 previously missing
  // from the phone card entirely.
  y += rowGap;
  ctx.fillStyle = TEXT_2;
  ctx.font = `400 24px ${FONT}`;
  ctx.fillText('LEVERAGE', leftX, y - 30);
  ctx.fillText('FEES', rightX, y - 30);
  ctx.fillStyle = TEXT_0;
  ctx.font = `700 34px ${FONT}`;
  ctx.fillText(leverage, leftX, y);
  ctx.fillText(fees, rightX, y);

  // Duration \u2014 also previously missing, given its own full-width row.
  y += rowGap - 20;
  ctx.fillStyle = TEXT_2;
  ctx.font = `400 24px ${FONT}`;
  ctx.fillText('DURATION', leftX, y - 30);
  ctx.fillStyle = TEXT_0;
  ctx.font = `700 34px ${FONT}`;
  ctx.fillText(tradeDuration, leftX, y);
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function downloadCanvasAsPng(canvas, filename) {
  if (!canvas || !canvas.toBlob) return;
  canvas.toBlob((blob) => { if (blob) downloadBlob(blob, filename); }, 'image/png');
}

function setMetric(sel, value) {
  $(sel).textContent = (value === null || value === undefined || value === '') ? '\u2014' : value;
}

function setMetricTag(sel, tagged, formatter) {
  const el = $(sel);
  if (!tagged || tagged.src === SRC.NONE) {
    el.textContent = 'Unavailable';
    el.classList.remove('positive', 'negative');
    el.classList.add('unavailable');
    return;
  }
  el.classList.remove('unavailable');
  el.textContent = formatter(tagged.value);
  el.classList.toggle('positive', tagged.value > 0);
  el.classList.toggle('negative', tagged.value < 0);
}

function renderOrdersPanel(orders) {
  const el = $('#orders-panel');
  // These panels only grow/shrink when a new order actually enters (or a
  // rewind drops out of) view — on every other tick the list is identical
  // to last frame, so skip the innerHTML rebuild rather than re-stringifying
  // and re-parsing the same rows 5x/sec while playing.
  if (el.dataset.count === String(orders.length)) return;
  el.dataset.count = String(orders.length);
  if (!orders.length) { el.innerHTML = `<div class="empty-inline">No order history available.</div>`; return; }
  el.innerHTML = orders.map((o) => `
    <div class="mini-row">
      <span class="mini-row__time">${formatTime(o.timestamp)}</span>
      <span class="side-badge side-badge--${(o.side || '').toLowerCase()}">${o.side || '\u2014'}</span>
      <span>${o.orderType || '\u2014'}</span>
      <span>${formatPriceOrNull(o.price) ?? '\u2014'}</span>
      <span>${o.quantity ?? '\u2014'}</span>
      <span>${o.status || '\u2014'}</span>
    </div>
  `).join('');
}

function renderExecutionsPanel(fills) {
  const el = $('#executions-panel');
  if (el.dataset.count === String(fills.length)) return;
  el.dataset.count = String(fills.length);
  if (!fills.length) { el.innerHTML = `<div class="empty-inline">No execution history available.</div>`; return; }
  el.innerHTML = fills.map((f) => `
    <div class="mini-row">
      <span class="mini-row__time">${formatTime(f.timestamp)}</span>
      <span class="side-badge side-badge--${(f.side || '').toLowerCase()}">${f.side || '\u2014'}</span>
      <span>${formatPriceOrNull(f.price) ?? '\u2014'}</span>
      <span>${f.quantity ?? '\u2014'}</span>
      <span>${f.fee != null ? formatCurrency(f.fee) : '\u2014'}</span>
    </div>
  `).join('');
}

function renderTimelinePanel(events, currentTs, onSeek) {
  const el = $('#event-timeline');
  if (!events.length) { el.innerHTML = `<div class="empty-inline">No events available for this trade.</div>`; el._builtForEvents = null; return; }

  // `events` (ReplayState.timeline) is the same array reference for the
  // whole trade — it only changes on a new trade load. Rebuilding every
  // button (plus re-attaching a click listener to each) 5x/sec while
  // playing was pure DOM churn for no visual change; only the "is-passed"
  // class actually needs to move each tick.
  if (el._builtForEvents !== events) {
    el.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const e of events) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'timeline-event';
      item.dataset.ts = String(e.timestamp);
      item.innerHTML = `<span class="timeline-event__time">${formatTime(e.timestamp)}</span><span class="timeline-event__label">${e.type}</span>`;
      item.addEventListener('click', () => onSeek(e.timestamp));
      frag.appendChild(item);
    }
    el.appendChild(frag);
    el._builtForEvents = events;
  }

  for (const child of el.children) {
    child.classList.toggle('is-passed', Number(child.dataset.ts) <= currentTs);
  }
}

function renderTradeAnalysis(a, trade) {
  const el = $('#trade-analysis-grid');
  const rows = [
    ['Entry Price', a.entryPrice, formatPriceOrNull],
    ['Exit Price', a.exitPrice, formatPriceOrNull],
    ['Gross PnL', a.grossPnl, formatSignedCurrency],
    ['Fees', a.fees, formatCurrency],
    ['Funding', a.funding, formatSignedCurrency],
    ['Net PnL', a.netPnl, formatSignedCurrency],
    ['Trade Duration', a.duration, formatDuration],
    ['Maximum Favorable Excursion', a.mfe, formatSignedCurrency],
    ['Maximum Adverse Excursion', a.mae, formatSignedCurrency],
    ['Maximum Drawdown', a.maxDrawdown, formatCurrency],
    ['Best Unrealized PnL', a.bestUnrealized, formatSignedCurrency],
    ['Worst Unrealized PnL', a.worstUnrealized, formatSignedCurrency],
    ['Number of Orders', a.numOrders, (v) => String(v)],
    ['Number of Fills', a.numFills, (v) => String(v)],
    ['Minimum Liquidation Distance', a.minLiquidationDistance, (v) => v.toFixed(2) + '%'],
  ];
  el.innerHTML = rows.map(([label, t, fmt]) => `
    <div class="analysis-cell">
      <div class="analysis-cell__label">${label}</div>
      <div class="analysis-cell__value ${t.src === SRC.NONE ? 'unavailable' : (t.value > 0 ? 'positive' : t.value < 0 ? 'negative' : '')}">
        ${t.src === SRC.NONE ? 'Unavailable' : fmt(t.value)}
        ${t.src === SRC.CALC ? '<span class="calc-badge" title="Calculated from PopDEX data">calc</span>' : ''}
      </div>
    </div>
  `).join('');

  const insights = generateInsights(a, trade);
  const insightsEl = $('#learning-insights');
  insightsEl.innerHTML = insights.length
    ? insights.map((i) => `<li>${i}</li>`).join('')
    : '<li class="empty-inline">Not enough data to generate insights for this trade.</li>';
}

/* ---- formatting ---- */
function shortenAddress(addr) {
  if (!addr) return '\u2014';
  return addr.length > 14 ? `${addr.slice(0, 6)}\u2026${addr.slice(-4)}` : addr;
}
function formatPrice(v) { return v == null ? '\u2014' : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`; }
function formatPriceOrNull(v) { return v == null ? null : formatPrice(v); }
function formatCurrency(v) { return v == null ? '\u2014' : `$${Math.abs(Number(v)).toLocaleString(undefined, { maximumFractionDigits: 2 })}`; }
function formatSignedCurrency(v) {
  if (v == null) return '\u2014';
  const sign = v > 0 ? '+' : v < 0 ? '\u2212' : '';
  return `${sign}$${Math.abs(Number(v)).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
function formatDate(ms) { return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
function formatTime(ms) { return ms == null ? '\u2014' : new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function formatDateTime(ms) { return `${formatDate(ms)} ${formatTime(ms)}`; }

document.addEventListener('DOMContentLoaded', () => {
  const ReplayStateInstance = new ReplayState();
  window.ReplayStateInstance = ReplayStateInstance;
  App.init();
});

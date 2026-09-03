/* =========================================================================
   CHART — thin wrapper around Lightweight Charts (loaded via CDN)
   Handles progressive candle reveal, markers, and the liquidation price line.
   ========================================================================= */
function toBar(c) {
  return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
}

class ReplayChart {
  constructor(container) {
    this.container = container;
    this.chart = LightweightCharts.createChart(container, {
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: '#9aa4b2',
        fontFamily: 'Arial, sans-serif',
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        autoScale: true,              // stays auto until you drag the axis; dragging turns this off automatically
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      // Make every interaction explicit instead of relying on library defaults —
      // dragging the right price scale up/down, mouse-wheel zoom, and vertical
      // scroll/pinch all need to work with the mouse cursor, not just pan sideways.
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      autoSize: true,
    });

    this.series = this.chart.addCandlestickSeries({
      upColor: '#1fd67a',
      downColor: '#ff4d5e',
      borderVisible: false,
      wickUpColor: '#1fd67a',
      wickDownColor: '#ff4d5e',
    });

    this.liqLine = null;
    this.entryLine = null;
    this.exitLine = null;
    this._revealedIndex = -1;   // last candle index handed to the series
    this._revealedTs = null;
  }

  setFullPath(candles) {
    this._fullCandles = candles;
    this._revealedIndex = -1;   // new dataset — next reveal does a full (re)build
    this._revealedTs = null;
  }

  /**
   * Progressively reveal candles up to (and including) currentTimestamp.
   * On fine timeframes (1m) over long trades this runs up to 5x/sec while
   * playing, so it has to stay cheap: normal forward playback only pushes
   * the *newly* crossed candles onto the series via update() instead of
   * re-filtering the whole array and replacing the whole series with
   * setData() every tick — that full-rebuild was the source of the
   * lag/stutter at fine timeframes and higher speeds. A full rebuild only
   * happens on the first reveal after a load/timeframe change, or when
   * seeking backward (rewind, dragging the seek bar left).
   */
  revealUpTo(timestampMs) {
    const arr = this._fullCandles;
    if (!arr) return;

    const seekingBackward = this._revealedIndex !== -1 && this._revealedTs != null && timestampMs < this._revealedTs;

    if (this._revealedIndex === -1 || seekingBackward) {
      let idx = -1;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].timeMs <= timestampMs) idx = i; else break;
      }
      const visible = arr.slice(0, idx + 1).map(toBar);
      this.series.setData(visible);
      this._revealedIndex = idx;
    } else {
      let idx = this._revealedIndex;
      while (idx + 1 < arr.length && arr[idx + 1].timeMs <= timestampMs) {
        idx++;
        this.series.update(toBar(arr[idx]));
      }
      this._revealedIndex = idx;
    }
    this._revealedTs = timestampMs;
    this._followPlayhead(this._revealedIndex);
  }

  /**
   * Keeps the current playhead inside the visible window as the replay
   * plays, instead of leaving the view locked to wherever fitToFullRange
   * first put it. Only matters on long trades, where the initial view is a
   * centered window narrower than the full dataset (see fitToFullRange) —
   * without this, playback would keep revealing candles the view never
   * pans to follow, so the trade's later progress runs invisibly off the
   * right edge. Pans the window forward/back by the minimum needed to keep
   * the playhead a small margin inside the edge, rather than recentering
   * on every tick, so it doesn't fight the person if they manually scroll
   * or zoom mid-playback.
   */
  _followPlayhead(idx) {
    if (idx < 0) return;
    const range = this.chart.timeScale().getVisibleLogicalRange();
    if (!range) return;
    const width = range.to - range.from;
    const margin = Math.max(1, width * 0.08);
    if (idx > range.to - margin) {
      const shift = idx - (range.to - margin);
      this.chart.timeScale().setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
    } else if (idx < range.from + margin) {
      const shift = (range.from + margin) - idx;
      this.chart.timeScale().setVisibleLogicalRange({ from: range.from - shift, to: range.to - shift });
    }
  }

  setEntryLine(price) {
    if (price == null) return;
    if (this.entryLine) this.series.removePriceLine(this.entryLine);
    this.entryLine = this.series.createPriceLine({
      price, color: '#1fd67a', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, title: 'ENTRY',
    });
  }

  setExitLine(price) {
    if (price == null) return;
    if (this.exitLine) this.series.removePriceLine(this.exitLine);
    this.exitLine = this.series.createPriceLine({
      price, color: '#9aa4b2', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, title: 'EXIT',
    });
  }

  setLiquidationLine(price) {
    if (this.liqLine) { this.series.removePriceLine(this.liqLine); this.liqLine = null; }
    if (price == null) return;
    this.liqLine = this.series.createPriceLine({
      price, color: '#ff4d5e', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Solid, title: 'LIQUIDATION',
    });
  }

  /**
   * Fill markers ('FILL' pin per execution) used to be silently dead code:
   * normalizeFill's timestamp field (core.js) was reading a field PopDEX's
   * real API doesn't return, so every fill had timestamp === null and the
   * `if (f.timestamp == null) continue;` guard below dropped all of them —
   * nothing ever rendered. Fixing that timestamp field (a separate, correct
   * fix, needed for Fee Analytics' Maker/Taker + Funding sections to work
   * at all) means fills now parse correctly — which surfaced this: a
   * position with many partial executions gets a same-labeled 'FILL' pin
   * stacked on almost every candle, which is just noise, not information —
   * every one of these fills is already listed with its exact time, side,
   * price, quantity, and fee in the Executions panel below the chart (see
   * renderExecutionsPanel in app.js). So: no per-fill markers on the chart
   * itself, only the two that actually mark position boundaries.
   */
  setMarkers({ orders = [], entryTs, exitTs }) {
    const markers = [];
    if (entryTs != null) {
      markers.push({ time: Math.floor(entryTs / 1000), position: 'belowBar', color: '#1fd67a', shape: 'arrowUp', text: 'ENTRY' });
    }
    for (const o of orders) {
      if (o.timestamp == null) continue;
      markers.push({
        time: Math.floor(o.timestamp / 1000),
        position: o.side === 'SELL' ? 'aboveBar' : 'belowBar',
        color: '#e8b34c',
        shape: 'circle',
        text: `${o.orderType || 'ORDER'} ${o.side || ''}`.trim(),
      });
    }
    if (exitTs != null) {
      markers.push({ time: Math.floor(exitTs / 1000), position: 'aboveBar', color: '#ff4d5e', shape: 'arrowDown', text: 'EXIT' });
    }
    markers.sort((a, b) => a.time - b.time);
    this.series.setMarkers(markers);
  }

  fitContent() { this.chart.timeScale().fitContent(); }

  /**
   * Sets the initial view across the whole fetched (padded) candle range
   * instead of whatever's currently revealed — on a fresh load only the
   * entry candle has been revealed, so a plain fitContent() would zoom in
   * on that single candle and blow it up to fill the pane.
   *
   * Earlier versions of this either centered the view on the entry candle
   * with padding split on both sides, stretched it out to a fixed
   * pixel-width target, or — once that was fixed for short trades — always
   * crammed the *entire* dataset into view once there were "enough" bars to
   * be thin. That last case broke down on genuinely long trades: a 24h+
   * trade even at a coarse interval can still be hundreds of bars, and
   * squeezing all of them into one container width is exactly how you get
   * sub-pixel, unreadable "microscopic" candles.
   *
   * A first pass at shifting entry rightward biased the two cases
   * (short-trade padding vs. long-trade window) with different, small
   * multipliers — which barely moved a short trade's candles at all, since
   * the padding was sized off the trade's own tiny bar count instead of the
   * frame. Both cases now share one ENTRY_X_FRACTION applied the same way,
   * so a 5-candle trade gets pushed just as far right as a 500-candle one.
   */
  fitToFullRange(centerTsMs) {
    const arr = this._fullCandles;
    if (!arr || !arr.length) return;

    const containerWidth = this.container.clientWidth || 600;
    const TARGET_BAR_PX = 7;      // desired on-screen candle+gap width
    const MIN_VISIBLE_BARS = 24;  // floor so a tiny/hidden container doesn't over-zoom
    const desiredBars = Math.max(MIN_VISIBLE_BARS, Math.round(containerWidth / TARGET_BAR_PX));

    // Horizontal placement of the entry candle in the frame: 0 = flush
    // against the left edge, 1 = flush against the right edge. 0.5 centers
    // it, so the chart opens with roughly equal empty space on both sides
    // instead of starting flush against the left/extreme edge.
    const ENTRY_X_FRACTION = 0.5;

    const dataLen = arr.length;
    let centerIdx = Math.floor((dataLen - 1) / 2);
    if (centerTsMs != null) {
      const centerSec = Math.floor(centerTsMs / 1000);
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].time <= centerSec) centerIdx = i; else break;
      }
    }

    if (dataLen <= desiredBars) {
      // Fewer real candles than the box could show thinly. Give the
      // dataset a natural-sized window (roughly 1.6x the trade's own bar
      // count, not stretched to the full box width) rather than cramming
      // it edge-to-edge — but split that window using the SAME
      // ENTRY_X_FRACTION as the long-trade case below, so short trades get
      // an equally strong rightward push instead of one sized off their
      // own (tiny) bar count.
      const MIN_PADDING_BARS = 8;
      const windowBars = dataLen + Math.max(MIN_PADDING_BARS, Math.round(dataLen * 0.6));
      const from = centerIdx - windowBars * ENTRY_X_FRACTION;
      const to = centerIdx + windowBars * (1 - ENTRY_X_FRACTION);
      this.chart.timeScale().setVisibleLogicalRange({ from, to });
      return;
    }

    // More real candles than the box can show at a readable width. Window a
    // desiredBars-wide slice around the entry candle rather than cramming
    // the whole dataset in — the rest is a scroll/zoom-out away.
    let from = centerIdx - desiredBars * ENTRY_X_FRACTION;
    let to = centerIdx + desiredBars * (1 - ENTRY_X_FRACTION);
    // Keep the window inside the actual data range instead of padding out
    // into blank space when entry sits near either edge of it.
    if (from < 0) { to -= from; from = 0; }
    if (to > dataLen - 1) { from -= (to - (dataLen - 1)); to = dataLen - 1; }
    this.chart.timeScale().setVisibleLogicalRange({ from, to });
  }

  /** Full chart (all panes/price scale/time scale baked in) as a canvas — used for clip recording and snapshot downloads. */
  takeScreenshot() {
    return this.chart.takeScreenshot();
  }

  destroy() {
    this.chart.remove();
  }
}

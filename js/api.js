/* =========================================================================
   PopDEX API CLIENT
   Base: https://api.popdex.xyz
   Every request goes through `request()`, which:
     - inspects HTTP status
     - inspects the `code` field inside the response envelope
     - never assumes HTTP 200 === application success
     - throws a normalized ApiError the rest of the app can render
   Only the endpoints confirmed in the build spec are implemented.
   Nothing here invents an endpoint or a field.
   ========================================================================= */

// Routed through the local proxy (proxy_server.py) so the browser talks to
// the same origin it was served from, instead of api.popdex.xyz directly.
// This avoids the browser CORS block that causes "Could not reach PopDEX".
const API_BASE = '';

/* ---- HTTP status -> friendly message ---- */
const HTTP_ERROR_MESSAGES = {
  400: 'The request was malformed.',
  401: 'Authentication is required for this data.',
  403: 'Access to this data is forbidden.',
  404: 'That resource could not be found.',
  405: 'That request method is not allowed.',
  429: 'PopDEX is rate limiting requests right now.',
  500: 'PopDEX had an internal error.',
  502: 'PopDEX gateway is temporarily unavailable.',
  503: 'PopDEX service is temporarily unavailable.',
  504: 'PopDEX gateway timed out.',
};

/* ---- Application error codes (from the response envelope) -> friendly message ---- */
const APP_ERROR_MESSAGES = {
  50000: 'A required parameter is missing.',
  50001: 'Access to this endpoint was denied.',
  50002: 'One or more parameters failed validation.',
  50003: 'That wallet address is invalid.',
  50004: 'The requested time window is too large.',
  50005: 'That API does not exist.',
  50006: 'That method is not allowed.',
  50009: 'Rate limit exceeded — please slow down.',
  50010: 'This IP has been blocked by PopDEX.',
  50011: 'API quota has been exhausted.',
  50012: 'The request was rejected by a security policy.',
  50014: 'The upstream service timed out.',
  50015: 'The upstream service is unavailable.',
  50016: 'PopDEX had an internal error.',
  60000: 'One or more parameters are invalid.',
  60001: 'That address is invalid.',
  60002: 'Access was denied.',
  60003: 'That account could not be found.',
  60005: 'The session token is invalid.',
  60006: 'The session has expired.',
  60007: 'The login nonce is invalid.',
  60008: 'The login nonce has expired.',
  60009: 'The login signature is invalid.',
  60010: 'PopDEX had an internal error.',
  61000: 'One or more required parameters are missing.',
  61001: 'One or more parameters are invalid.',
  61002: 'That business type is invalid.',
  61003: 'That sub-business type is invalid.',
  61004: 'The query failed.',
  61005: 'PopDEX had an internal error.',
};

class ApiError extends Error {
  constructor({ message, kind, httpStatus = null, appCode = null }) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind; // 'http' | 'application' | 'network' | 'parse'
    this.httpStatus = httpStatus;
    this.appCode = appCode;
  }
}

function friendlyHttpMessage(status) {
  return HTTP_ERROR_MESSAGES[status] || `Request failed (HTTP ${status}).`;
}

function friendlyAppMessage(code, msg) {
  return APP_ERROR_MESSAGES[code] || msg || `PopDEX returned an error (code ${code}).`;
}

/** Special-cased friendly copy for the invalid-wallet case called out in the spec. */
function isInvalidWalletError(err) {
  return err instanceof ApiError && (err.appCode === 50003 || err.appCode === 60001);
}

function buildQuery(params = {}) {
  const usable = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!usable.length) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of usable) qs.set(k, v);
  return `?${qs.toString()}`;
}

/**
 * Core request function. Resolves with `data.data` (the payload) on success.
 * Rejects with an ApiError on any HTTP or application-level failure.
 * Pass `envelope: true` to get the full `{ code, data, cursor, total, ... }`
 * body back instead of just `data` — needed by callers (like pagination)
 * that have to read sibling fields such as `cursor`, which live next to
 * `data` in the envelope, not inside it.
 */
async function request(path, params = {}, { cache: useCache = true, envelope = false } = {}) {
  const url = `${API_BASE}${path}${buildQuery(params)}`;
  const cacheKey = envelope ? `envelope:${url}` : url;

  if (useCache && ApiCache.has(cacheKey)) {
    return ApiCache.get(cacheKey);
  }

  let res;
  try {
    res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  } catch (networkErr) {
    throw new ApiError({
      message: 'Could not reach PopDEX. Check your connection and try again.',
      kind: 'network',
    });
  }

  if (!res.ok) {
    // Still attempt to read a body — PopDEX may include a `code`/`msg` even on non-200s.
    let body = null;
    try { body = await res.json(); } catch (_) { /* not JSON, fall through to HTTP message */ }
    if (body && !isSuccessCode(body.code)) {
      throw new ApiError({
        message: friendlyAppMessage(body.code, body.msg),
        kind: 'application',
        httpStatus: res.status,
        appCode: normalizeCode(body.code),
      });
    }
    throw new ApiError({
      message: friendlyHttpMessage(res.status),
      kind: 'http',
      httpStatus: res.status,
    });
  }

  let body;
  try {
    body = await res.json();
  } catch (parseErr) {
    throw new ApiError({ message: 'PopDEX returned a malformed response.', kind: 'parse' });
  }

  if (body.code === undefined || body.code === null || body.code === '') {
    throw new ApiError({ message: 'PopDEX returned an unexpected response shape.', kind: 'parse' });
  }

  if (!isSuccessCode(body.code)) {
    throw new ApiError({
      message: friendlyAppMessage(body.code, body.msg),
      kind: 'application',
      httpStatus: res.status,
      appCode: normalizeCode(body.code),
    });
  }

  const payload = envelope ? body : body.data;
  if (useCache) ApiCache.set(cacheKey, payload);
  return payload;
}

/**
 * PopDEX's live API returns `code` as a string (observed: "200" for success),
 * not the number 0 the original spec/docs described. Accept both shapes so
 * the app doesn't treat every successful response as an error.
 */
function normalizeCode(code) {
  const n = Number(code);
  return Number.isNaN(n) ? code : n;
}
function isSuccessCode(code) {
  const n = normalizeCode(code);
  return n === 0 || n === 200;
}

/* =========================================================================
   API CACHE — avoids duplicate requests for immutable historical data
   ========================================================================= */
const ApiCache = {
  _store: new Map(),
  has(key) { return this._store.has(key); },
  get(key) { return this._store.get(key); },
  set(key, val) { this._store.set(key, val); },
  clear() { this._store.clear(); },
};

/* =========================================================================
   ENDPOINTS
   ========================================================================= */
const PopDexApi = {
  ApiError,
  isInvalidWalletError,

  /* ---- Market data ---- */
  fetchCandles({ category, symbol, interval, startTime, endTime, type, limit = 1000 }) {
    return request('/api/v1/public/market/candles', { category, symbol, interval, startTime, endTime, type, limit });
  },

  fetchHistoricalCandles({ category, symbol, interval, startTime, endTime, type, limit = 1000 }) {
    return request('/api/v1/market/history/candles', { category, symbol, interval, startTime, endTime, type, limit });
  },

  /**
   * Pages through the full candle history for the requested time window
   * instead of relying on one request — the same class of bug
   * fetchAllHistoricalPositions exists for below: the endpoint caps how
   * many candles it hands back per call, so a single request for a long
   * trade (which needs many bars) silently comes back truncated, covering
   * only the earliest slice of the window. That's what was leaving long
   * trades with just a handful of candles bunched at the very start of the
   * chart and nothing after — not a chart-rendering bug, a data one.
   *
   * Walks forward in time: each page starts right after the last candle
   * timestamp the previous page returned. Deliberately does NOT treat "got
   * fewer than `pageSize` rows back" as "that was the last page" — if the
   * server enforces its own hard cap below whatever `pageSize` we ask for
   * (exactly the scenario this exists to work around), every page would
   * look "short" relative to our request and we'd stop after page one,
   * silently reproducing the original bug. Instead it keeps paging on any
   * non-empty page that's still making forward progress, and only stops
   * once a page comes back empty, no forward progress is made, `endTime`
   * is reached, or a safety cap is hit so a misbehaving response can never
   * hang the tab.
   *
   * Candle rows are raw `[timestamp, open, high, low, close, ...]` arrays
   * (see normalizeCandle), not objects, so paging keys off row[0].
   */
  async fetchAllHistoricalCandles({ category, symbol, interval, startTime, endTime, type, pageSize = 1000, maxPages = 2000 }) {
    const all = [];
    const seen = new Set();
    let from = startTime;
    for (let page = 0; page < maxPages; page++) {
      if (from > endTime) break;
      const res = await request('/api/v1/market/history/candles', {
        category, symbol, interval, type, startTime: from, endTime, limit: pageSize,
      }, { cache: false });
      const list = Array.isArray(res) ? res : (res?.list || res?.items || []);
      if (!list.length) break;

      let lastTs = from;
      for (const row of list) {
        const ts = Array.isArray(row) ? Number(row[0]) : Number(row?.timestamp ?? row?.time ?? row?.t);
        if (!Number.isFinite(ts)) continue;
        if (seen.has(ts)) continue;
        seen.add(ts);
        all.push(row);
        if (ts > lastTs) lastTs = ts;
      }

      if (lastTs <= from) break; // no forward progress — bail instead of looping forever
      from = lastTs + 1;
    }
    return all;
  },

  fetchFundingRate({ symbol }) {
    return request('/api/v1/market/funding-rate', { symbol }, { cache: false });
  },

  fetchHistoricalFunding({ symbol, startTime, endTime, cursor, limit = 1000 }) {
    return request('/api/v1/market/history/funding-rate', { symbol, startTime, endTime, cursor, limit });
  },

  /* ---- Wallet / account data ---- */
  fetchPositions(walletId) {
    return request(`/api/v1/account/${encodeURIComponent(walletId)}/positions`, {}, { cache: false });
  },

  fetchHistoricalPositions(walletId, params = {}) {
    return request(`/api/v1/account/${encodeURIComponent(walletId)}/history/positions`, params);
  },

  /**
   * Pages through the full closed-position history for a wallet instead of
   * returning just the first page (the API defaults to a small page size,
   * which was capping the trade list at 20). Keeps requesting the next page
   * — using whichever cursor field PopDEX includes in the envelope — until
   * a page comes back empty, no cursor is given, or a safety cap is hit so
   * a malformed/looping cursor can never hang the page.
   *
   * The safety cap (maxPages/maxTotal) is intentionally huge, not a real
   * limit — it exists only to stop a buggy/looping API response from
   * freezing the tab forever. At the default page size that's ~2,000,000
   * trades, which no real account will ever reach; pagination itself has
   * no ceiling of its own and keeps going until PopDEX says there's
   * nothing left.
   *
   * De-dupes across pages by position identity: if a cursor ever points at
   * the last-seen record instead of strictly past it (a common off-by-one
   * pagination quirk), the boundary record gets returned on both pages —
   * every trade after that point would otherwise be double-counted, which
   * inflates Total Trades and Total Volume together.
   */
  async fetchAllHistoricalPositions(walletId, { pageSize = 200, onPage, maxPages = 10000, maxTotal = 2_000_000 } = {}) {
    const all = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < maxPages; page++) {
      // envelope: true — the pagination cursor lives on the response
      // envelope (sibling of `data`), not inside `data` itself. Reading it
      // off the unwrapped payload (the old behavior) always came back
      // undefined, so pagination silently stopped after page 1 for any
      // wallet with more closed trades than one page holds.
      const res = await request(
        `/api/v1/account/${encodeURIComponent(walletId)}/history/positions`,
        { cursor, limit: pageSize },
        { cache: false, envelope: true },
      );
      const list = Array.isArray(res?.data) ? res.data : (res?.data?.list || res?.data?.items || []);
      if (!list.length) break;
      for (const item of list) {
        const key = positionDedupeKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(item);
      }
      if (onPage) onPage(all.length);
      if (all.length >= maxTotal) break;
      const nextCursor = res?.nextPageCursor || res?.nextCursor || res?.cursor || res?.next_cursor || null;
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    return all;
  },

  fetchOrders(walletId, params = {}) {
    return request(`/api/v1/account/${encodeURIComponent(walletId)}/history/orders`, params);
  },

  fetchOrderDetails(walletId, orderId) {
    return request(`/api/v1/account/${encodeURIComponent(walletId)}/order/${encodeURIComponent(orderId)}`);
  },

  fetchFills(walletId, params = {}) {
    return request(`/api/v1/account/${encodeURIComponent(walletId)}/trade/fills`, params);
  },

  /**
   * Pages through the FULL fill history for a wallet over an arbitrary time
   * window (not scoped to a single trade), using the same cursor-following
   * pattern as fetchAllHistoricalPositions above. Used by Fee Analytics to
   * get real per-execution fee + maker/taker (`liquidity`) data instead of
   * only the per-position fee total — that's the only way to reconcile a
   * Maker/Taker split against Total Fees without inventing a ratio.
   */
  async fetchAllFills(walletId, { startTime, endTime, pageSize = 500, maxPages = 5000, maxTotal = 1_000_000 } = {}) {
    const all = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < maxPages; page++) {
      const res = await request(
        `/api/v1/account/${encodeURIComponent(walletId)}/trade/fills`,
        { startTime, endTime, cursor, limit: pageSize },
        { cache: false, envelope: true },
      );
      const list = Array.isArray(res?.data) ? res.data : (res?.data?.list || res?.data?.items || []);
      if (!list.length) break;
      for (const item of list) {
        // execId is the real, always-unique fill id PopDEX returns — see
        // normalizeFill in core.js. The old fallback chain here (fillId/id/
        // tradeId, none of which the real API sends) always missed, so
        // every fill fell through to the composite fallback key built from
        // timestamp/execPrice/execQty — and since `timestamp` was ALSO
        // wrong (missing createdAt), that key collapsed to
        // "undefined:<price>:<qty>", silently dropping every fill that
        // shared a price+quantity with an earlier one, which is common.
        const key = item.execId ?? item.fillId ?? item.id ?? item.tradeId
          ?? `${item.createdAt ?? item.timestamp ?? item.execTime ?? item.time}:${item.execPrice ?? item.price}:${item.execQty ?? item.qty}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(item);
      }
      if (all.length >= maxTotal) break;
      const nextCursor = res?.nextPageCursor || res?.nextCursor || res?.cursor || res?.next_cursor || null;
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    return all;
  },

  fetchAccountFunding(walletId, params = {}) {
    return request(`/api/v1/account/${encodeURIComponent(walletId)}/history/funding-rate`, params);
  },

  /**
   * Pages through the FULL account-level funding-payment history for a
   * wallet, same cursor pattern as fetchAllFills/fetchAllHistoricalPositions.
   * Gives Fee Analytics real per-event funding data so "Funding Paid" and
   * "Funding Received" can be classified from the actual sign of each
   * payment instead of approximated from a per-trade net.
   */
  async fetchAllAccountFunding(walletId, { startTime, endTime, pageSize = 500, maxPages = 5000, maxTotal = 1_000_000 } = {}) {
    const all = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < maxPages; page++) {
      const res = await request(
        `/api/v1/account/${encodeURIComponent(walletId)}/history/funding-rate`,
        { startTime, endTime, cursor, limit: pageSize },
        { cache: false, envelope: true },
      );
      const list = Array.isArray(res?.data) ? res.data : (res?.data?.list || res?.data?.items || []);
      if (!list.length) break;
      for (const item of list) {
        // Real field is `createdAt`, not `fundingRateTimestamp` (that name
        // belongs to the market-level funding-rate history endpoint, not
        // this wallet-level one — see normalizeFunding in core.js). With
        // the old key, `fundingRateTimestamp` and `timestamp` were BOTH
        // undefined on every real entry, so the key collapsed to the same
        // string for the whole page (differing only by amount, which was
        // also usually blank since the real field is `fundingFee`) — this
        // silently dropped almost the entire funding history as
        // "duplicates" of the first record.
        const key = `${item.createdAt ?? item.fundingRateTimestamp ?? item.timestamp}:${item.symbolId ?? item.symbol ?? ''}:${item.fundingFee ?? item.amount ?? item.payment ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(item);
      }
      if (all.length >= maxTotal) break;
      const nextCursor = res?.nextPageCursor || res?.nextCursor || res?.cursor || res?.next_cursor || null;
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    return all;
  },

  fetchAccountFundsTransfer(walletId, params = {}) {
    return request(`/api/v1/account/${encodeURIComponent(walletId)}/history/funds-transfer`, params);
  },

  /**
   * Pages through the full deposit/withdraw/transfer history for a wallet.
   * This is the confirmed source for closed-beta team rewards: PopDEX
   * doesn't have a dedicated airdrop/rewards/points endpoint (verified
   * against the full API surface — see RewardsData in fees.js), but team
   * distributions land in this wallet-activity feed as ordinary
   * `TransferIn` records from the team's known distribution wallet. Same
   * cursor-following pattern as fetchAllFills/fetchAllAccountFunding.
   */
  async fetchAllAccountFundsTransfer(walletId, { startTime, endTime, pageSize = 100, maxPages = 5000, maxTotal = 1_000_000 } = {}) {
    const all = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < maxPages; page++) {
      const res = await request(
        `/api/v1/account/${encodeURIComponent(walletId)}/history/funds-transfer`,
        { startTime, endTime, cursor, limit: pageSize },
        { cache: false, envelope: true },
      );
      const list = Array.isArray(res?.data) ? res.data : (res?.data?.list || res?.data?.items || []);
      if (!list.length) break;
      for (const item of list) {
        const key = item.id ?? item.txHash ?? `${item.createdAt}:${item.token}:${item.amount}:${item.fromAddress}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(item);
      }
      if (all.length >= maxTotal) break;
      const nextCursor = res?.nextPageCursor || res?.nextCursor || res?.cursor || res?.next_cursor || null;
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    return all;
  },

  /** USD exchange rate for a non-stablecoin reward token, for Fees vs Rewards' usdValue. */
  fetchExchangeRates({ token, quoteToken = 'USD' } = {}) {
    return request('/api/v1/public/market/exchange-rates', { token, quoteToken });
  },

  fetchLiquidations(walletId, params = {}) {
    return request(`/api/v1/account/${encodeURIComponent(walletId)}/history/liquidation`, params);
  },

  fetchTokenBalance(walletId, token) {
    return request(`/api/v1/account/${encodeURIComponent(walletId)}/token/${encodeURIComponent(token)}/balance`);
  },

  /**
   * Lifetime volume rollup. This is what PopDEX's own site reads its
   * "Total Volume" figure from (confirmed against a real response: it
   * returns `futuresVolume` / `spotVolume` for the requested window), so
   * it's the only way to guarantee our summary strip matches theirs
   * exactly. `window`/`scope: 'All'` requests the all-time total rather
   * than a rolling period. Summing each closed position's volume
   * client-side (the old approach) drifts from this: it misses anything
   * outside the closed-position-history page window and double-leg-counts
   * trades PopDEX itself only counts once, so it's kept only as a
   * fallback for when this endpoint is unavailable.
   */
  fetchPortfolioHistory(walletId, { window = 'All', scope = 'All' } = {}) {
    return request(`/api/v1/account/${encodeURIComponent(walletId)}/history/portfolio`, { window, scope }, { cache: false });
  },
};

/* =========================================================================
   WALLET VALIDATION
   ========================================================================= */
function sanitizeWalletInput(raw) {
  return (raw || '').trim();
}

/** Generic public-address shape check (hex or base58-ish). Real validation happens server-side. */
function looksLikeWalletAddress(addr) {
  if (!addr) return false;
  if (/^0x[a-fA-F0-9]{40}$/.test(addr)) return true; // EVM-style
  if (/^[a-zA-Z0-9]{20,64}$/.test(addr)) return true; // generic base58/hex chain id
  return false;
}

/**
 * Stable identity for a raw position record, used to de-dupe across
 * paginated pages. Prefers the position's own id (a genuine reopen of the
 * same id after a full close is vanishingly rare vs. a pagination-boundary
 * repeat); falls back to a composite of fields that together uniquely
 * describe one closed trade, for responses that don't include an id.
 */
function positionDedupeKey(p) {
  const id = p.positionId ?? p.id;
  if (id != null) return `id:${id}`;
  const symbol = p.symbol ?? p.pair ?? '';
  const close = p.closeTime ?? p.updatedTime ?? p.closeTimestamp ?? p.updatedAt ?? '';
  const open = p.openTime ?? p.createdTime ?? p.openTimestamp ?? p.createdAt ?? '';
  const size = p.positionSize ?? p.size ?? p.qty ?? '';
  return `k:${symbol}:${open}:${close}:${size}`;
}


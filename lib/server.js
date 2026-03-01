import express from 'express';
import chalk from 'chalk';
import path, { join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { MODELS, sources } from '../sources.js';
import { API_KEY_SIGNUP_URLS } from './providerLinks.js';
import { getApiKey, isProviderEnabled, loadConfig, saveConfig } from './config.js';
import { computeQoSMap, findBestModel, getAvg, getUptime, getVerdict, isRetryableProxyStatus, rankModelsForRouting, parseOpenRouterKeyRateLimit } from './utils.js';
import { getPreferredLanIpv4Address } from './network.js';
import { randomUUID } from 'crypto';
import { hasQwenOauthCredentials, pollQwenOauthDeviceToken, resolveQwenCodeOauthSession, startQwenOauthDeviceLogin } from './qwencodeAuth.js';
import { fetchLatestNpmVersion, isVersionNewer, runUpdateCommand } from './update.js';
import { canConsumeTokens, createCustomerKey, normalizeAccessConfig, recordTokenUsage, resolveCustomerKey } from './access.js';

const FREE_LANE_PROVIDER_KEYS = new Set(['openrouter', 'qwencode']);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let APP_VERSION = 'unknown';
try {
  const versionFromEnv = process.env.npm_package_version;
  if (typeof versionFromEnv === 'string' && versionFromEnv.trim()) {
    APP_VERSION = versionFromEnv.trim();
  } else {
    const candidatePaths = [
      path.join(__dirname, '../package.json'),
      path.join(process.cwd(), 'package.json'),
    ];
    for (const candidatePath of candidatePaths) {
      if (!existsSync(candidatePath)) continue;
      const pkgRaw = readFileSync(candidatePath, 'utf8');
      const pkg = JSON.parse(pkgRaw);
      if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) {
        APP_VERSION = pkg.version.trim();
        break;
      }
    }
  }
} catch {
  APP_VERSION = 'unknown';
}

const PING_TIMEOUT = 15_000;
const PING_INTERVAL = 30 * 60_000;
const MAX_PROACTIVE_RETRIES = 5;
const NPM_LATEST_CACHE_MS = 10 * 60_000;

const latestVersionCache = {
  value: null,
  fetchedAt: 0,
  inFlight: null,
};

const openRouterFreeModelsCache = {
  modelIds: null,
  fetchedAt: 0,
  inFlight: null,
};
const OPENROUTER_FREE_MODELS_CACHE_MS = 10 * 60_000;

const qwenOauthLoginSessions = new Map();
const customerPortalSessions = new Map();

async function fetchLatestNpmVersionCached() {
  const now = Date.now();
  const cacheFresh = (now - latestVersionCache.fetchedAt) < NPM_LATEST_CACHE_MS;
  if (cacheFresh && latestVersionCache.value) return latestVersionCache.value;
  if (latestVersionCache.inFlight) return latestVersionCache.inFlight;

  latestVersionCache.inFlight = (async () => {
    try {
      const version = await fetchLatestNpmVersion();
      if (version) latestVersionCache.value = version;
    } catch {
      // Keep stale cache value if request fails.
    } finally {
      latestVersionCache.fetchedAt = Date.now();
      latestVersionCache.inFlight = null;
    }
    return latestVersionCache.value;
  })();

  return latestVersionCache.inFlight;
}

// Parse NVIDIA/OpenAI duration strings like "1m30s", "12ms", "45s" into milliseconds
function parseDurationMs(str) {
  if (!str) return null;
  // Try numeric first (plain seconds or ms)
  const num = Number(str);
  if (!isNaN(num)) return num * 1000; // assume seconds
  let ms = 0;
  const match = str.match(/(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?/);
  if (match) {
    if (match[1]) ms += parseInt(match[1]) * 60000;
    if (match[2]) ms += parseFloat(match[2]) * 1000;
    if (match[3]) ms += parseInt(match[3]);
  }
  return ms || null;
}


function labelFromModelId(modelId) {
  const raw = String(modelId || '').trim();
  if (!raw) return 'OpenRouter Model';
  const base = raw.replace(/:free$/i, '').split('/').pop() || raw;
  return base
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function extractErrorMessage(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') return payload.trim() || null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const msg = extractErrorMessage(item);
      if (msg) return msg;
    }
    return null;
  }
  if (typeof payload === 'object') {
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();
    if (payload.error) {
      const msg = extractErrorMessage(payload.error);
      if (msg) return msg;
    }
    if (typeof payload.status === 'string' && payload.status.trim()) return payload.status.trim();
  }
  return null;
}

function parseErrorBodyText(rawText) {
  if (!rawText || !rawText.trim()) return null;
  const trimmed = rawText.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return extractErrorMessage(parsed) || trimmed.slice(0, 300);
  } catch {
    return trimmed.slice(0, 300);
  }
}

function getNetworkErrorMessage(err) {
  if (!err) return null;
  if (typeof err === 'string') return err;
  const direct = typeof err.message === 'string' ? err.message.trim() : '';
  const cause = err && typeof err === 'object' ? err.cause : null;
  const causeMessage = cause && typeof cause.message === 'string' ? cause.message.trim() : '';
  const causeCode = cause && typeof cause.code === 'string' ? cause.code.trim() : '';

  if (causeCode && causeMessage) return `${direct || 'Network error'} (${causeCode}: ${causeMessage})`;
  if (causeCode) return `${direct || 'Network error'} (${causeCode})`;
  if (causeMessage) return `${direct || 'Network error'} (${causeMessage})`;
  return direct || null;
}

function captureResolvedModel(logEntry, payload) {
  if (!logEntry || !payload || typeof payload !== 'object') return;
  if (typeof payload.model === 'string' && payload.model.trim()) {
    logEntry.resolvedModel = payload.model.trim();
  }
}

async function ping(apiKey, modelId, url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT)
  const t0 = performance.now()
  try {
    const headers = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const resp = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers,
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
    })
    let errorMessage = null;
    if (!resp.ok) {
      try {
        const raw = await resp.text();
        errorMessage = parseErrorBodyText(raw);
      } catch {
        errorMessage = null;
      }
    }
    // Capture rate-limit headers for display purposes
    const rateLimit = {};
    const rl = resp.headers;
    const LR = rl.get('x-ratelimit-limit-requests'); if (LR) rateLimit.limitRequests = parseInt(LR);
    const RR = rl.get('x-ratelimit-remaining-requests'); if (RR) rateLimit.remainingRequests = parseInt(RR);
    const LT = rl.get('x-ratelimit-limit-tokens'); if (LT) rateLimit.limitTokens = parseInt(LT);
    const RT = rl.get('x-ratelimit-remaining-tokens'); if (RT) rateLimit.remainingTokens = parseInt(RT);

    const resetReq = rl.get('x-ratelimit-reset-requests');
    const resetTok = rl.get('x-ratelimit-reset-tokens');
    if (resetReq) {
      const ms = parseDurationMs(resetReq);
      if (ms != null) rateLimit.resetRequestsAt = Date.now() + ms;
    }
    if (resetTok) {
      const ms = parseDurationMs(resetTok);
      if (ms != null) rateLimit.resetTokensAt = Date.now() + ms;
    }

    return {
      code: String(resp.status),
      ms: Math.round(performance.now() - t0),
      rateLimit: Object.keys(rateLimit).length > 0 ? rateLimit : null,
      errorMessage,
    }
  } catch (err) {
    const isTimeout = err.name === 'AbortError'
    const message = getNetworkErrorMessage(err)
    return {
      code: isTimeout ? '000' : 'ERR',
      ms: isTimeout ? 'TIMEOUT' : Math.round(performance.now() - t0),
      errorMessage: isTimeout ? 'Request timed out while pinging provider.' : message,
    }
  } finally {
    clearTimeout(timer)
  }
}

function mergeRateLimits(primary, secondary) {
  if (!primary && !secondary) return null;
  if (!primary) return secondary;
  if (!secondary) return primary;
  return { ...primary, ...secondary };
}

async function fetchOpenRouterRateLimit(apiKey) {
  if (!apiKey) return null;
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/key', {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` }
    });

    if (!resp.ok) return null;

    const payload = await resp.json();
    return parseOpenRouterKeyRateLimit(payload);
  } catch {
    return null;
  }
}

async function fetchOpenRouterFreeModels(apiKey) {
  if (!apiKey) return null;
  const now = Date.now();
  const fresh = openRouterFreeModelsCache.modelIds && (now - openRouterFreeModelsCache.fetchedAt) < OPENROUTER_FREE_MODELS_CACHE_MS;
  if (fresh) return openRouterFreeModelsCache.modelIds;
  if (openRouterFreeModelsCache.inFlight) return openRouterFreeModelsCache.inFlight;

  openRouterFreeModelsCache.inFlight = (async () => {
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/models', { method: 'GET' });
      if (!resp.ok) return openRouterFreeModelsCache.modelIds;
      const payload = await resp.json();
      const data = Array.isArray(payload?.data) ? payload.data : [];
      const freeIds = data
        .map(item => typeof item?.id === 'string' ? item.id : '')
        .filter(id => id.endsWith(':free'));
      if (freeIds.length > 0) openRouterFreeModelsCache.modelIds = freeIds;
      openRouterFreeModelsCache.fetchedAt = Date.now();
      return openRouterFreeModelsCache.modelIds;
    } catch {
      return openRouterFreeModelsCache.modelIds;
    } finally {
      openRouterFreeModelsCache.inFlight = null;
    }
  })();

  return openRouterFreeModelsCache.inFlight;
}

async function resolveProviderAuthToken(config, providerKey, options = {}) {
  const apiKey = getApiKey(config, providerKey);
  if (apiKey) {
    return { token: apiKey, authSource: 'api-key', providerUrlOverride: null };
  }

  if (providerKey === 'qwencode') {
    const oauthSession = await resolveQwenCodeOauthSession({ forceRefresh: !!options.forceRefreshQwenOauth });
    if (oauthSession?.accessToken) {
      const providerUrlOverride = normalizeQwenOauthProviderUrl(oauthSession.resourceUrl);
      return { token: oauthSession.accessToken, authSource: 'oauth', providerUrlOverride };
    }
  }

  return { token: null, authSource: null, providerUrlOverride: null };
}

function normalizeQwenOauthProviderUrl(resourceUrl) {
  if (!resourceUrl || typeof resourceUrl !== 'string') return null;
  const trimmed = resourceUrl.trim();
  if (!trimmed) return null;

  let urlText = trimmed;
  if (!/^https?:\/\//i.test(urlText)) {
    urlText = `https://${urlText}`;
  }

  try {
    const parsed = new URL(urlText);
    const pathname = (parsed.pathname || '/').replace(/\/+$/, '');

    if (pathname.endsWith('/chat/completions')) {
      parsed.pathname = pathname;
      return parsed.toString();
    }
    if (pathname.endsWith('/v1')) {
      parsed.pathname = `${pathname}/chat/completions`;
      return parsed.toString();
    }

    parsed.pathname = `${pathname === '' ? '' : pathname}/v1/chat/completions`;
    return parsed.toString();
  } catch {
    return null;
  }
}

function pruneQwenOauthLoginSessions() {
  const now = Date.now();
  for (const [sessionId, session] of qwenOauthLoginSessions.entries()) {
    if (!session || !session.expiresAt) {
      qwenOauthLoginSessions.delete(sessionId);
      continue;
    }
    if (now > session.expiresAt + 60_000) {
      qwenOauthLoginSessions.delete(sessionId);
    }
  }
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || '');
  const out = {};
  for (const pair of raw.split(';')) {
    const [k, ...rest] = pair.split('=');
    if (!k) continue;
    out[k.trim()] = decodeURIComponent(rest.join('=').trim());
  }
  return out;
}


function getPortalSession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies.mr_portal_session;
  if (!sessionId) return null;
  const session = customerPortalSessions.get(sessionId);
  if (!session) return null;
  return { sessionId, ...session };
}

function parseIsoDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeAutoUpdateState(config) {
  if (!config.autoUpdate || typeof config.autoUpdate !== 'object') config.autoUpdate = {};
  if (config.autoUpdate.enabled == null) config.autoUpdate.enabled = true;
  if (!Number.isFinite(config.autoUpdate.intervalHours) || config.autoUpdate.intervalHours <= 0) config.autoUpdate.intervalHours = 24;
  if (!('lastCheckAt' in config.autoUpdate)) config.autoUpdate.lastCheckAt = null;
  if (!('lastUpdateAt' in config.autoUpdate)) config.autoUpdate.lastUpdateAt = null;
  if (!('lastVersionApplied' in config.autoUpdate)) config.autoUpdate.lastVersionApplied = null;
  if (!('lastError' in config.autoUpdate)) config.autoUpdate.lastError = null;
  return config.autoUpdate;
}

function getAutoUpdateStatusSnapshot() {
  const cfg = loadConfig();
  const state = normalizeAutoUpdateState(cfg);
  return {
    enabled: state.enabled !== false,
    intervalHours: state.intervalHours,
    lastCheckAt: state.lastCheckAt || null,
    lastUpdateAt: state.lastUpdateAt || null,
    lastVersionApplied: state.lastVersionApplied || null,
    lastError: state.lastError || null,
  };
}

export async function runServer(config, port, enableLog = true, bannedModels = []) {
  // 📖 pinnedModelId: when set, ALL proxy requests are locked to this model (in-memory, resets on restart)
  let pinnedModelId = null;
  const currentConfigLoader = loadConfig();
  if (currentConfigLoader.bannedModels && currentConfigLoader.bannedModels.length > 0) {
    bannedModels = [...new Set([...bannedModels, ...currentConfigLoader.bannedModels])];
  }

  console.log(chalk.cyan(`  🚀 Starting modelrelay Web UI on port ${port}...`));
  if (bannedModels.length > 0) {
    console.log(chalk.yellow(`  🚫 Banned models: ${bannedModels.join(', ')}`));
  }
  if (!enableLog) {
    console.log(chalk.dim(`  📝 Request terminal logging disabled`));
  }

  let autoUpdateInProgress = false;

  let results = MODELS
    .map(([modelId, label, intell, ctx, providerKey], i) => ({
      idx: i + 1, modelId, label, intell, ctx, providerKey,
      status: 'pending',
      pings: [],
      httpCode: null,
      hidden: false,
      lastModelResponseAt: 0,
    }));

  const applyOpenRouterFreeModelFilter = async () => {
    const cfg = loadConfig();
    const openRouterKey = getApiKey(cfg, 'openrouter');
    const freeIds = await fetchOpenRouterFreeModels(openRouterKey);
    if (!Array.isArray(freeIds) || freeIds.length === 0) return;

    const allowed = new Set(freeIds);
    const existingOpenRouterModelIds = new Set(
      results
        .filter(row => row.providerKey === 'openrouter')
        .map(row => row.modelId)
    );

    for (const modelId of allowed) {
      if (existingOpenRouterModelIds.has(modelId)) continue;
      results.push({
        idx: results.length + 1,
        modelId,
        label: labelFromModelId(modelId),
        intell: 0,
        ctx: 'N/A',
        providerKey: 'openrouter',
        status: 'pending',
        pings: [],
        httpCode: null,
        hidden: false,
        lastModelResponseAt: 0,
      });
    }

    for (const row of results) {
      if (row.providerKey !== 'openrouter') continue;
      row.hidden = !allowed.has(row.modelId);
      if (row.hidden && row.status === 'up') row.status = 'disabled';
    }
  };


  const pingModel = async (r) => {
    // Refresh config every ping cycle just in case
    const currentConfig = loadConfig();
    const enabled = isProviderEnabled(currentConfig, r.providerKey);

    if (bannedModels.some(b => b === r.modelId || b === `${r.providerKey}/${r.modelId}`)) {
      r.status = 'banned';
      return;
    }

    if (!enabled) {
      r.status = 'disabled';
      return;
    }

    const auth = await resolveProviderAuthToken(currentConfig, r.providerKey);
    const providerApiKey = auth.token;
    const providerUrl = auth.providerUrlOverride || sources[r.providerKey]?.url || sources.nvidia.url;

    const { code, ms, rateLimit, errorMessage } = await ping(providerApiKey, r.modelId, providerUrl);
    const now = Date.now();
    r.pings.push({ ms, code, ts: now });
    if (r.pings.length > 50) r.pings.shift(); // keep history bounded
    // Store ping rate-limit data for display, but only if no authoritative
    // proxy-sourced data exists yet (proxy data has a `capturedAt` field).
    if (rateLimit && (!r.rateLimit || !r.rateLimit.capturedAt)) {
      r.rateLimit = rateLimit;
    }

    // Auto-expire stale wasRateLimited flag from proxy 429 responses.
    // If all reset times have passed, clear the flag so the model becomes
    // eligible for routing again. Also refresh with fresh ping data.
    if (r.rateLimit && r.rateLimit.wasRateLimited === true) {
      const now = Date.now();
      const resetReq = r.rateLimit.resetRequestsAt || 0;
      const resetTok = r.rateLimit.resetTokensAt || 0;
      const latestReset = Math.max(resetReq, resetTok);
      // Expire if: reset times have passed, or 60s since capture (fallback if no reset times)
      const fallbackExpiry = (r.rateLimit.capturedAt || 0) + 60_000;
      if ((latestReset > 0 && latestReset < now) || (latestReset === 0 && fallbackExpiry < now)) {
        r.rateLimit.wasRateLimited = false;
        // Overwrite with fresh ping data now that rate limit has expired
        if (rateLimit) {
          r.rateLimit = rateLimit;
        }
      }
    }

    if (code === '200') {
      r.status = 'up';
      r.httpCode = null;
      r.lastError = null;
    }
    else if (code === '000') {
      r.status = 'timeout';
      r.lastError = {
        code,
        message: 'Request timed out while pinging provider.',
        updatedAt: now,
      };
    }
    else if (code === 'ERR') {
      r.status = 'down';
      r.httpCode = code;
      r.lastError = {
        code,
        message: errorMessage || 'Network error while contacting provider.',
        updatedAt: now,
      };
    }
    else if (code === '401') {
      r.status = 'noauth';
      r.httpCode = code;
      r.lastError = {
        code,
        message: errorMessage || 'Unauthorized. Check API key or Qwen OAuth session.',
        updatedAt: now,
      };
    }
    else {
      r.status = 'down';
      r.httpCode = code;
      r.lastError = {
        code,
        message: errorMessage || `HTTP ${code}`,
        updatedAt: now,
      };
    }

    // Fetch OpenRouter key-level rate limit (credits) during ping cycles.
    // This is a read-only GET that doesn't consume any rate-limit slots.
    if (r.providerKey === 'openrouter') {
      const keyRateLimit = await fetchOpenRouterRateLimit(providerApiKey);
      if (keyRateLimit) {
        // Merge with any existing proxy-captured rate limit data
        const merged = mergeRateLimits(r.rateLimit, keyRateLimit);
        // Propagate to all OpenRouter models (credits are per-API-key)
        for (const other of results) {
          if (other.providerKey === 'openrouter') {
            other.rateLimit = merged;
          }
        }
      }
    }
  };

  const triggerImmediateProviderPing = (providerKey) => {
    if (!providerKey) return;
    const providerModels = results.filter(r => r.providerKey === providerKey);
    if (providerModels.length === 0) return;
    void Promise.allSettled(providerModels.map(r => pingModel(r)));
  };

  const schedulePing = () => {
    setTimeout(async () => {
      const now = Date.now();
      for (const r of results) {
        if (now - (r.lastModelResponseAt || 0) < PING_INTERVAL) continue;
        pingModel(r).catch(() => { });
      }
      schedulePing();
    }, PING_INTERVAL);
  };

  const maybeRunAutoUpdate = async () => {
    if (autoUpdateInProgress) return;

    const currentConfig = loadConfig();
    const state = normalizeAutoUpdateState(currentConfig);
    const enabled = state.enabled !== false;
    if (!enabled) return;

    const now = Date.now();
    const intervalMs = Math.max(1, Number(state.intervalHours) || 24) * 60 * 60 * 1000;
    const lastCheckMs = state.lastCheckAt ? Date.parse(state.lastCheckAt) : 0;
    if (lastCheckMs && !Number.isNaN(lastCheckMs) && (now - lastCheckMs) < intervalMs) return;

    autoUpdateInProgress = true;
    try {
      const freshConfig = loadConfig();
      const freshState = normalizeAutoUpdateState(freshConfig);
      freshState.lastCheckAt = new Date().toISOString();
      freshState.lastError = null;
      saveConfig(freshConfig);

      const latest = await fetchLatestNpmVersionCached();
      if (!latest || !isVersionNewer(latest, APP_VERSION)) return;

      const updateResult = runUpdateCommand(latest);
      if (!updateResult.ok) {
        const failedConfig = loadConfig();
        const failedState = normalizeAutoUpdateState(failedConfig);
        failedState.lastError = updateResult.message;
        saveConfig(failedConfig);
        console.error(chalk.red(`  ✖ Auto-update failed: ${updateResult.message}`));
        return;
      }

      const successConfig = loadConfig();
      const successState = normalizeAutoUpdateState(successConfig);
      successState.lastUpdateAt = new Date().toISOString();
      successState.lastVersionApplied = latest;
      successState.lastError = null;
      saveConfig(successConfig);
      APP_VERSION = latest;
      latestVersionCache.value = latest;
      latestVersionCache.fetchedAt = Date.now();
      console.log(chalk.green(`  ✓ Auto-updated modelrelay to v${latest}`));
    } catch (err) {
      const failedConfig = loadConfig();
      const failedState = normalizeAutoUpdateState(failedConfig);
      failedState.lastError = err?.message || 'Auto-update failed unexpectedly.';
      saveConfig(failedConfig);
      console.error(chalk.red(`  ✖ Auto-update error: ${failedState.lastError}`));
    } finally {
      autoUpdateInProgress = false;
    }
  };

  const scheduleAutoUpdate = () => {
    setTimeout(() => {
      maybeRunAutoUpdate().catch(() => { });
      scheduleAutoUpdate();
    }, 10 * 60_000);
  };

  process.stdout.write(chalk.dim('  ⏳ Initializing model health checks... '));
  await applyOpenRouterFreeModelFilter();
  await Promise.all(results.map(r => pingModel(r)));
  console.log(chalk.green('Done!'));

  schedulePing();
  await maybeRunAutoUpdate();
  scheduleAutoUpdate();

  const app = express();
  const jsonBodyLimit = process.env.MODELRELAY_JSON_LIMIT || '10mb';

  let configMutationQueue = Promise.resolve();
  const updateConfigSafe = async (updater) => {
    const run = async () => {
      const cfg = loadConfig();
      const access = normalizeAccessConfig(cfg);
      const result = await updater(cfg, access);
      normalizeAccessConfig(cfg);
      saveConfig(cfg);
      return result;
    };
    configMutationQueue = configMutationQueue.then(run, run);
    return configMutationQueue;
  };

  const getAccessState = () => {
    const cfg = loadConfig();
    return normalizeAccessConfig(cfg);
  };

  const saveAccessConfig = async (cfg) => updateConfigSafe((loadedCfg) => {
    loadedCfg.access = cfg.access;
  });

  const verifyAdminToken = (req) => {
    const configured = process.env.MODELRELAY_ADMIN_TOKEN || '';
    if (!configured) return false;
    const auth = String(req.headers.authorization || '');
    if (!auth.toLowerCase().startsWith('bearer ')) return false;
    return auth.slice(7).trim() === configured;
  };

  const verifyAdminSession = (req) => {
    const raw = String(process.env.MODELRELAY_ADMIN_EMAILS || '').trim();
    if (!raw) return false;
    const adminEmails = new Set(raw.split(',').map(v => v.trim().toLowerCase()).filter(Boolean));
    if (adminEmails.size === 0) return false;
    const session = getPortalSession(req);
    if (!session?.email) return false;
    return adminEmails.has(String(session.email).toLowerCase());
  };

  const requireAdminAuth = (req, res, next) => {
    if (verifyAdminToken(req) || verifyAdminSession(req)) return next();
    return res.status(401).json({ error: { message: 'Admin authorization required.' } });
  };

  const requirePortalSession = (req, res, next) => {
    const session = getPortalSession(req);
    if (!session) return res.status(401).json({ error: { message: 'Login required.' } });
    req.portalSession = session;
    next();
  };

  function estimateRequestTokens(payload = {}) {
    const maxTokens = Number(payload.max_tokens || payload.maxTokens || 0);
    const messageTokensEstimate = Array.isArray(payload.messages)
      ? payload.messages.reduce((acc, msg) => {
        const text = typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content || '');
        return acc + Math.ceil((text || '').length / 4);
      }, 0)
      : 0;
    const prompt = Math.max(1, messageTokensEstimate);
    const completion = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 256;
    return Math.max(1, prompt + completion);
  }

  app.use(express.static(path.join(__dirname, '../public')));
  app.use(express.json({ limit: jsonBodyLimit }));

  app.get('/', (req, res) => {
    const session = getPortalSession(req);
    if (!session) return res.sendFile(path.join(__dirname, '../public/login.html'));
    res.sendFile(path.join(__dirname, '../public/index.html'));
  });

  app.get('/catalog', (_req, res) => {
    res.sendFile(path.join(__dirname, '../public/catalog.html'));
  });

  // CORS
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  app.get('/healthz', (_req, res) => {
    const visibleRows = results.filter(row => row.hidden !== true);
    const upCount = visibleRows.filter(row => row.status === 'up').length;
    const activeProviders = new Set(visibleRows.map(row => row.providerKey)).size;
    res.json({
      ok: true,
      service: 'modelrelay',
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      models: {
        total: visibleRows.length,
        up: upCount,
        down: Math.max(0, visibleRows.length - upCount),
      },
      providers: {
        active: activeProviders,
      },
    });
  });

  // API for Web UI
  app.get('/api/meta', async (req, res) => {
    const latestVersion = await fetchLatestNpmVersionCached();
    const updateAvailable = !!latestVersion && isVersionNewer(latestVersion, APP_VERSION);
    const autoUpdate = getAutoUpdateStatusSnapshot();
    res.json({
      version: APP_VERSION,
      latestVersion: latestVersion || null,
      updateAvailable,
      autoUpdate,
    });
  });

  app.get('/api/models', async (req, res) => {
    await applyOpenRouterFreeModelFilter();
    const qosMap = computeQoSMap(results);
    const formatted = results.map(r => {
      const lastPing = r.pings.length > 0 ? r.pings[r.pings.length - 1] : null;
      const now = Date.now();
      const rateLimit = r.rateLimit || null;
      let isRateLimited = false;
      if (rateLimit) {
        if (rateLimit.wasRateLimited === true) {
          isRateLimited = true;
        }
        if (rateLimit.creditLimit != null && rateLimit.creditRemaining != null && rateLimit.creditRemaining <= 0) {
          isRateLimited = true;
        }
        if (rateLimit.resetRequestsAt && rateLimit.resetRequestsAt <= now) {
          // informative only; status is refreshed by ping cycle
        }
      }

      return {
        ...r,
        avg: getAvg(r),
        uptime: getUptime(r),
        verdict: getVerdict(r),
        qos: isRateLimited ? 0 : (qosMap.get(r) || 0),
        isRateLimited,
        lastPing: lastPing ? lastPing.ms : null,
        rateLimit,
        pings: r.pings  // full history (up to 50 entries) for the dashboard drawer
      };
    });
    const autoBest = findBestModel(results);
    // If a pinned model is set and still valid (not banned/disabled), report it as the effective best
    const pinnedResult = pinnedModelId ? results.find(r => r.modelId === pinnedModelId) : null;
    const effectiveBest = (pinnedResult && pinnedResult.status !== 'banned' && pinnedResult.status !== 'disabled')
      ? pinnedResult
      : autoBest;
    res.json({ models: formatted, best: effectiveBest ? effectiveBest.modelId : null, pinnedModelId });
  });

  app.get('/api/catalog/models', (_req, res) => {
    const catalog = Object.entries(sources).map(([providerKey, provider]) => {
      const providerModels = MODELS
        .filter(([, , , , modelProviderKey]) => modelProviderKey === providerKey)
        .map(([modelId, label, intell, ctx]) => ({
          modelId,
          label,
          sweBench: intell,
          context: ctx,
          freeHint: modelId.includes(':free') || FREE_LANE_PROVIDER_KEYS.has(providerKey),
        }));

      return {
        providerKey,
        providerName: provider.name,
        modelCount: providerModels.length,
        models: providerModels,
      };
    });

    res.json({
      providers: catalog,
      totalModels: MODELS.length,
    });
  });

  app.get('/api/config', (req, res) => {
    const currentConfig = loadConfig();
    const providers = Object.keys(sources).map(key => ({
      key,
      name: sources[key].name,
      enabled: isProviderEnabled(currentConfig, key),
      hasKey: !!currentConfig.apiKeys[key] || (key === 'qwencode' && hasQwenOauthCredentials()),
      signupUrl: API_KEY_SIGNUP_URLS[key] || null
    }));
    res.json(providers);
  });

  app.get('/api/access/keys', requireAdminAuth, (_req, res) => {
    const access = getAccessState();
    const keys = access.customerKeys.map(customer => ({
      id: customer.id,
      label: customer.label,
      enabled: customer.enabled !== false,
      monthlyTokenLimit: customer.monthlyTokenLimit || null,
      createdAt: customer.createdAt,
      keyPreview: typeof customer.key === 'string' ? `${customer.key.slice(0, 8)}...` : null,
    }));
    res.json({ keys });
  });

  app.get('/api/access/accounts', requireAdminAuth, (_req, res) => {
    const cfg = loadConfig();
    const access = normalizeAccessConfig(cfg);
    const accounts = access.accounts.map(acc => ({
      id: acc.id,
      email: acc.email,
      name: acc.name || null,
      provider: acc.provider || 'google',
      approved: acc.approved === true,
      approvedAt: acc.approvedAt || null,
      createdAt: acc.createdAt,
      plan: acc.plan || 'starter',
      monthlyTokenLimit: Number.isFinite(acc.monthlyTokenLimit) ? acc.monthlyTokenLimit : 100_000_000,
      keyIssued: !!acc.customerKeyId,
      customerKeyId: acc.customerKeyId || null,
      deniedAt: acc.deniedAt || null,
      deniedReason: acc.deniedReason || null,
      subscriptionStatus: acc.subscriptionStatus || (acc.approved === true ? 'active' : 'pending'),
      subscriptionEndsAt: acc.subscriptionEndsAt || null,
    }));
    res.json({ accounts });
  });

  app.post('/api/access/auth/google', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return res.status(400).json({ error: { message: 'Valid email is required.' } });

    const cfg = loadConfig();
    const access = normalizeAccessConfig(cfg);
    let account = access.accounts.find(a => a.email === email);
    if (!account) {
      account = {
        id: randomUUID(),
        email,
        name: String(req.body?.name || '').trim() || null,
        provider: 'google',
        approved: false,
        createdAt: new Date().toISOString(),
        plan: 'starter',
        monthlyTokenLimit: 100_000_000,
        customerKeyId: null,
        subscriptionStatus: 'pending',
        subscriptionEndsAt: null,
        deniedAt: null,
        deniedReason: null,
      };
      access.accounts.push(account);
      saveAccessConfig(cfg);
    }

    res.status(200).json({
      account: {
        id: account.id,
        email: account.email,
        approved: account.approved === true,
        plan: account.plan || 'starter',
        monthlyTokenLimit: Number.isFinite(account.monthlyTokenLimit) ? account.monthlyTokenLimit : 100_000_000,
        requiresAdminApproval: account.approved !== true,
        subscriptionStatus: account.subscriptionStatus || (account.approved === true ? 'active' : 'pending'),
        subscriptionEndsAt: account.subscriptionEndsAt || null,
      }
    });
  });

  app.post('/api/access/session', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const company = String(req.body?.company || '').trim() || 'N/A';
    const plan = String(req.body?.plan || 'Standard').trim() || 'Standard';
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: { message: 'email is required.' } });
    }
    const access = getAccessState();
    const account = access.accounts.find(a => a.email === email) || null;
    const sessionId = randomUUID();
    customerPortalSessions.set(sessionId, {
      email,
      company,
      plan,
      accountId: account?.id || null,
      createdAt: Date.now(),
    });
    res.setHeader('Set-Cookie', `mr_portal_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
    return res.json({ ok: true, email, plan, account });
  });

  app.get('/api/access/session', (req, res) => {
    const session = getPortalSession(req);
    if (!session) return res.json({ authenticated: false });
    return res.json({ authenticated: true, email: session.email, plan: session.plan, company: session.company });
  });


  app.get('/api/access/me', requirePortalSession, (req, res) => {
    const access = getAccessState();
    const account = access.accounts.find(a => a.email === req.portalSession.email) || null;
    if (!account) return res.json({ authenticated: true, account: null });
    res.json({
      authenticated: true,
      account: {
        id: account.id,
        email: account.email,
        approved: account.approved === true,
        plan: account.plan || 'starter',
        monthlyTokenLimit: Number.isFinite(account.monthlyTokenLimit) ? account.monthlyTokenLimit : null,
        subscriptionStatus: account.subscriptionStatus || (account.approved === true ? 'active' : 'pending'),
        subscriptionEndsAt: account.subscriptionEndsAt || null,
        deniedAt: account.deniedAt || null,
        deniedReason: account.deniedReason || null,
      },
    });
  });

  app.post('/api/access/logout', (req, res) => {
    const cookies = parseCookies(req);
    const sessionId = cookies.mr_portal_session;
    if (sessionId) customerPortalSessions.delete(sessionId);
    res.setHeader('Set-Cookie', 'mr_portal_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  app.post('/api/access/accounts/:id/approve', requireAdminAuth, async (req, res) => {
    const cfg = loadConfig();
    const access = normalizeAccessConfig(cfg);
    const account = access.accounts.find(a => a.id === req.params.id);
    if (!account) return res.status(404).json({ error: { message: 'Account not found.' } });

    const requestedLimit = Number(req.body?.monthlyTokenLimit);
    const monthlyTokenLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.floor(requestedLimit)
      : 100_000_000;
    const plan = String(req.body?.plan || account.plan || 'starter').trim() || 'starter';
    const expiresAt = parseIsoDateOrNull(req.body?.subscriptionEndsAt || req.body?.expiresAt);

    account.approved = true;
    account.deniedAt = null;
    account.deniedReason = null;
    account.subscriptionStatus = 'active';
    account.approvedAt = new Date().toISOString();
    account.plan = plan;
    account.monthlyTokenLimit = monthlyTokenLimit;
    account.subscriptionEndsAt = expiresAt;

    if (!account.customerKeyId) {
      const key = createCustomerKey({
        label: account.email,
        monthlyTokenLimit: account.monthlyTokenLimit,
      });
      access.customerKeys.push(key);
      account.customerKeyId = key.id;
      await saveAccessConfig(cfg);
      return res.json({ approved: true, key, account });
    }

    const existing = access.customerKeys.find(k => k.id === account.customerKeyId) || null;
    if (existing) {
      existing.enabled = true;
      existing.monthlyTokenLimit = account.monthlyTokenLimit;
      existing.label = account.email;
    }

    await saveAccessConfig(cfg);
    return res.json({ approved: true, key: existing, account });
  });

  app.post('/api/access/accounts/:id/deny', requireAdminAuth, async (req, res) => {
    const cfg = loadConfig();
    const access = normalizeAccessConfig(cfg);
    const account = access.accounts.find(a => a.id === req.params.id);
    if (!account) return res.status(404).json({ error: { message: 'Account not found.' } });

    account.approved = false;
    account.subscriptionStatus = 'denied';
    account.deniedAt = new Date().toISOString();
    account.deniedReason = String(req.body?.reason || 'Denied by admin.').trim();

    const existing = account.customerKeyId ? access.customerKeys.find(k => k.id === account.customerKeyId) : null;
    if (existing) existing.enabled = false;

    await saveAccessConfig(cfg);
    return res.json({ denied: true, account });
  });

  app.post('/api/access/keys', requireAdminAuth, async (req, res) => {
    try {
      const cfg = loadConfig();
      const access = normalizeAccessConfig(cfg);
      const customerKey = createCustomerKey({
        label: req.body?.label,
        monthlyTokenLimit: Number(req.body?.monthlyTokenLimit),
      });
      access.customerKeys.push(customerKey);
      await saveAccessConfig(cfg);
      res.status(201).json({ key: customerKey });
    } catch (err) {
      res.status(400).json({ error: { message: err?.message || 'Could not create key.' } });
    }
  });

  app.post('/api/access/keys/:id', requireAdminAuth, async (req, res) => {
    const cfg = loadConfig();
    const access = normalizeAccessConfig(cfg);
    const customer = access.customerKeys.find(item => item.id === req.params.id);
    if (!customer) return res.status(404).json({ error: { message: 'Customer key not found.' } });

    if (typeof req.body?.enabled === 'boolean') customer.enabled = req.body.enabled;
    if (req.body?.monthlyTokenLimit != null) {
      const limit = Number(req.body.monthlyTokenLimit);
      customer.monthlyTokenLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
    }
    if (typeof req.body?.label === 'string' && req.body.label.trim()) customer.label = req.body.label.trim();
    await saveAccessConfig(cfg);
    res.json({ key: customer });
  });

  app.get('/api/access/usage', requireAdminAuth, (_req, res) => {
    const access = getAccessState();
    res.json({ usage: access.usage || {} });
  });

  app.get('/api/autoupdate', (req, res) => {
    const cfg = loadConfig();
    const state = normalizeAutoUpdateState(cfg);
    res.json({
      enabled: state.enabled !== false,
      intervalHours: state.intervalHours,
      lastCheckAt: state.lastCheckAt || null,
      lastUpdateAt: state.lastUpdateAt || null,
      lastVersionApplied: state.lastVersionApplied || null,
      lastError: state.lastError || null,
    });
  });

  app.post('/api/autoupdate', (req, res) => {
    const { enabled, intervalHours } = req.body || {};
    const cfg = loadConfig();
    const state = normalizeAutoUpdateState(cfg);

    if (enabled !== undefined) {
      state.enabled = enabled !== false;
    }

    if (intervalHours !== undefined) {
      const parsed = Number(intervalHours);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return res.status(400).json({ error: 'intervalHours must be a positive number.' });
      }
      state.intervalHours = parsed;
    }

    saveConfig(cfg);

    if (state.enabled !== false) {
      maybeRunAutoUpdate().catch(() => { });
    }

    return res.json({
      success: true,
      autoUpdate: {
        enabled: state.enabled !== false,
        intervalHours: state.intervalHours,
        lastCheckAt: state.lastCheckAt || null,
        lastUpdateAt: state.lastUpdateAt || null,
        lastVersionApplied: state.lastVersionApplied || null,
        lastError: state.lastError || null,
      },
    });
  });

  app.post('/api/config', requireAdminAuth, (req, res) => {
    const { providerKey, apiKey, enabled } = req.body;
    const currentConfig = loadConfig();
    const wasEnabled = isProviderEnabled(currentConfig, providerKey);

    if (apiKey !== undefined) {
      currentConfig.apiKeys[providerKey] = apiKey;
    }
    if (enabled !== undefined) {
      if (!currentConfig.providers) currentConfig.providers = {};
      if (!currentConfig.providers[providerKey]) currentConfig.providers[providerKey] = {};
      currentConfig.providers[providerKey].enabled = enabled;
    }
    saveConfig(currentConfig);
    void applyOpenRouterFreeModelFilter();

    const isNowEnabled = isProviderEnabled(currentConfig, providerKey);
    if (enabled === true && !wasEnabled && isNowEnabled) {
      triggerImmediateProviderPing(providerKey);
    }

    res.json({ success: true });
  });

  app.post('/api/qwencode/login/start', async (req, res) => {
    try {
      pruneQwenOauthLoginSessions();
      const started = await startQwenOauthDeviceLogin();
      const now = Date.now();
      const sessionId = randomUUID();
      const pollIntervalMs = 2000;
      qwenOauthLoginSessions.set(sessionId, {
        status: 'pending',
        deviceCode: started.deviceCode,
        codeVerifier: started.codeVerifier,
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        verificationUriComplete: started.verificationUriComplete,
        expiresAt: now + (started.expiresIn * 1000),
        nextPollAt: now,
        pollIntervalMs,
        lastError: null,
      });

      res.json({
        sessionId,
        status: 'pending',
        verificationUri: started.verificationUri,
        verificationUriComplete: started.verificationUriComplete,
        userCode: started.userCode,
        pollIntervalMs,
        expiresAt: now + (started.expiresIn * 1000),
      });
    } catch (error) {
      const message = error?.message || 'Failed to start Qwen OAuth login.';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/qwencode/login/status', async (req, res) => {
    pruneQwenOauthLoginSessions();
    const sessionId = String(req.query.sessionId || '');
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

    const session = qwenOauthLoginSessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Login session not found.' });

    const now = Date.now();
    if (now > session.expiresAt) {
      session.status = 'expired';
    }

    if (session.status === 'pending' && now >= (session.nextPollAt || 0)) {
      let pollResult;
      try {
        pollResult = await pollQwenOauthDeviceToken({
          deviceCode: session.deviceCode,
          codeVerifier: session.codeVerifier,
        });
      } catch (error) {
        session.status = 'error';
        session.lastError = error?.message || 'Qwen OAuth poll failed.';
        pollResult = { status: 'error', message: session.lastError };
      }

      if (pollResult.status === 'authorized') {
        session.status = 'authorized';
        session.authorizedAt = now;
      } else if (pollResult.status === 'expired') {
        session.status = 'expired';
      } else if (pollResult.status === 'error') {
        session.status = 'error';
        session.lastError = pollResult.message || 'Qwen OAuth login failed.';
      }

      const interval = pollResult.status === 'pending' && pollResult.slowDown ? Math.min((session.pollIntervalMs || 2000) + 1000, 10_000) : (session.pollIntervalMs || 2000);
      session.pollIntervalMs = interval;
      session.nextPollAt = now + interval;
    }

    const response = {
      status: session.status,
      userCode: session.userCode,
      verificationUriComplete: session.verificationUriComplete,
      expiresAt: session.expiresAt,
      nextPollAt: session.nextPollAt || now,
      pollIntervalMs: session.pollIntervalMs || 2000,
      error: session.lastError || null,
    };
    res.json(response);
  });

  app.post('/api/models/ban', (req, res) => {
    const { modelId, banned } = req.body;
    if (!modelId) return res.status(400).json({ error: 'Missing modelId' });

    const currentConfig = loadConfig();
    let currentBans = currentConfig.bannedModels || [];

    if (banned) {
      if (!currentBans.includes(modelId)) currentBans.push(modelId);
      if (!bannedModels.includes(modelId)) bannedModels.push(modelId);
    } else {
      currentBans = currentBans.filter(m => m !== modelId);
      bannedModels = bannedModels.filter(m => m !== modelId);
    }

    currentConfig.bannedModels = currentBans;
    saveConfig(currentConfig);

    // Apply status change immediately
    const model = results.find(r => r.modelId === modelId);
    if (model) {
      if (banned) {
        model.status = 'banned';
      } else {
        model.status = 'pending'; // Let the next ping figure it out
        model.pings = [];
      }
    }

    // If the banned model was pinned, clear the pin
    if (banned && pinnedModelId === modelId) {
      pinnedModelId = null;
    }

    res.json({ success: true, bannedModels: currentBans });
  });

  app.post('/api/models/ping', async (req, res) => {
    const { modelId } = req.body || {};
    if (!modelId) return res.status(400).json({ error: 'Missing modelId' });

    const model = results.find(r => r.modelId === modelId);
    if (!model) return res.status(404).json({ error: 'Model not found' });

    try {
      await pingModel(model);
      res.json({
        success: true,
        model: {
          modelId: model.modelId,
          status: model.status,
          avg: getAvg(model),
          uptime: getUptime(model),
          verdict: getVerdict(model),
          lastPing: model.pings.length > 0 ? model.pings[model.pings.length - 1].ms : null,
          pings: model.pings,
          httpCode: model.httpCode,
        },
      });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to ping model' });
    }
  });

  const LOGS_PATH = join(homedir(), '.modelrelay-logs.json');
  const MAX_DISK_LOGS = 200;

  // Load persisted logs from disk on startup
  let requestLogs = [];
  if (existsSync(LOGS_PATH)) {
    try {
      const raw = readFileSync(LOGS_PATH, 'utf8');
      requestLogs = JSON.parse(raw);
      if (!Array.isArray(requestLogs)) requestLogs = [];
      console.log(chalk.dim(`  📋 Loaded ${requestLogs.length} persisted log entries`));
    } catch {
      requestLogs = [];
    }
  }

  function saveLogs() {
    try {
      const toSave = requestLogs.slice(0, MAX_DISK_LOGS);
      writeFileSync(LOGS_PATH, JSON.stringify(toSave, null, 2), { mode: 0o600 });
    } catch { /* silently fail */ }
  }

  app.get('/api/logs', (req, res) => {
    res.json(requestLogs);
  });

  // GET current pinned model
  app.get('/api/pinned', (req, res) => {
    res.json({ pinnedModelId });
  });

  // POST to set or clear the pinned model
  app.post('/api/pinned', (req, res) => {
    const { modelId } = req.body;
    // modelId = null/undefined clears the pin (auto mode)
    pinnedModelId = modelId || null;
    console.log(chalk.cyan(`  [Router] 📌 Pinned model set to: ${pinnedModelId || '(auto)'}`));
    res.json({ success: true, pinnedModelId });
  });

  // Proxy endpoint
  app.get('/v1/models', (req, res) => {
    res.json({
      object: "list",
      data: [{
        id: "auto-fastest",
        object: "model",
        created: Date.now(),
        owned_by: "router"
      }]
    });
  });

  const captureProxyRateLimit = async (model, response, providerApiKey) => {
    const rateLimit = {};
    const rh = response.headers;
    const LR = rh.get('x-ratelimit-limit-requests'); if (LR) rateLimit.limitRequests = parseInt(LR);
    const RR = rh.get('x-ratelimit-remaining-requests'); if (RR) rateLimit.remainingRequests = parseInt(RR);
    const LT = rh.get('x-ratelimit-limit-tokens'); if (LT) rateLimit.limitTokens = parseInt(LT);
    const RT = rh.get('x-ratelimit-remaining-tokens'); if (RT) rateLimit.remainingTokens = parseInt(RT);

    const resetReq = rh.get('x-ratelimit-reset-requests');
    const resetTok = rh.get('x-ratelimit-reset-tokens');
    if (resetReq) {
      const ms = parseDurationMs(resetReq);
      if (ms != null) rateLimit.resetRequestsAt = Date.now() + ms;
    }
    if (resetTok) {
      const ms = parseDurationMs(resetTok);
      if (ms != null) rateLimit.resetTokensAt = Date.now() + ms;
    }

    rateLimit.wasRateLimited = response.status === 429;
    rateLimit.capturedAt = Date.now();

    if (Object.keys(rateLimit).length > 0) {
      model.rateLimit = rateLimit;
      for (const r of results) {
        if (r.providerKey === model.providerKey) {
          r.rateLimit = rateLimit;
        }
      }
    }

    if (model.providerKey === 'openrouter') {
      const keyRateLimit = await fetchOpenRouterRateLimit(providerApiKey);
      if (keyRateLimit) {
        const merged = mergeRateLimits(model.rateLimit, keyRateLimit);
        for (const r of results) {
          if (r.providerKey === 'openrouter') {
            r.rateLimit = merged;
          }
        }
      }
    }
  };

  app.post('/v1/chat/completions', async (req, res) => {
    let logEntry = null;
    try {
      await applyOpenRouterFreeModelFilter();
      const cfg = loadConfig();
      const access = normalizeAccessConfig(cfg);
      const requiresCustomerAuth = access.customerKeys.length > 0;
      const customer = resolveCustomerKey(req.headers.authorization, cfg);
      if (requiresCustomerAuth && !customer) {
        return res.status(401).json({ error: { message: 'Invalid customer API key.' } });
      }

      const tokenEstimate = estimateRequestTokens(req.body || {});

      if (customer) {
        const preflight = canConsumeTokens(access, customer, tokenEstimate);
        if (!preflight.allowed) {
          return res.status(402).json({
            error: {
              message: `Monthly token quota exceeded for key ${customer.label}.`,
              code: preflight.reason,
              used: preflight.used,
              limit: preflight.limit,
            }
          });
        }
      }

      const payload = req.body;
      const attemptedModelIds = new Set();
      const attempts = [];

      const pickNextModel = () => {
        if (pinnedModelId) {
          const pinned = results.find(r => r.modelId === pinnedModelId);
          if (pinned && pinned.status !== 'banned' && pinned.status !== 'disabled' && !attemptedModelIds.has(pinned.modelId)) {
            return pinned;
          }
        }
        const ranked = rankModelsForRouting(results, Array.from(attemptedModelIds));
        return ranked[0] || null;
      };

      logEntry = {
        timestamp: new Date().toISOString(),
        model: '(pending)',
        provider: '(pending)',
        messages: payload.messages || [],
        duration: null,
        ttft: null,
        status: 'pending',
        response: null,
        prompt_tokens: null,
        completion_tokens: null,
        tool_calls: null,
        function_call: null,
        attempts,
        retryCount: 0,
        customerKeyId: customer?.id || null,
        customerLabel: customer?.label || null,
      };

      requestLogs.unshift(logEntry);
      if (requestLogs.length > 50) requestLogs.length = 50;

      if (enableLog) {
        console.log(chalk.dim('  ┌─────────────────── REQUEST PAYLOAD ───────────────────'));
        for (const msg of logEntry.messages) {
          const roleStr = msg.role.toUpperCase().padEnd(9);
          const color = msg.role === 'system' ? chalk.magenta : (msg.role === 'user' ? chalk.blue : chalk.green);
          let content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

          if (content.length > 500) {
            content = content.substring(0, 500) + chalk.italic(' ...[truncated]');
          }
          console.log(color(`  │ [${roleStr}] ${content.replace(/\n/g, '\n  │           ')}`));
        }
        console.log(chalk.dim('  └───────────────────────────────────────────────────────\n'));
      }

      let selectedModel = null;
      let selectedProviderApiKey = null;
      let selectedResponse = null;
      let selectedT0 = 0;

      for (let retry = 0; retry <= MAX_PROACTIVE_RETRIES; retry++) {
        const best = pickNextModel();
        if (!best) break;

        attemptedModelIds.add(best.modelId);
        payload.model = best.modelId;

        const currentConfig = loadConfig();
        let providerAuth = await resolveProviderAuthToken(currentConfig, best.providerKey);
        let providerUrl = providerAuth.providerUrlOverride || sources[best.providerKey]?.url;

        const attemptMeta = {
          index: retry + 1,
          model: best.modelId,
          provider: best.providerKey,
          status: 'pending',
          duration: null,
          retryable: false,
        };

        if (!providerAuth.token) {
          attemptMeta.status = 'NO_KEY';
          attemptMeta.error = best.providerKey === 'qwencode'
            ? 'No credentials configured for provider qwencode. Set QWEN_CODE_API_KEY/DASHSCOPE_API_KEY or sign in with Qwen OAuth.'
            : `No API key configured for provider ${best.providerKey}.`;
          attempts.push(attemptMeta);
          continue;
        }

        if (!providerUrl) {
          attemptMeta.status = 'NO_URL';
          attemptMeta.error = `No provider URL configured for provider ${best.providerKey}.`;
          attempts.push(attemptMeta);
          continue;
        }

        console.log(chalk.dim(`  [Router] ➡️ Proxying request (attempt ${retry + 1}/${MAX_PROACTIVE_RETRIES + 1}) to ${best.providerKey}/${best.modelId} (${best.status === 'up' && best.pings.length > 0 ? best.pings[best.pings.length - 1].ms + 'ms' : 'fallback'})`));

        const headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${providerAuth.token}`
        };

        const t0 = performance.now();
        let response;
        try {
          response = await fetch(providerUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
          });

          if (response.status === 401 && best.providerKey === 'qwencode' && providerAuth.authSource === 'oauth') {
            const refreshedAuth = await resolveProviderAuthToken(currentConfig, best.providerKey, { forceRefreshQwenOauth: true });
            if (refreshedAuth.token && refreshedAuth.token !== providerAuth.token) {
              providerAuth = refreshedAuth;
              providerUrl = providerAuth.providerUrlOverride || providerUrl;
              headers.Authorization = `Bearer ${providerAuth.token}`;
              response = await fetch(providerUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
              });
            }
          }
        } catch (err) {
          attemptMeta.duration = Math.round(performance.now() - t0);
          attemptMeta.status = 'ERR';
          attemptMeta.error = err?.message || 'Unknown network error';
          attemptMeta.retryable = true;
          attempts.push(attemptMeta);
          if (retry === MAX_PROACTIVE_RETRIES) {
            throw err;
          }
          continue;
        }

        attemptMeta.duration = Math.round(performance.now() - t0);
        attemptMeta.status = String(response.status);
        attemptMeta.retryable = isRetryableProxyStatus(response.status);
        attempts.push(attemptMeta);

        await captureProxyRateLimit(best, response, providerAuth.token);

        if (response.ok) {
          const now = Date.now();
          best.lastModelResponseAt = now;
          best.pings.push({ ms: attemptMeta.duration, code: '200', ts: now });
          if (best.pings.length > 50) best.pings.shift();
          best.status = 'up';
          best.httpCode = null;
          best.lastError = null;
          selectedModel = best;
          selectedProviderApiKey = providerAuth.token;
          selectedResponse = response;
          selectedT0 = t0;
          break;
        }

        if (attemptMeta.retryable && retry < MAX_PROACTIVE_RETRIES) {
          let retryBody = '';
          try {
            retryBody = await response.text();
            attemptMeta.error = retryBody;
          } catch {
            attemptMeta.error = '<Could not read retry response body>';
          }
          console.log(chalk.yellow(`  [Router] 🔁 Attempt failed with HTTP ${response.status}; retrying with a different model.`));
          continue;
        }

        selectedModel = best;
        selectedProviderApiKey = providerAuth.token;
        selectedResponse = response;
        selectedT0 = t0;
        break;
      }

      if (!selectedResponse || !selectedModel || !selectedProviderApiKey) {
        logEntry.status = '503';
        logEntry.error = { message: 'No models currently available for this request.', attempts };
        logEntry.retryCount = Math.max(0, attempts.length - 1);
        saveLogs();
        return res.status(503).json({ error: { message: 'No models currently available for this request.' } });
      }

      logEntry.model = selectedModel.modelId;
      logEntry.provider = selectedModel.providerKey;
      logEntry.duration = Math.round(performance.now() - selectedT0);
      logEntry.status = String(selectedResponse.status);
      logEntry.retryCount = Math.max(0, attempts.length - 1);

      res.status(selectedResponse.status);

      for (const [key, value] of selectedResponse.headers.entries()) {
        if (['content-type', 'transfer-encoding', 'cache-control', 'connection'].includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }

      if (selectedResponse.body) {
        const { Readable, Transform } = await import('stream');

        let responseBodyText = '';
        let ttftCaptured = false;
        const MAX_LOG_BODY_SIZE = 10 * 1024 * 1024; // 10MB limit for logging

        const captureStream = new Transform({
          transform(chunk, encoding, callback) {
            if (!ttftCaptured) {
              ttftCaptured = true;
              logEntry.ttft = Math.round(performance.now() - selectedT0);
            }
            // Only accumulate up to limit to prevent OOM
            if (responseBodyText.length < MAX_LOG_BODY_SIZE) {
              responseBodyText += chunk.toString();
            }
            callback(null, chunk);
          },
          flush(callback) {
            try {
              const wasTruncated = responseBodyText.length >= MAX_LOG_BODY_SIZE;

              if (selectedResponse.status >= 400) {
                try {
                  const errorData = JSON.parse(responseBodyText);
                  logEntry.error = errorData;
                } catch {
                  logEntry.error = responseBodyText + (wasTruncated ? '... (truncated)' : '');
                }
              } else if (payload.stream) {
                const lines = responseBodyText.split('\n');
                let fullContent = '';
                let toolCalls = [];
                let functionCall = null;
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                    try {
                      const data = JSON.parse(trimmed.slice(6));
                      captureResolvedModel(logEntry, data);
                      if (data.choices && data.choices[0] && data.choices[0].delta) {
                        const delta = data.choices[0].delta;
                        if (delta.content) fullContent += delta.content;
                        if (delta.tool_calls) {
                          for (const tc of delta.tool_calls) {
                            if (!toolCalls[tc.index]) toolCalls[tc.index] = { id: tc.id || '', type: tc.type || 'function', function: { name: '', arguments: '' } };
                            if (tc.id) toolCalls[tc.index].id = tc.id;
                            if (tc.type) toolCalls[tc.index].type = tc.type;
                            if (tc.function) {
                              if (tc.function.name) toolCalls[tc.index].function.name += tc.function.name;
                              if (tc.function.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                            }
                          }
                        }
                        if (delta.function_call) {
                          if (!functionCall) functionCall = { name: '', arguments: '' };
                          if (delta.function_call.name) functionCall.name += delta.function_call.name;
                          if (delta.function_call.arguments) functionCall.arguments += delta.function_call.arguments;
                        }
                      }
                      if (data.usage) {
                        if (data.usage.prompt_tokens != null) logEntry.prompt_tokens = data.usage.prompt_tokens;
                        if (data.usage.completion_tokens != null) logEntry.completion_tokens = data.usage.completion_tokens;
                      }
                    } catch (e) { }
                  }
                }
                if (fullContent) logEntry.response = fullContent;
                if (toolCalls.length > 0) {
                  logEntry.tool_calls = toolCalls.filter(Boolean).map(tc => {
                    if (tc.function && tc.function.arguments) {
                      try { tc.function.arguments = JSON.parse(tc.function.arguments); } catch (e) { }
                    }
                    return tc;
                  });
                }
                if (functionCall) {
                  if (functionCall.arguments) {
                    try { functionCall.arguments = JSON.parse(functionCall.arguments); } catch (e) { }
                  }
                  logEntry.function_call = functionCall;
                }
              } else {
                const data = JSON.parse(responseBodyText);
                captureResolvedModel(logEntry, data);
                if (data.choices && data.choices[0] && data.choices[0].message) {
                  const msg = data.choices[0].message;
                  if (msg.content) logEntry.response = msg.content;
                  if (msg.tool_calls) {
                    logEntry.tool_calls = msg.tool_calls.map(tc => {
                      if (tc.function && typeof tc.function.arguments === 'string') {
                        try { tc.function.arguments = JSON.parse(tc.function.arguments); } catch (e) { }
                      }
                      return tc;
                    });
                  }
                  if (msg.function_call) {
                    logEntry.function_call = { ...msg.function_call };
                    if (typeof logEntry.function_call.arguments === 'string') {
                      try { logEntry.function_call.arguments = JSON.parse(logEntry.function_call.arguments); } catch (e) { }
                    }
                  }
                }
                if (data.usage) {
                  if (data.usage.prompt_tokens != null) logEntry.prompt_tokens = data.usage.prompt_tokens;
                  if (data.usage.completion_tokens != null) logEntry.completion_tokens = data.usage.completion_tokens;
                }
              }
            } catch (e) {
              logEntry.response = "<Could not parse response payload>";
            }
            saveLogs();
            if (customer && selectedResponse.status < 400) {
              const promptTokens = Number(logEntry.prompt_tokens) > 0 ? Number(logEntry.prompt_tokens) : Math.max(1, Math.floor(tokenEstimate * 0.6));
              const completionTokens = Number(logEntry.completion_tokens) > 0 ? Number(logEntry.completion_tokens) : Math.max(1, tokenEstimate - promptTokens);
              recordTokenUsage(access, customer.id, {
                promptTokens,
                completionTokens,
              });
              saveAccessConfig(cfg).catch(() => {});
            }
            callback();
          }
        });

        Readable.fromWeb(selectedResponse.body).pipe(captureStream).pipe(res);
      } else {
        const text = await selectedResponse.text();
        logEntry.ttft = logEntry.duration;
        if (selectedResponse.status >= 400) {
          try {
            logEntry.error = JSON.parse(text);
          } catch {
            logEntry.error = text;
          }
        } else {
          try {
            const data = JSON.parse(text);
            captureResolvedModel(logEntry, data);
            if (data.choices && data.choices[0] && data.choices[0].message) {
              const msg = data.choices[0].message;
              if (msg.content) logEntry.response = msg.content;
              if (msg.tool_calls) {
                logEntry.tool_calls = msg.tool_calls.map(tc => {
                  if (tc.function && typeof tc.function.arguments === 'string') {
                    try { tc.function.arguments = JSON.parse(tc.function.arguments); } catch (e) { }
                  }
                  return tc;
                });
              }
              if (msg.function_call) {
                logEntry.function_call = { ...msg.function_call };
                if (typeof logEntry.function_call.arguments === 'string') {
                  try { logEntry.function_call.arguments = JSON.parse(logEntry.function_call.arguments); } catch (e) { }
                }
              }
            }
            if (data.usage) {
              if (data.usage.prompt_tokens != null) logEntry.prompt_tokens = data.usage.prompt_tokens;
              if (data.usage.completion_tokens != null) logEntry.completion_tokens = data.usage.completion_tokens;
            }
          } catch (e) { }
        }
        res.end(text);
        if (customer && selectedResponse.status < 400) {
          const promptTokens = Number(logEntry.prompt_tokens) > 0 ? Number(logEntry.prompt_tokens) : Math.max(1, Math.floor(tokenEstimate * 0.6));
          const completionTokens = Number(logEntry.completion_tokens) > 0 ? Number(logEntry.completion_tokens) : Math.max(1, tokenEstimate - promptTokens);
          recordTokenUsage(access, customer.id, {
            promptTokens,
            completionTokens,
          });
          await saveAccessConfig(cfg);
        }
        saveLogs();
      }
    } catch (e) {
      if (logEntry) {
        logEntry.status = 'err';
        logEntry.error = e.message;
      }
      console.error(chalk.red(`  [Router] Error processing request: ${e.message}`));
      if (logEntry) saveLogs();
      res.status(400).json({ error: { message: e.message } });
    }
  });

  app.listen(port, () => {
    const lanIp = getPreferredLanIpv4Address();
    console.log();
    console.log(chalk.green(`  ✅ Web UI active at ${chalk.bold(`http://localhost:${port}`)}`));
    if (lanIp) {
      console.log(chalk.green(`  ✅ Visit ${chalk.bold(`http://${lanIp}:${port}`)} to access the Web UI from another computer on your network.`));
    }
    console.log(chalk.green(`  ✅ Router proxy active at ${chalk.bold(`http://localhost:${port}/v1`)}`));
    console.log(chalk.dim(`  Usage in OpenCode/Cursor:`));
    console.log(chalk.dim(`  - Provider Base URL: http://localhost:${port}/v1`));
    console.log(chalk.dim(`  - API Key: (anything, ignored)`));
    console.log(chalk.dim(`  - Model: (anything, ignored)`));
    console.log();
  });

}

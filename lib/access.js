import { randomUUID } from 'crypto'

export function normalizeAccessConfig(config) {
  if (!config.access || typeof config.access !== 'object') config.access = {}
  if (!Array.isArray(config.access.customerKeys)) config.access.customerKeys = []
  if (!Array.isArray(config.access.accounts)) config.access.accounts = []
  if (!config.access.usage || typeof config.access.usage !== 'object') config.access.usage = {}
  return config.access
}

export function createCustomerKey({ label, monthlyTokenLimit = null }) {
  const cleanLabel = typeof label === 'string' ? label.trim() : ''
  if (!cleanLabel) throw new Error('label is required')
  const normalizedLimit = Number.isFinite(monthlyTokenLimit) && monthlyTokenLimit > 0
    ? Math.floor(monthlyTokenLimit)
    : null

  return {
    id: randomUUID(),
    key: `mrk_${randomUUID().replace(/-/g, '')}`,
    label: cleanLabel,
    enabled: true,
    monthlyTokenLimit: normalizedLimit,
    createdAt: new Date().toISOString(),
  }
}

export function resolveCustomerKey(authHeader, config) {
  const access = normalizeAccessConfig(config)
  const header = typeof authHeader === 'string' ? authHeader.trim() : ''
  if (!header.toLowerCase().startsWith('bearer ')) return null
  const token = header.slice(7).trim()
  if (!token) return null
  const customer = access.customerKeys.find(c => c.key === token)
  if (!customer || customer.enabled === false) return null
  return customer
}

export function getUsageBucket(access, customerId, monthKey) {
  if (!access.usage[customerId]) access.usage[customerId] = {}
  if (!access.usage[customerId][monthKey]) {
    access.usage[customerId][monthKey] = {
      promptTokens: 0,
      completionTokens: 0,
      requests: 0,
      updatedAt: null,
    }
  }
  return access.usage[customerId][monthKey]
}

export function monthKeyFromDate(date = new Date()) {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

export function canConsumeTokens(access, customer, additionalTokens, now = new Date()) {
  if (!customer || customer.enabled === false) return { allowed: false, reason: 'disabled' }
  if (!customer.monthlyTokenLimit) return { allowed: true }
  const monthKey = monthKeyFromDate(now)
  const bucket = getUsageBucket(access, customer.id, monthKey)
  const used = (bucket.promptTokens || 0) + (bucket.completionTokens || 0)
  const requested = Number.isFinite(additionalTokens) && additionalTokens > 0 ? additionalTokens : 0
  if (used + requested > customer.monthlyTokenLimit) {
    return { allowed: false, reason: 'monthly_limit_exceeded', used, limit: customer.monthlyTokenLimit }
  }
  return { allowed: true, used, limit: customer.monthlyTokenLimit }
}

export function recordTokenUsage(access, customerId, { promptTokens = 0, completionTokens = 0 } = {}, now = new Date()) {
  if (!customerId) return null
  const monthKey = monthKeyFromDate(now)
  const bucket = getUsageBucket(access, customerId, monthKey)
  bucket.promptTokens += Number.isFinite(promptTokens) ? Math.max(0, Math.floor(promptTokens)) : 0
  bucket.completionTokens += Number.isFinite(completionTokens) ? Math.max(0, Math.floor(completionTokens)) : 0
  bucket.requests += 1
  bucket.updatedAt = now.toISOString()
  return bucket
}

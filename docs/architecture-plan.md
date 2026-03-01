# ModelRelay Monetization Architecture Plan

## Phase 1: Planning and Architecture

### Current framework understanding
- Existing Node.js router (`lib/server.js`) proxies OpenAI-compatible requests.
- Provider/model inventory is defined in `sources.js`.
- Current local config file (`~/.modelrelay.json`) stores provider credentials and access keys.

### PostgreSQL schema (recommended)

```sql
create table customers (
  id uuid primary key,
  email text not null unique,
  company_name text,
  plan_code text not null,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table customer_api_keys (
  id uuid primary key,
  customer_id uuid not null references customers(id),
  key_hash text not null unique,
  key_prefix text not null,
  enabled boolean not null default true,
  monthly_token_limit bigint,
  created_at timestamptz not null default now()
);

create table provider_accounts (
  id uuid primary key,
  provider_key text not null,
  account_label text not null,
  encrypted_api_key text,
  credit_balance numeric,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table usage_events (
  id bigserial primary key,
  customer_id uuid not null references customers(id),
  api_key_id uuid references customer_api_keys(id),
  provider_key text not null,
  model_id text not null,
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  request_ms int,
  created_at timestamptz not null default now()
);

create table invoices (
  id uuid primary key,
  customer_id uuid not null references customers(id),
  period_start date not null,
  period_end date not null,
  amount_usd numeric not null,
  status text not null,
  created_at timestamptz not null default now()
);
```

### API specifications (REST/OpenAPI outline)
- `POST /v1/auth/login`
- `POST /v1/customer/keys`
- `GET /v1/customer/keys`
- `GET /v1/customer/usage`
- `POST /v1/chat/completions`
- `GET /v1/admin/providers`
- `GET /v1/admin/revenue`

### System architecture
- API Gateway: auth, API keys, quotas.
- Router Orchestrator: routing, failover, loop detection.
- Provider adapters: OpenRouter, Ollama, LM Studio, NVIDIA, etc.
- Billing service: usage aggregation + invoice generation.
- Dashboard service: admin + customer views.

## Phase 2: Core Platform Backend Services
- API key issuance/validation in gateway.
- Retry/failover + loop-guard in router.
- Usage event writer and billing aggregation jobs.
- Provider adapter isolation with normalized request/response DTOs.

## Phase 3: Web Dashboard (Admin & Customer)
- Next.js app (recommended) separated from router static UI.
- Customer dashboard: keys, usage, plan, profile.
- Admin dashboard: provider costs, customer revenue, margin.
- Billing/payment wireframes integrated with Stripe.

## Phase 4: Verification and QA
- API key proxying tests.
- Failover and loop detection tests.
- Usage accounting correctness tests.
- Published-package verification (npm install -g from registry).

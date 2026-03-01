# modelrelay

OpenAI-compatible local router that benchmarks free coding models across providers and forwards requests to the best available model.

## Install

```bash
npm install -g modelrelay
```

## Quick Start

```bash
# 1) Onboard: save provider API keys and optionally auto-configure integrations
modelrelay onboard

# 2) Start the local router (default port 7352)
modelrelay
```

### Windows one-click start (`.bat`)

From the repository root on Windows, you can run:

```bat
start-modelrelay.bat
```

If the command window closes too quickly, this script now keeps the window open at the end so you can read errors.
You can disable that behavior with:

```bat
start-modelrelay.bat --no-pause
```

The batch script will:

1. Use `pnpm` when available, otherwise try `corepack pnpm`, then `npm`
2. Install dependencies if needed
3. Run tests
4. Start the router

Router endpoint:

- Base URL: `http://127.0.0.1:7352/v1`
- API key: any string
- Model: `auto-fastest` (router picks actual backend)

## OpenCode Quick Start

`modelrelay onboard` can auto-configure OpenCode.

If you want manual setup, put this in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "router": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "modelrelay",
      "options": {
        "baseURL": "http://127.0.0.1:7352/v1",
        "apiKey": "dummy-key"
      },
      "models": {
        "auto-fastest": {
          "name": "Auto Fastest"
        }
      }
    }
  },
  "model": "router/auto-fastest"
}
```

## OpenClaw Quick Start

`modelrelay onboard` can auto-configure OpenClaw.

If you want manual setup, merge this into `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "modelrelay": {
        "baseUrl": "http://127.0.0.1:7352/v1",
        "api": "openai-completions",
        "apiKey": "no-key",
        "models": [
          { "id": "auto-fastest", "name": "Auto Fastest" }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "modelrelay/auto-fastest"
      },
      "models": {
        "modelrelay/auto-fastest": {}
      }
    }
  }
}
```

## CLI

```bash
modelrelay [--port <number>] [--log] [--ban <model1,model2>]
modelrelay onboard [--port <number>]
modelrelay install --autostart
modelrelay start --autostart
modelrelay uninstall --autostart
modelrelay status --autostart
modelrelay update
modelrelay autoupdate [--enable|--disable|--status] [--interval <hours>]
modelrelay autostart [--install|--start|--uninstall|--status]
```

Request terminal logging is disabled by default. Use `--log` to enable it.

`modelrelay install --autostart` also triggers an immediate start attempt so you do not need a separate command after install.

During `modelrelay onboard`, you will also be prompted to enable auto-start on login.

`modelrelay update` upgrades the global npm package and, when autostart is configured, stops the background service first and starts it again after the update.

Auto-update is enabled by default. While the router is running, modelrelay checks npm periodically (default: every 24 hours) and applies updates automatically.

Use `modelrelay autoupdate --status` to inspect state, `modelrelay autoupdate --disable` to turn it off, and `modelrelay autoupdate --enable --interval 12` to re-enable with a custom interval.

## Config

- Router config file: `~/.modelrelay.json`
- API key env overrides:
  - `NVIDIA_API_KEY`
  - `GROQ_API_KEY`
  - `CEREBRAS_API_KEY`
  - `SAMBANOVA_API_KEY`
  - `OPENROUTER_API_KEY`
  - `CODESTRAL_API_KEY`
  - `HYPERBOLIC_API_KEY`
  - `SCALEWAY_API_KEY`
  - `QWEN_CODE_API_KEY` (or `DASHSCOPE_API_KEY`)
  - `GOOGLE_API_KEY`

For `Qwen Code`, modelrelay supports both API keys and Qwen OAuth cached credentials (`~/.qwen/oauth_creds.json`).
If OAuth credentials exist, modelrelay will use them and refresh access tokens automatically.
You can also start OAuth directly from the Web UI Providers tab using `Login with Qwen Code`.

## Customer Access Keys & Usage Metering

Modelrelay now supports issuing customer-facing API keys that proxy to your internal provider keys.

- `GET /api/access/keys` — list customer keys (masked preview only)
- `POST /api/access/keys` — create a key (`label` required, `monthlyTokenLimit` optional)
- `POST /api/access/keys/:id` — update key (`enabled`, `label`, `monthlyTokenLimit`)
- `GET /api/access/usage` — usage buckets by customer and month

When at least one customer key exists, `POST /v1/chat/completions` requires a valid `Authorization: Bearer mrk_...` key.
If a key has `monthlyTokenLimit`, requests are blocked once the monthly token quota is exceeded.

> **Important:** This enforcement supersedes earlier quick-start guidance that said the API key can be any string.
> Once customer keys are configured, clients and dashboards must send a valid customer key in:
>
> `Authorization: Bearer mrk_...`
>
> Related management endpoints:
> `GET /api/access/keys`, `POST /api/access/keys`, `POST /api/access/keys/:id`, `GET /api/access/usage`.

### Login + Admin Approval flow

Modelrelay includes a customer access flow in the Customer Portal:

- User signs in with Google OAuth flow (simulated endpoint): `POST /api/access/auth/google`
- Account remains pending until admin approval
- Admin can approve via: `POST /api/access/accounts/:id/approve`
- On approval, modelrelay issues a customer API key and applies the plan quota

Current default plan in the portal:

- **$29/month**
- **100,000,000 tokens/month**

Admin account listing endpoint:

- `GET /api/access/accounts`

# Local GitHub Inbound Setup

Language: English | [中文](LOCAL_GITHUB_INBOUND_SETUP.zh.md)

This page explains how to route GitHub App webhooks and GitHub Actions repository review requests to the local GitHub integration service.

## What a Webhook Is

A webhook is an HTTP request sent to an address you provide after an event happens.

In this project:

- GitHub is the event source.
- your `sec-review-bot` service is the receiver.
- you need to give GitHub a reachable webhook URL.
- when issue / PR events happen, GitHub sends the payload to that URL.

This is different from polling GitHub. GitHub pushes events to you.

## Webhook and API Permissions

Local webhook setup is only the receiving side. A working GitHub App also needs API permissions for the actions it will take after receiving an event.

- Webhooks decide which GitHub events the App receives.
- GitHub API permissions decide what the App can do afterward, such as posting comments, creating reviews, or opening draft PRs.

The server in this project:

1. verifies the webhook secret
2. parses the event payload from GitHub
3. calls the GitHub API as the App

## Why Local Development Cannot Use `localhost` Directly

GitHub's servers cannot directly reach your local `localhost:30000`.

For local development, you need a public HTTPS address that GitHub can reach, and then forward that address to your local webhook service:

```text
GitHub -> public HTTPS URL -> local http://localhost:30000/api/webhook
```

Common choices:

- `smee`
  - quick and lightweight; good for local debugging
- Cloudflare Tunnel
  - more formal; useful if you already have a domain or want a stable webhook URL

## Local Service Addresses

The GitHub integration service provides two inbound endpoints by default:

```text
http://localhost:30000/api/webhook
http://localhost:30000/api/repository-review/dispatch
```

They serve different purposes:

- `/api/webhook` receives issue and pull request events from the GitHub App.
- `/api/repository-review/dispatch` receives repository review requests from GitHub Actions.

The port comes from `PORT`. Only the first endpoint is needed when debugging GitHub App webhooks. The second endpoint must also be publicly reachable when using the repository review workflow.

## Option 1: Use `smee`

Many GitHub App / webhook tutorials use [`smee.io`](https://smee.io/) because it is good for getting the local development path working quickly.

### How It Works

1. Get a temporary public URL from `smee.io`.
2. GitHub sends webhooks to that public URL.
3. Run the local `smee` client to forward events to your local service.

### Command

```bash
npx smee -u https://smee.io/xxxxxxxxxxxx -t http://localhost:30000/api/webhook
```

Where:

- `-u`: your public `smee` channel URL
- `-t`: your local webhook service URL

### Good for

- quick local webhook debugging
- temporary GitHub App configuration validation
- avoiding certificates, reverse proxies, inbound ports, and domain setup

### Tradeoff

- the URL is usually more like a temporary debug address
- it is better suited to development than as a formal webhook address

## Option 2: Use Cloudflare Tunnel

If you already have a domain but no public inbound service, or if you do not want to manage port forwarding, TLS certificates, and exposing local ports, you can use Cloudflare Tunnel.

### How It Works

1. Create a tunnel on a machine that can run `cloudflared`.
2. Route a domain or subdomain to the local GitHub integration service.
3. The GitHub App and GitHub Actions use that stable HTTPS address for their respective endpoints.

Add two Published application routes to the Cloudflare Tunnel. Both routes use the same Hostname and Service but have different Paths:

```text
Hostname: your-subdomain.example.com
Service: http://localhost:30000
Path 1: /api/webhook
Path 2: /api/repository-review/dispatch
```

Do not append an endpoint path to Service. After configuration, the two public URLs are:

```text
https://your-subdomain.example.com/api/webhook
https://your-subdomain.example.com/api/repository-review/dispatch
```

Use the first URL as the GitHub App Webhook URL. Store the second URL in the target repository's `SEC_BOT_DISPATCH_URL` Actions secret.

### Diagrams

When creating the tunnel, follow the Cloudflare instructions:

![Cloudflare create tunnel install and run example](../../assets/screenshots/cloudflare-create-tunnel-install-run.png)

Add one route, then repeat the process for the other route:

![Cloudflare add GitHub inbound route](../../assets/screenshots/cloudflare-add-github-inbound-route.png)

When finished, the same tunnel should have two routes:

![Cloudflare GitHub inbound routes](../../assets/screenshots/cloudflare-github-inbound-routes.png)

For uninstalling, see <https://developers.cloudflare.com/tunnel/troubleshooting/>.
The command is:

```bash
sudo cloudflared service uninstall
```

### Good for

- stable, formal, reusable webhook URLs
- setups that already use Cloudflare and a domain
- avoiding nginx, certificates, and public port exposure

## Common GitHub App Permission Pitfalls

- You changed App permissions, but the installation has not been re-approved.
- The webhook secret does not match local configuration.
- The webhook URL is correct, but the local forwarding tool is not running.
- Cloudflare Tunnel only routes `/api/webhook`, so repository review dispatch requests return `404`.
- You think you are listening on a public address, but the local service is not listening on the expected port.
- The App lacks enough `Pull requests`, `Issues`, or `Contents` permissions, so later write-back fails.

A common GitHub API error is:

```text
403 Resource not accessible by integration
```

This usually means permissions are insufficient or the installation has not been updated.

## References

- GitHub App quickstart:
  - <https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/quickstart>
- GitHub webhook guide:
  - <https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-github-app-that-responds-to-webhook-events>

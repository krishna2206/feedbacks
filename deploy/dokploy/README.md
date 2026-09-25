# Deploying Feedbacks on Dokploy

One Dokploy project, three kinds of services, all on the same server:

| Service | Dokploy type | Notes |
|---|---|---|
| Postgres | Database › PostgreSQL | Must run with `wal_level=logical` (Zero replicates it). Never exposed publicly. |
| Garage | Compose (`deploy/dokploy/garage.compose.yml`) | S3-compatible attachment storage. No port, no domain. |
| Feedbacks | Compose (`deploy/dokploy/docker-compose.yml`) | `feedbacks-api`, `feedbacks-zero`, `feedbacks-web`. The domain points at `feedbacks-web:80`. |

Traffic: browser → Traefik → `feedbacks-web` (nginx) → `/api` to the API, `/sync` (WebSocket) to zero-cache, everything else is the static app. Attachments are streamed by the API from Garage (`S3_DOWNLOADS=proxy`), so Garage stays private.

## 1. Postgres

Create a PostgreSQL database (image `postgres:18-alpine`, database and user `feedbacks`, a strong password). In its advanced settings, set the **args** so the official entrypoint starts Postgres with logical replication:

```
postgres -c wal_level=logical -c max_replication_slots=10 -c max_wal_senders=10
```

Deploy it, then note its **internal host** (the Dokploy app name) for `DATABASE_URL`. Schedule backups in Dokploy.

## 2. Garage

Create a Compose service from this repository with compose path `./deploy/dokploy/garage.compose.yml` and environment:

```
GARAGE_RPC_SECRET=<openssl rand -hex 32>
GARAGE_ADMIN_TOKEN=<openssl rand -base64 32>
```

Deploy, then initialise it once from the server (`docker ps` shows the container name):

```bash
G="docker exec <garage-container> /garage"
$G status                                   # copy the node ID
$G layout assign -z dc1 -c 50G <node-id>    # capacity is a weight, not a quota
$G layout apply --version 1
$G bucket create feedbacks
$G key create feedbacks-app                 # prints the access key ID and secret
$G bucket allow --read --write --owner feedbacks --key feedbacks-app
```

## 3. Feedbacks

Create a Compose service from this repository with compose path `./deploy/dokploy/docker-compose.yml` and environment:

```
APP_URL=https://feedbacks.example.com
DATABASE_URL=postgres://feedbacks:<password>@<postgres-app-name>:5432/feedbacks
BETTER_AUTH_SECRET=<openssl rand -base64 32>
ZERO_ADMIN_PASSWORD=<openssl rand -base64 24>
SETUP_TOKEN=<openssl rand -hex 24>
S3_ACCESS_KEY_ID=<from garage key create>
S3_SECRET_ACCESS_KEY=<from garage key create>
```

Optional: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `SMTP_*`, `S3_ENDPOINT` / `S3_BUCKET` (defaults: `http://feedbacks-garage:3900`, `feedbacks`), limits (see `.env.example`).

Add a domain: host `feedbacks.example.com`, service `feedbacks-web`, port `80`, HTTPS with Let's Encrypt. Deploy. Migrations run when the API starts.

Then open `https://feedbacks.example.com/setup?token=<SETUP_TOKEN>` to create the owner account and the organization. Without the token, nobody can claim the instance.

## Behind Cloudflare

Proxied (orange cloud) records work: Cloudflare forwards WebSockets, and Zero keeps the connection alive with pings. Keep `UPLOAD_MAX_MB` under your Cloudflare plan's request limit (100 MB on Free).

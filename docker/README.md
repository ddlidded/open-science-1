# Open-Science — Docker web deployment

Runs the Open-Science web UI + Node backend in a single container behind an
authentication gateway with admin-managed users. Completely separate from the
Electron desktop build (`dist/`).

## Layout

| Path | Purpose |
| --- | --- |
| `Dockerfile` | Two-stage build: compiles `out/standalone` (backend + web + linux micromamba), then a slim runtime with the gateway |
| `entrypoint.sh` | Starts the backend on `127.0.0.1:44100`, then the gateway on `:8080` |
| `auth-gateway/` | Login/session + admin user-management proxy (bcrypt-hashed users in `/data/auth/users.json`) |
| `docker-compose.yml` | Convenience wrapper (optional — plain `docker run` works too) |

## Build

From the repository root:

```bash
docker build -f docker/Dockerfile -t open-science-web .
# or
docker compose -f docker/docker-compose.yml build
```

## Run

```bash
docker run -d --name open-science \
  -p 8080:8080 \
  -e ADMIN_PASSWORD='choose-a-strong-password' \
  -v open-science-data:/data \
  open-science-web
```

or `docker compose -f docker/docker-compose.yml up -d` (set `ADMIN_PASSWORD` in the
environment first).

Open `http://localhost:8080` → sign in with the bootstrap admin. If
`ADMIN_PASSWORD` is unset, a random password is printed once in the container
logs (`docker logs open-science`).

## User management

Admins see **/admin** — list, add, and delete users, and grant/revoke the admin
role. Self-deletion and removing the last admin are refused. Users and secrets
live in the `/data` volume (`/data/auth/`), so they survive container rebuilds.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_USER` | `admin` | Bootstrap admin name (first run only) |
| `ADMIN_PASSWORD` | random | Bootstrap admin password (first run only) |
| `GATEWAY_PORT` | `8080` | Public port inside the container |
| `GATEWAY_SECURE` | unset | `1` adds `Secure` to the session cookie — set behind HTTPS |
| `GATEWAY_SECRET` | generated | HMAC key for session cookies; persisted in `/data` |
| `OPEN_SCIENCE_CONFIG_ROOT` | `/data/open-science` | App profile/state root (contains `web-token`) |

## Notes

- The backend binds loopback only; all traffic (HTTP and WebSocket) passes through
  the gateway, which injects the backend's own `web-token` as a bearer credential.
- Behind a TLS-terminating reverse proxy, set `GATEWAY_SECURE=1` and forward
  `Host`/`X-Forwarded-*` headers.
- The app runtime is unchanged: agents, notebooks, and connectors work exactly as
  in the desktop build. Any host-side CLIs the agents use must exist in the image.

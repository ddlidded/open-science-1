# Open-Science — Dokploy deployment guide

Full walkthrough for deploying the Open-Science web service behind the built-in
authentication gateway on a Dokploy host. The result is an authenticated,
multi-user, persistent deployment — independent of the Electron desktop app.

## What gets deployed

A single container running two processes:

| Process | Listens on | Role |
| --- | --- | --- |
| Auth gateway (`docker/auth-gateway/server.mjs`) | `:8080` (public) | Login UI, bcrypt user store, admin user management at `/admin`, proxies everything authenticated to the backend |
| Backend (`out/backend/index.cjs`) | `127.0.0.1:44100` (loopback) | The Open-Science web service — never exposed directly |

All persistent state lives in the named volume mounted at `/data`:

- `/data/auth/users.json` — gateway accounts (bcrypt hashes)
- `/data/open-science/` — app settings, history, credentials, `web-token`
- `/data/open-science/Open-Science/` — artifacts, notebooks, environments (chosen at onboarding)
- `/data/home/` — agent CLI homes (Devin profile, Codex `auth.json`)

## Prerequisites

- A Dokploy instance (Traefik is included).
- The fork repository `ddlidded/open-science-1`, branch `devin-os`. All Docker
  files live only on this branch — `main` does not contain them.
- Enough RAM/disk on the host for the image build (~4 GB build, ~2 GB image).

## 1. Create the service

In Dokploy: **Create Service → Docker Compose** (or a Compose-type deployment
connected to the Git repo). Source settings:

- **Repository**: `ddlidded/open-science-1`
- **Branch**: `devin-os`
- **Compose file**: a compose definition with `build.context` pointing at the
  repo root. If your compose file lives in a subdirectory (e.g.
  `dokploy/docker-compose.yml`), the context must be `..` so it can see
  `docker/Dockerfile` and the source tree.

Reference service definition (what Dokploy ultimately runs, including its
generated Traefik labels):

```yaml
services:
  open-science:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    image: open-science-web:latest
    ports:
      - 8080:8080
    environment:
      ADMIN_USER: ${ADMIN_USER}
      ADMIN_PASSWORD: ${ADMIN_PASSWORD}
      GATEWAY_SECURE: ${GATEWAY_SECURE:-1}
      GATEWAY_SECRET: ${GATEWAY_SECRET:-}
    volumes:
      - open-science-data:/data
    restart: unless-stopped
volumes:
  open-science-data:
```

Set these in Dokploy's **Environment** tab (no defaults — keep secrets out of
the compose file):

| Variable | Purpose |
| --- | --- |
| `ADMIN_USER` | Bootstrap admin username |
| `ADMIN_PASSWORD` | Bootstrap admin password (min. length applies via UI rules) |
| `GATEWAY_SECURE` | `1` when serving over HTTPS (sets `Secure` on the session cookie) |
| `GATEWAY_SECRET` | Optional session-signing secret; auto-generated and persisted under `/data/auth/` if unset |

## 2. Configure the domain — HTTPS is required

Add the domain under the service's **Domains** tab and **enable HTTPS /
Let's Encrypt**. `sslip.io` hostnames work fine with Let's Encrypt.

> This is not optional. The app calls `crypto.randomUUID()` at boot, which
> browsers only expose in a *secure context* (HTTPS or `localhost`). Over plain
> HTTP on a public domain the app crashes during startup and shows a blank
> beige screen with no login UI.

Dokploy generates the Traefik labels (`entrypoints=websecure` + certresolver);
if you hand-edit labels, use the `websecure` entrypoint and your resolver name.

## 3. Deploy — and mind the stale-image trap

`docker compose up` reuses an existing image named `open-science-web:latest`
instead of rebuilding. After pushing new code, do **not** assume a redeploy
picks it up. Before redeploying a code change, remove the old image on the host:

```bash
docker rmi open-science-web:latest
```

Then hit **Deploy** in Dokploy — compose now actually builds from the pushed
branch.

Redeploys (compose `up`) recreate the container **but never touch the named
volume** — users, settings, agent logins, and projects all survive. The only
destructive actions are:

- `docker compose down -v` (the `-v` deletes volumes)
- Deleting `open-science-data` in Dokploy's volume management
- `docker volume rm`

## 4. First sign-in and user management

- Open `https://<your-domain>/login`, sign in with `ADMIN_USER`/`ADMIN_PASSWORD`.
- Manage users at `/admin` (add/delete users, grant admin).

Gotcha: `users.json` persists on the volume. **Changing `ADMIN_PASSWORD` in env
does not update an existing account.** To re-bootstrap, delete the file and
restart:

```bash
# inside the container (Dokploy → Terminal) or via docker exec
rm /data/auth/users.json
# then docker restart <container-name>
```

Session cookies: 12 h normal, 30 days with "Remember me", enforced
server-side by the signed expiry. `/logout` clears the session — the app shows
a sign-out icon in the sidebar footer on web deployments.

## 5. Agent runtimes inside the container

### Devin

- `devin` CLI `3000.11.234` is baked into the image at `/opt/npm-global/bin`;
  container `HOME=/data/home` so its profile persists.
- **`devin acp` ignores local CLI credentials and env vars by design.** Running
  `devin auth login` inside the container does nothing for ACP sessions. The
  only working path is the API key the app sends over ACP `authenticate`
  (`methodId: devin-browser`, `meta.api_key`).
- Therefore: **Settings → Providers → Devin subscription → paste your
  `windsurf_api_key`** (find it in `%APPDATA%\devin\credentials.toml` on a
  machine where `devin` is logged in, or your Windsurf/Devin account). Leave
  the key blank and every session fails with "Please log in to use Devin."
- Optional: pick a model family on the provider (opus, sonnet, swe, …) —
  forwarded as `--model`.

### Codex

The app imports the ChatGPT subscription session. Copy a logged-in
`auth.json` into the container's persistent home:

```bash
docker exec <container> mkdir -p /data/home/.codex
# copy from a machine that is logged in
docker cp ~/.codex/auth.json <container>:/data/home/.codex/auth.json
```

### Other CLIs / MCP

Install extra CLIs under `/data/home` (user prefix) or `/opt/npm-global` so they
survive redeploys. MCP connectors are configured in Settings → Connectors;
Devin's MCP endpoint is `https://mcp.devin.ai/mcp` (Bearer token stored in the
file credential store — see the "Review" warning on the environment check:
containers have no OS keyring, so secrets live unencrypted under `/data`. Keep
host/volume access trusted.)

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Blank beige screen, not even the login UI | Site served over HTTP — `crypto.randomUUID` missing | Enable HTTPS on the domain (step 2) |
| Blank page or redirect to `127.0.0.1:44100` | Container runs an old image built before the gateway proxy fixes | `docker rmi open-science-web:latest`, redeploy |
| Pushed code but nothing changed | Compose reused the `open-science-web:latest` image | Same as above — delete the image, redeploy |
| "Invalid username or password" with correct env password | `users.json` on the volume holds the old hash | `rm /data/auth/users.json` + `docker restart` |
| "Please log in to use Devin" / "session resume failed" | No API key on the Devin provider (CLI/env auth is ignored in ACP) | Settings → Devin subscription → paste `windsurf_api_key` |
| Agent replies render as many stacked fragments | Pre-fix image (Devin chunks carry no `messageId`) | Rebuild — fixed in commit `dcf2047e3` |
| "File credential storage is enabled" warning | No OS keyring in the container — expected | Acknowledge; keep volume/host access restricted |

Useful commands inside the container (Dokploy → Terminal):

```bash
grep -n "gateway.local" /opt/auth-gateway/server.mjs   # verify gateway build
ps aux | grep -E "server.mjs|index.cjs" | grep -v grep # both processes alive
wget -qO- --timeout=5 http://127.0.0.1:44100/ | head -c 200
devin auth status                                      # note: not used by ACP
```

And on the host:

```bash
docker logs <container-name> --tail 100 | grep -iE "error|warn|devin|acp"
docker restart <container-name>   # restart only — preserves patched files;
                                  # Dokploy redeploy recreates the container
```

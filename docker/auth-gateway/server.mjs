// Open-Science web auth gateway.
// Serves a login page, issues HMAC-signed session cookies, exposes an admin-only user
// management UI (add/delete users), and proxies authenticated traffic — including WebSocket
// upgrades — to the Open-Science backend listening on loopback.
//
// Users are stored as bcrypt hashes in DATA_DIR/auth/users.json. The backend's own web token
// (CONFIG_ROOT/web-token) is forwarded as an Authorization header so the backend session is
// established automatically behind the gateway session.

import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { parse as parseQuery } from 'node:querystring'
import bcrypt from 'bcryptjs'
import httpProxy from 'http-proxy'

const PORT = Number(process.env.GATEWAY_PORT || 8080)
const UPSTREAM = process.env.UPSTREAM_URL || 'http://127.0.0.1:44100'
const DATA_DIR = process.env.DATA_DIR || '/data'
const CONFIG_ROOT = process.env.OPEN_SCIENCE_CONFIG_ROOT || join(DATA_DIR, 'open-science')
const USERS_FILE = join(DATA_DIR, 'auth', 'users.json')
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const COOKIE = 'os_gateway_session'

mkdirSync(join(DATA_DIR, 'auth'), { recursive: true })

// ── secrets ───────────────────────────────────────────────────────────────────
const secretPath = join(DATA_DIR, 'auth', 'session-secret')
let SECRET = process.env.GATEWAY_SECRET
if (!SECRET) {
  if (existsSync(secretPath)) {
    SECRET = readFileSync(secretPath, 'utf8').trim()
  } else {
    SECRET = randomBytes(32).toString('hex')
    writeFileSync(secretPath, SECRET, { mode: 0o600 })
  }
}

// ── user store ────────────────────────────────────────────────────────────────
const loadUsers = () => {
  try {
    return JSON.parse(readFileSync(USERS_FILE, 'utf8')).users ?? []
  } catch {
    return []
  }
}
const saveUsers = (users) =>
  writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2), { mode: 0o600 })

if (loadUsers().length === 0) {
  const adminUser = process.env.ADMIN_USER || 'admin'
  let adminPassword = process.env.ADMIN_PASSWORD
  if (!adminPassword) {
    adminPassword = randomBytes(9).toString('base64url')
    console.log(`[gateway] No users yet — created admin "${adminUser}"`)
    console.log(`[gateway] ADMIN INITIAL PASSWORD: ${adminPassword}`)
    console.log('[gateway] Sign in at /login and change this credential immediately.')
  }
  saveUsers([
    {
      username: adminUser,
      passwordHash: bcrypt.hashSync(adminPassword, 10),
      admin: true,
      createdAt: new Date().toISOString()
    }
  ])
}

// ── sessions (stateless HMAC cookies) ─────────────────────────────────────────
const b64 = (buf) => Buffer.from(buf).toString('base64url')
const sign = (payload) => createHmac('sha256', SECRET).update(payload).digest('base64url')

const LONG_TTL_MS = 30 * 24 * 60 * 60 * 1000
const issueSession = (username, ttlMs = SESSION_TTL_MS) => {
  const payload = b64(JSON.stringify({ u: username, exp: Date.now() + ttlMs }))
  return `${payload}.${sign(payload)}`
}
const readSession = (cookieHeader) => {
  const raw = (cookieHeader ?? '')
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${COOKIE}=`))
  if (!raw) return null
  const [payload, sig] = raw.slice(COOKIE.length + 1).split('.')
  if (!payload || !sig) return null
  const expected = sign(payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return data.exp > Date.now() ? data.u : null
  } catch {
    return null
  }
}

const cookieHeader = (value, maxAge) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax` +
  (maxAge !== undefined ? `; Max-Age=${maxAge}` : '') +
  (process.env.GATEWAY_SECURE === '1' ? '; Secure' : '')

// ── backend web token ─────────────────────────────────────────────────────────
const tokenPath = join(CONFIG_ROOT, 'web-token')
let cachedToken = { mtime: 0, value: '' }
const upstreamToken = () => {
  try {
    const mtime = statSync(tokenPath).mtimeMs
    if (mtime !== cachedToken.mtime) {
      cachedToken = { mtime, value: readFileSync(tokenPath, 'utf8').trim() }
    }
  } catch {
    /* token not written yet */
  }
  return cachedToken.value
}

// ── HTML pages ────────────────────────────────────────────────────────────────
const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const ICONS = {
  user: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  lock: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  eye: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>',
  arrowRight:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
  shieldCheck:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>'
}

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Open-Science</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
 *{box-sizing:border-box;margin:0}
 body{font-family:'Plus Jakarta Sans',system-ui,sans-serif;background:#F8FAFC;color:#0f172a;min-height:100vh;display:flex;flex-direction:column}
 body::before{content:'';position:fixed;inset:0;pointer-events:none;opacity:.4;background-image:radial-gradient(#E2E8F0 1px,transparent 1px),radial-gradient(#E2E8F0 1px,#F8FAFC 1px);background-size:40px 40px;background-position:0 0,20px 20px}
 header{display:flex;justify-content:center;padding:0 0 1.5rem}
 header img{height:2.5rem;width:auto}
 @media(min-width:640px){header img{height:2.75rem}}
 main{position:relative;z-index:1;flex:1;display:flex;align-items:center;justify-content:center;padding:1rem}
 .wrap{width:100%;max-width:28rem}
 .card{background:#fff;border-radius:1rem;border:1px solid rgba(226,232,240,.9);box-shadow:0 20px 25px -5px rgba(226,232,240,.6),0 8px 10px -6px rgba(226,232,240,.6);padding:2rem}
 @media(min-width:640px){.card{padding:2.25rem}}
 h1{font-size:1.5rem;font-weight:700;letter-spacing:-.025em}
 h2{font-size:1.1rem;font-weight:700;margin-top:1.75rem}
 .sub{margin-top:.375rem;margin-bottom:2rem;font-size:.875rem;color:#64748b}
 .center{text-align:center}
 .err{display:flex;gap:.5rem;align-items:flex-start;margin-bottom:1.25rem;padding:.75rem;border-radius:.75rem;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-size:.75rem}
 label.fl{display:block;font-size:.75rem;font-weight:600;color:#334155;margin-bottom:.375rem}
 .field{position:relative;margin-bottom:1rem}
 .field .lead{position:absolute;top:0;bottom:0;left:.875rem;display:flex;align-items:center;color:#94a3b8;pointer-events:none}
 .field .trail{position:absolute;top:0;bottom:0;right:.875rem;display:flex;align-items:center;color:#94a3b8;background:none;border:0;cursor:pointer;padding:0}
 .field .trail:hover{color:#475569}
 input[type=text],input[type=password]{width:100%;padding:.625rem 1rem .625rem 2.5rem;border-radius:.75rem;font-size:.875rem;background:#fff;border:1px solid #cbd5e1;color:#0f172a;font-family:inherit}
 input::placeholder{color:#94a3b8}
 input:focus{border-color:#2563eb;outline:3px solid rgba(37,99,235,.15)}
 form.add input[type=text],form.add input[type=password]{padding-left:.75rem}
 .check{display:flex;align-items:center;gap:.625rem;font-size:.75rem;color:#475569;font-weight:500;cursor:pointer;user-select:none}
 .check input{width:1rem;height:1rem;border-radius:.25rem;accent-color:#2563eb;cursor:pointer}
 button.submit{margin-top:.75rem;width:100%;padding:.75rem 1rem;border:0;border-radius:.75rem;font-size:.875rem;font-weight:600;font-family:inherit;color:#fff;background:#2563eb;display:flex;align-items:center;justify-content:center;gap:.5rem;cursor:pointer;box-shadow:0 4px 6px -1px rgba(37,99,235,.2)}
 button.submit:hover{background:#1d4ed8}
 button.submit:active{background:#1e40af}
 footer{position:relative;z-index:1;width:100%;max-width:28rem;margin:0 auto;padding:2rem 1.5rem;display:flex;justify-content:center}
 .foot{display:flex;align-items:center;gap:.5rem;font-size:.75rem;color:#94a3b8}
 .foot svg{color:#2563eb;flex-shrink:0}
 table{width:100%;border-collapse:collapse;margin-top:1rem;font-size:.85rem}
 th,td{text-align:left;padding:.45rem .5rem;border-bottom:1px solid #e2e8f0}
 th{color:#334155;font-size:.75rem}
 .del{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;padding:.3rem .6rem;margin:0;border-radius:.4rem;font-size:.75rem;cursor:pointer}
 .del:hover{background:#fee2e2}
 a{color:#2563eb}
 .row{display:flex;justify-content:space-between;align-items:center}
</style></head><body>
<main><div class="wrap"><header><a href="/"><img src="/assets/isotopiq-logo.png" alt="isotopiq"></a></header><div class="card">${body}</div></div></main>
<footer><div class="foot">${ICONS.shieldCheck}<span>Secured with 256-bit TLS encryption</span></div></footer>
</body></html>`

const loginPage = (error) =>
  page(
    'Sign in',
    `<h1 class="center">Sign in</h1>
     <p class="sub center">Enter your credentials to access your account</p>
     ${error ? `<div class="err" role="alert"><span><b>•</b></span><span>${esc(error)}</span></div>` : ''}
     <form method="POST" action="/login">
       <div>
         <label class="fl" for="u">Username</label>
         <div class="field"><span class="lead">${ICONS.user}</span><input id="u" name="username" type="text" required autocomplete="username" placeholder="Your username"></div>
       </div>
       <div>
         <label class="fl" for="p">Password</label>
         <div class="field"><span class="lead">${ICONS.lock}</span>
           <input id="p" name="password" type="password" required autocomplete="current-password" placeholder="••••••••••••">
           <button type="button" class="trail" aria-label="Show password" onclick="var i=document.getElementById('p'),s=i.type==='password';i.type=s?'text':'password';this.setAttribute('aria-label',s?'Hide password':'Show password');this.children[0].style.display=s?'none':'flex';this.children[1].style.display=s?'flex':'none'"><span style="display:flex">${ICONS.eye}</span><span style="display:none">${ICONS.eyeOff}</span></button>
         </div>
       </div>
       <label class="check"><input type="checkbox" name="remember" value="1" checked><span>Remember me</span></label>
       <button class="submit" type="submit"><span>Sign in</span>${ICONS.arrowRight}</button>
     </form>`
  )

const adminPage = (users, me, notice = '') =>
  page(
    'User management',
    `<div class="row"><h1>User management</h1><a href="/">← app</a></div>
     ${notice ? `<div class="err">${esc(notice)}</div>` : ''}
     <table><tr><th>User</th><th>Role</th><th>Created</th><th></th></tr>
     ${users
       .map(
         (u) => `<tr><td>${esc(u.username)}</td>
           <td>${u.admin ? 'admin' : 'user'}</td>
           <td>${esc((u.createdAt ?? '').slice(0, 10))}</td>
           <td>${
             u.username === me
               ? ''
               : `<form method="POST" action="/admin/delete" onsubmit="return confirm('Delete ${esc(u.username)}?')"><input type="hidden" name="username" value="${esc(u.username)}"><button class="del">Delete</button></form>`
           }</td></tr>`
       )
       .join('')}
     </table>
     <h2>Add user</h2>
     <form method="POST" action="/admin/add" class="add">
       <label class="fl">Username</label><input name="username" type="text" required pattern="[A-Za-z0-9._-]{2,64}">
       <label class="fl">Password</label><input name="password" type="password" required minlength="8">
       <label class="check" style="margin-top:.75rem"><input type="checkbox" name="admin" value="1"><span>Admin</span></label>
       <button class="submit" type="submit">Add user</button>
     </form>
     <p style="margin-top:1.5rem"><a href="/logout">Sign out (${esc(me)})</a></p>`
  )

// ── proxy ─────────────────────────────────────────────────────────────────────
const proxy = httpProxy.createProxyServer({ target: UPSTREAM, ws: true, changeOrigin: false })
proxy.on('proxyReq', (proxyReq) => {
  // The backend only authenticates loopback hosts and matching origins (web-service/auth.ts);
  // rewrite Host to the upstream and drop the public Origin or every request 401s.
  proxyReq.setHeader('host', new URL(UPSTREAM).host)
  proxyReq.removeHeader('origin')
  const token = upstreamToken()
  if (token) proxyReq.setHeader('Authorization', `Bearer ${token}`)
})
proxy.on('error', (err, req, res) => {
  if (res.writeHead) {
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`Open-Science backend unavailable (${err.code ?? err.message}).`)
  } else res.end?.()
})

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers })
  res.end(body)
}
const readBody = (req) =>
  new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(parseQuery(data)))
  })
const sameOrigin = (req) => {
  const origin = req.headers.origin
  if (!origin) return true // non-browser clients
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}
const redirect = (res, to, extra = {}) =>
  res.writeHead(303, { location: to, ...extra }).end() || undefined

const isAdmin = (username) => loadUsers().some((u) => u.username === username && u.admin)

// ── server ────────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://gateway.local')
  const path = url.pathname
  const user = readSession(req.headers.cookie)

  if (path === '/assets/isotopiq-logo.png') {
    try {
      const png = readFileSync(new URL('./assets/isotopiq-logo.png', import.meta.url))
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' })
      return res.end(png)
    } catch {
      res.writeHead(404)
      return res.end()
    }
  }

  if (path === '/login') {
    if (req.method === 'GET') return send(res, 200, loginPage())
    if (req.method === 'POST' && sameOrigin(req)) {
      const body = await readBody(req)
      const account = loadUsers().find((u) => u.username === body.username)
      if (account && bcrypt.compareSync(body.password ?? '', account.passwordHash)) {
        const remember = body.remember === '1'
        const ttlMs = remember ? LONG_TTL_MS : SESSION_TTL_MS
        const maxAge = remember ? Math.floor(LONG_TTL_MS / 1000) : undefined
        return redirect(res, '/', {
          'set-cookie': cookieHeader(issueSession(account.username, ttlMs), maxAge)
        })
      }
      return send(res, 401, loginPage('Invalid username or password.'))
    }
  }
  if (path === '/logout') return redirect(res, '/login', { 'set-cookie': cookieHeader('x', 0) })

  if (!user) return redirect(res, '/login')

  if (path === '/admin') {
    if (!isAdmin(user)) return send(res, 403, page('Forbidden', '<h1>Admin only</h1><a href="/">← app</a>'))
    return send(res, 200, adminPage(loadUsers(), user))
  }
  if (path === '/admin/add' && req.method === 'POST') {
    if (!isAdmin(user) || !sameOrigin(req)) return send(res, 403, 'Forbidden')
    const body = await readBody(req)
    const users = loadUsers()
    const username = (body.username ?? '').trim()
    if (!/^[A-Za-z0-9._-]{2,64}$/.test(username))
      return send(res, 200, adminPage(users, user, 'Invalid username (2–64 chars: letters, digits, . _ -).'))
    if ((body.password ?? '').length < 8)
      return send(res, 200, adminPage(users, user, 'Password must be at least 8 characters.'))
    if (users.some((u) => u.username === username))
      return send(res, 200, adminPage(users, user, `User "${username}" already exists.`))
    users.push({
      username,
      passwordHash: bcrypt.hashSync(body.password, 10),
      admin: body.admin === '1',
      createdAt: new Date().toISOString()
    })
    saveUsers(users)
    return redirect(res, '/admin')
  }
  if (path === '/admin/delete' && req.method === 'POST') {
    if (!isAdmin(user) || !sameOrigin(req)) return send(res, 403, 'Forbidden')
    const body = await readBody(req)
    const target = (body.username ?? '').trim()
    if (target === user) return send(res, 200, adminPage(loadUsers(), user, 'You cannot delete your own account.'))
    const next = loadUsers().filter((u) => u.username !== target)
    if (!next.some((u) => u.admin))
      return send(res, 200, adminPage(loadUsers(), user, 'Refusing to remove the last admin.'))
    saveUsers(next)
    return redirect(res, '/admin')
  }

  proxy.web(req, res)
})

server.on('upgrade', (req, socket, head) => {
  if (!readSession(req.headers.cookie)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  req.headers.host = new URL(UPSTREAM).host
  delete req.headers.origin
  const token = upstreamToken()
  if (token) req.headers.authorization = `Bearer ${token}`
  proxy.ws(req, socket, head)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[gateway] Open-Science auth gateway listening on :${PORT} → ${UPSTREAM}`)
})

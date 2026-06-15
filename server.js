import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { discovery, buildEndSessionUrl } from 'openid-client';
import { Strategy } from 'openid-client/passport';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5000;

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
};

// Pages that require authentication
const PROTECTED_PAGES = ['/index.html', '/dac-hub.html', '/'];

// ── OIDC CONFIG (cached) ──────────────────────────────
let oidcConfig = null;
async function getOidcConfig() {
  if (!oidcConfig) {
    oidcConfig = await discovery(
      new URL(process.env.ISSUER_URL ?? 'https://replit.com/oidc'),
      process.env.REPL_ID
    );
  }
  return oidcConfig;
}

// ── PASSPORT STRATEGY (lazily registered per hostname) ──
const registeredStrategies = new Set();

function ensureStrategy(hostname, config) {
  const name = `replitauth:${hostname}`;
  if (!registeredStrategies.has(name)) {
    const strategy = new Strategy(
      {
        name,
        config,
        scope: 'openid email profile offline_access',
        callbackURL: `https://${hostname}/api/callback`,
      },
      (tokens, verified) => {
        const claims = tokens.claims();
        const user = {
          id: claims.sub,
          email: claims.email ?? null,
          firstName: claims.first_name ?? null,
          lastName: claims.last_name ?? null,
          profileImageUrl: claims.profile_image_url ?? null,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: claims.exp,
        };
        verified(null, user);
      }
    );
    passport.use(name, strategy);
    registeredStrategies.add(name);
  }
  return name;
}

// ── APP ───────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET ?? 'ming-factory-dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 1 week
  },
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, cb) => cb(null, user));
passport.deserializeUser((user, cb) => cb(null, user));

// ── AUTH ROUTES ───────────────────────────────────────

app.get('/api/login', async (req, res, next) => {
  try {
    const config = await getOidcConfig();
    const strategyName = ensureStrategy(req.hostname, config);
    passport.authenticate(strategyName, {
      prompt: 'login consent',
      scope: ['openid', 'email', 'profile', 'offline_access'],
    })(req, res, next);
  } catch (e) {
    next(e);
  }
});

app.get('/api/callback', async (req, res, next) => {
  try {
    const config = await getOidcConfig();
    const strategyName = ensureStrategy(req.hostname, config);
    passport.authenticate(strategyName, {
      successRedirect: '/',
      failureRedirect: '/login',
    })(req, res, next);
  } catch (e) {
    next(e);
  }
});

app.get('/api/logout', async (req, res) => {
  req.logout(() => {});
  req.session.destroy(() => {});
  try {
    const config = await getOidcConfig();
    const endUrl = buildEndSessionUrl(config, {
      client_id: process.env.REPL_ID,
      post_logout_redirect_uri: `${req.protocol}://${req.hostname}`,
    });
    res.redirect(endUrl.href);
  } catch {
    res.redirect('/login');
  }
});

app.get('/api/me', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({ authenticated: true, user: req.user });
});

// ── AUTH GATE MIDDLEWARE ──────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

// ── STATIC FILE SERVING ───────────────────────────────

// Public: /login page and /assets without auth
app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'login.html'));
});

// Serve assets (images etc.) publicly — no auth needed
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Protected game pages
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/index.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/dac-hub.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'dac-hub.html'));
});

// Everything else: serve statically (JS, CSS, etc.) — no auth needed for static resources
app.use((req, res, next) => {
  const urlPath = req.url.split('?')[0];
  const filePath = path.join(__dirname, urlPath);
  const ext = path.extname(filePath);

  // Only serve files that exist and aren't protected HTML pages
  if (PROTECTED_PAGES.includes(urlPath)) {
    return requireAuth(req, res, next);
  }

  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) return res.status(404).send('Not found');
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  });
});

// ── START ─────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Ming's Factory Slots running on port ${PORT}`);
});

import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { discovery, buildEndSessionUrl } from 'openid-client';
import { Strategy } from 'openid-client/passport';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5000;

// ── DATABASE ──────────────────────────────────────────
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function getGameState(userId) {
  const r = await db.query(
    `INSERT INTO user_game_state (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING dac_balance, total_won, spins, big_wins`,
    [userId]
  );
  return r.rows[0];
}

async function saveGameState(userId, { dacBalance, totalWon, spins, bigWins }) {
  await db.query(
    `INSERT INTO user_game_state (user_id, dac_balance, total_won, spins, big_wins, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       dac_balance = EXCLUDED.dac_balance,
       total_won   = EXCLUDED.total_won,
       spins       = EXCLUDED.spins,
       big_wins    = EXCLUDED.big_wins,
       updated_at  = NOW()`,
    [userId, dacBalance, totalWon, spins, bigWins]
  );
}

async function addTransaction(userId, { type, description, dacAmount, solAmount, txSig }) {
  const r = await db.query(
    `INSERT INTO user_transactions (user_id, type, description, dac_amount, sol_amount, tx_sig)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
    [userId, type, description, dacAmount, solAmount ?? 0, txSig ?? null]
  );
  return r.rows[0];
}

async function getTransactions(userId, limit = 20) {
  const r = await db.query(
    `SELECT id, type, description, dac_amount, sol_amount, tx_sig, created_at
     FROM user_transactions WHERE user_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return r.rows;
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
};

const PROTECTED_PAGES = ['/index.html', '/dac-hub.html', '/'];

// ── OIDC ──────────────────────────────────────────────
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

const registeredStrategies = new Set();
function ensureStrategy(hostname, config) {
  const name = `replitauth:${hostname}`;
  if (!registeredStrategies.has(name)) {
    passport.use(name, new Strategy(
      { name, config, scope: 'openid email profile offline_access', callbackURL: `https://${hostname}/api/callback` },
      (tokens, verified) => {
        const c = tokens.claims();
        verified(null, { id: c.sub, email: c.email ?? null, firstName: c.first_name ?? null,
          lastName: c.last_name ?? null, profileImageUrl: c.profile_image_url ?? null,
          accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: c.exp });
      }
    ));
    registeredStrategies.add(name);
  }
  return name;
}

// ── APP ───────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET ?? 'ming-dev-secret',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));
app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser((u, cb) => cb(null, u));
passport.deserializeUser((u, cb) => cb(null, u));

// ── AUTH ROUTES ───────────────────────────────────────
app.get('/api/login', async (req, res, next) => {
  try {
    const config = await getOidcConfig();
    passport.authenticate(ensureStrategy(req.hostname, config), { prompt: 'login consent', scope: ['openid','email','profile','offline_access'] })(req, res, next);
  } catch (e) { next(e); }
});

app.get('/api/callback', async (req, res, next) => {
  try {
    const config = await getOidcConfig();
    passport.authenticate(ensureStrategy(req.hostname, config), { successRedirect: '/', failureRedirect: '/login' })(req, res, next);
  } catch (e) { next(e); }
});

app.get('/api/logout', async (req, res) => {
  req.logout(() => {});
  req.session.destroy(() => {});
  try {
    const config = await getOidcConfig();
    res.redirect(buildEndSessionUrl(config, { client_id: process.env.REPL_ID, post_logout_redirect_uri: `${req.protocol}://${req.hostname}` }).href);
  } catch { res.redirect('/login'); }
});

app.get('/api/me', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user: req.user });
});

// ── GAME STATE API ────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  if (req.accepts('json') && !req.accepts('html')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

// GET /api/game/state — load state for the logged-in user
app.get('/api/game/state', requireAuth, async (req, res) => {
  try {
    const state = await getGameState(req.user.id);
    res.json({
      dacBalance: state.dac_balance,
      totalWon:   state.total_won,
      spins:      state.spins,
      bigWins:    state.big_wins,
    });
  } catch (e) {
    console.error('getGameState error:', e);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/game/state — save state
app.post('/api/game/state', requireAuth, async (req, res) => {
  try {
    const { dacBalance, totalWon, spins, bigWins } = req.body;
    await saveGameState(req.user.id, {
      dacBalance: Math.max(0, Math.round(dacBalance)),
      totalWon:   Math.max(0, Math.round(totalWon)),
      spins:      Math.max(0, Math.round(spins)),
      bigWins:    Math.max(0, Math.round(bigWins)),
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('saveGameState error:', e);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/game/purchase — record a DAC purchase and credit balance
app.post('/api/game/purchase', requireAuth, async (req, res) => {
  try {
    const { dacAmount, solAmount, txSig, description } = req.body;
    if (!dacAmount || dacAmount < 1) return res.status(400).json({ error: 'Invalid amount' });

    // Credit balance
    await db.query(
      `INSERT INTO user_game_state (user_id, dac_balance, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         dac_balance = user_game_state.dac_balance + $2,
         updated_at  = NOW()`,
      [req.user.id, Math.round(dacAmount)]
    );

    // Record transaction
    const tx = await addTransaction(req.user.id, {
      type: 'purchase', description: description ?? `Bought ${dacAmount} DAC`,
      dacAmount: Math.round(dacAmount), solAmount, txSig,
    });

    // Return updated balance
    const state = await getGameState(req.user.id);
    res.json({ ok: true, txId: tx.id, newBalance: state.dac_balance });
  } catch (e) {
    console.error('purchase error:', e);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/game/history — transaction history
app.get('/api/game/history', requireAuth, async (req, res) => {
  try {
    const txs = await getTransactions(req.user.id, 20);
    res.json(txs);
  } catch (e) {
    console.error('history error:', e);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── STATIC SERVING ────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.use('/assets', express.static(path.join(__dirname, 'assets')));

app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/dac-hub.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'dac-hub.html')));

app.use((req, res) => {
  const urlPath = req.url.split('?')[0];
  const filePath = path.join(__dirname, urlPath);
  if (PROTECTED_PAGES.includes(urlPath)) return requireAuth(req, res, () => res.sendFile(filePath));
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) return res.status(404).send('Not found');
    res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Ming's Factory Slots running on port ${PORT}`));

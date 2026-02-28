// ============================================================
// server.js — Backend API Server
// Express + Supabase Auth + Stripe + Gemini AI Proxy
// ============================================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── External Services ────────────────────────────────────

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

const PLAN_QUOTAS = {
    free: 0,
    starter: parseInt(process.env.QUOTA_STARTER) || 30,
    pro: parseInt(process.env.QUOTA_PRO) || 999999,
};

// ─── Middleware ────────────────────────────────────────────

app.use(helmet());
app.use(cors({
    origin: [
        'chrome-extension://*',           // Chrome extensions
        'http://localhost:*',             // Local dev
    ],
}));

// Stripe webhook needs raw body
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
    windowMs: 60 * 1000,  // 1 minute
    max: 30,               // 30 requests per minute
    message: { error: 'Too many requests. Please slow down.' },
});
app.use('/api/', limiter);

// ─── Auth Middleware ──────────────────────────────────────

function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        req.userEmail = decoded.email;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// ─── Auth Routes ──────────────────────────────────────────

// Register
app.post('/auth/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        // Check if user exists
        const { data: existing } = await supabase
            .from('users')
            .select('id')
            .eq('email', email)
            .single();

        if (existing) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        // Hash password and create user
        const passwordHash = await bcrypt.hash(password, 12);
        const { data: user, error } = await supabase
            .from('users')
            .insert({
                email,
                password_hash: passwordHash,
                plan: 'free',
                usage_count: 0,
                usage_reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            })
            .select()
            .single();

        if (error) throw error;

        // Generate token
        const token = jwt.sign(
            { userId: user.id, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.status(201).json({ token, user: { id: user.id, email: user.email, plan: 'free' } });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login
app.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('email', email)
            .single();

        if (!user || error) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const token = jwt.sign(
            { userId: user.id, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                plan: user.plan,
                usageCount: user.usage_count,
                usageLimit: PLAN_QUOTAS[user.plan] || 0,
            },
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

// ─── AI Proxy Route ───────────────────────────────────────

app.post('/api/ai', authenticate, async (req, res) => {
    try {
        // Get user and check quota
        const { data: user, error: userErr } = await supabase
            .from('users')
            .select('*')
            .eq('id', req.userId)
            .single();

        if (!user || userErr) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Check if user has a paid plan
        if (user.plan === 'free') {
            return res.status(403).json({ error: 'AI features require a paid plan' });
        }

        // Reset usage if period expired
        if (new Date(user.usage_reset_at) < new Date()) {
            await supabase
                .from('users')
                .update({
                    usage_count: 0,
                    usage_reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                })
                .eq('id', user.id);
            user.usage_count = 0;
        }

        // Check quota
        const quota = PLAN_QUOTAS[user.plan] || 0;
        if (user.usage_count >= quota) {
            return res.status(429).json({ error: 'Monthly quota exceeded' });
        }

        // Proxy to Gemini
        const { prompt, temperature = 0.3, maxTokens = 1024 } = req.body;
        if (!prompt) {
            return res.status(400).json({ error: 'Prompt required' });
        }

        const geminiRes = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature,
                    maxOutputTokens: maxTokens,
                    responseMimeType: 'application/json',
                },
            }),
        });

        if (!geminiRes.ok) {
            const errText = await geminiRes.text();
            console.error('Gemini error:', geminiRes.status, errText);
            return res.status(502).json({ error: 'AI service error' });
        }

        const geminiData = await geminiRes.json();
        const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';

        // Increment usage
        await supabase
            .from('users')
            .update({ usage_count: user.usage_count + 1 })
            .eq('id', user.id);

        res.json({ text });
    } catch (err) {
        console.error('AI proxy error:', err);
        res.status(500).json({ error: 'AI request failed' });
    }
});

// ─── Usage Route ──────────────────────────────────────────

app.get('/api/usage', authenticate, async (req, res) => {
    try {
        const { data: user } = await supabase
            .from('users')
            .select('plan, usage_count, usage_reset_at')
            .eq('id', req.userId)
            .single();

        if (!user) return res.status(404).json({ error: 'User not found' });

        res.json({
            plan: user.plan,
            used: user.usage_count,
            limit: PLAN_QUOTAS[user.plan] || 0,
            resetsAt: user.usage_reset_at,
        });
    } catch (err) {
        console.error('Usage error:', err);
        res.status(500).json({ error: 'Failed to get usage' });
    }
});

// ─── Stripe Checkout ──────────────────────────────────────

app.post('/api/checkout', authenticate, async (req, res) => {
    try {
        const { plan } = req.body; // 'starter' or 'pro'
        const priceId = plan === 'pro'
            ? process.env.STRIPE_PRO_PRICE_ID
            : process.env.STRIPE_STARTER_PRICE_ID;

        if (!priceId) {
            return res.status(400).json({ error: 'Invalid plan' });
        }

        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${req.headers.origin || 'http://localhost:3001'}/success`,
            cancel_url: `${req.headers.origin || 'http://localhost:3001'}/cancel`,
            metadata: { userId: req.userId },
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error('Checkout error:', err);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// ─── Stripe Webhook ───────────────────────────────────────

app.post('/webhooks/stripe', async (req, res) => {
    let event;

    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            req.headers['stripe-signature'],
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object;
            const userId = session.metadata?.userId;
            if (userId) {
                // Determine plan from price
                const subscription = await stripe.subscriptions.retrieve(session.subscription);
                const priceId = subscription.items.data[0]?.price?.id;
                const plan = priceId === process.env.STRIPE_PRO_PRICE_ID ? 'pro' : 'starter';

                await supabase
                    .from('users')
                    .update({
                        plan,
                        stripe_customer_id: session.customer,
                        stripe_subscription_id: session.subscription,
                    })
                    .eq('id', userId);

                console.log(`User ${userId} upgraded to ${plan}`);
            }
            break;
        }

        case 'customer.subscription.deleted': {
            const sub = event.data.object;
            await supabase
                .from('users')
                .update({ plan: 'free' })
                .eq('stripe_subscription_id', sub.id);
            console.log(`Subscription ${sub.id} cancelled → downgraded to free`);
            break;
        }
    }

    res.json({ received: true });
});

// ─── Health Check ─────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '1.0.0' });
});

// ─── Start Server ─────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`🚀 Amazon Optimizer Backend running on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
});

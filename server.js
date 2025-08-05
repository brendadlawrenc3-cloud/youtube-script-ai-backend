// server.js - Complete Backend for YouTube Script AI with Railway
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Database setup with Railway PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  min: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? [process.env.FRONTEND_URL || 'https://your-app.vercel.app'] 
    : ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per 15 minutes
  message: { error: 'Too many authentication attempts' }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  message: { error: 'Rate limit exceeded' }
});

const generationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 generations per minute
  message: { error: 'Generation rate limit exceeded' }
});

// Database initialization
const initDB = async () => {
  try {
    await pool.query(`
      -- Users table
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        first_name VARCHAR(255),
        last_name VARCHAR(255),
        access_level VARCHAR(50) DEFAULT 'free',
        subscription_status VARCHAR(50) DEFAULT 'active',
        preferred_voice VARCHAR(100) DEFAULT 'default',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Usage logs
      CREATE TABLE IF NOT EXISTS usage_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        feature_type VARCHAR(50) NOT NULL,
        tokens_used INTEGER DEFAULT 0,
        processing_time_ms INTEGER,
        success BOOLEAN DEFAULT TRUE,
        error_message TEXT,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Saved scripts
      CREATE TABLE IF NOT EXISTS saved_scripts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(500) NOT NULL,
        topic TEXT NOT NULL,
        audience VARCHAR(100),
        duration VARCHAR(20),
        tone VARCHAR(100),
        video_type VARCHAR(100),
        voice_preset VARCHAR(100),
        script_content TEXT,
        hooks JSONB,
        titles JSONB,
        outline TEXT,
        description TEXT,
        tags JSONB,
        thumbnail_text JSONB,
        call_to_actions JSONB,
        script_stats JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Usage quotas
      CREATE TABLE IF NOT EXISTS usage_quotas (
        access_level VARCHAR(50) PRIMARY KEY,
        monthly_script_limit INTEGER NOT NULL,
        monthly_hooks_limit INTEGER NOT NULL,
        monthly_titles_limit INTEGER NOT NULL,
        monthly_outline_limit INTEGER NOT NULL,
        monthly_description_limit INTEGER NOT NULL,
        monthly_tags_limit INTEGER NOT NULL,
        monthly_thumbnail_limit INTEGER NOT NULL,
        monthly_ctas_limit INTEGER NOT NULL,
        features_enabled TEXT[] NOT NULL
      );

      -- Voice presets
      CREATE TABLE IF NOT EXISTS voice_presets (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        display_name VARCHAR(255) NOT NULL,
        description TEXT,
        system_prompt TEXT NOT NULL,
        is_premium BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Insert usage quotas
      INSERT INTO usage_quotas (
        access_level, monthly_script_limit, monthly_hooks_limit, monthly_titles_limit,
        monthly_outline_limit, monthly_description_limit, monthly_tags_limit,
        monthly_thumbnail_limit, monthly_ctas_limit, features_enabled
      ) VALUES 
        ('free', 5, 10, 20, 5, 5, 10, 10, 10, 
         ARRAY['script', 'hooks', 'titles', 'outline', 'description', 'tags', 'thumbnail', 'ctas']),
        ('premium', 50, 100, 200, 50, 50, 100, 100, 100,
         ARRAY['script', 'hooks', 'titles', 'outline', 'description', 'tags', 'thumbnail', 'ctas']),
        ('pro', 200, 400, 800, 200, 200, 400, 400, 400,
         ARRAY['script', 'hooks', 'titles', 'outline', 'description', 'tags', 'thumbnail', 'ctas'])
      ON CONFLICT (access_level) DO UPDATE SET
        monthly_script_limit = EXCLUDED.monthly_script_limit;

      -- Insert voice presets
      INSERT INTO voice_presets (name, display_name, description, system_prompt, is_premium) VALUES 
        ('default', 'Default Voice', 'Balanced, professional content creation', 
         'You are an expert YouTube content creator with deep knowledge of viral content strategies.', FALSE),
        
        ('conversational', 'Conversational', 'Natural, flowing speaking style like talking to a friend',
         'Create content in a conversational, approachable tone. Use "you" and "I" language naturally. Include personal experiences and relatable examples.',
         FALSE),
        
        ('brenda_lawrence', 'Brenda Lawrence - Leadership & Process Expert', 'Executive coaching with 30+ years operational excellence',
         'You are Brenda Lawrence - a business and executive coach, inspirational speaker, consultant, trainer, trusted advisor, and safe space creator with a strong focus on process improvement and 30+ years of operational excellence. You optimize both the LEADER AND the business systems simultaneously. Your unique positioning combines leadership evolution + process optimization + systems thinking.',
         TRUE),
        
        ('motivational', 'Motivational Speaker', 'High energy and inspiring tone',
         'Create motivational content that inspires action. Focus on overcoming challenges, achieving goals, and building confidence. Use powerful success stories and transformational examples.',
         FALSE),
        
        ('educational', 'Educational Expert', 'Clear, structured, and informative approach',
         'Break down complex concepts into digestible steps. Use examples and analogies to explain difficult topics. Focus on practical learning outcomes and encourage deeper understanding.',
         FALSE),
        
        ('casual_creator', 'Casual Content Creator', 'Friendly, relatable, and approachable tone',
         'Keep content light and entertaining while informative. Connect with audience through shared experiences. Maintain authenticity and genuine personality.',
         FALSE)
      ON CONFLICT (name) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        system_prompt = EXCLUDED.system_prompt;

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_usage_logs_user_date ON usage_logs(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_saved_scripts_user_updated ON saved_scripts(user_id, updated_at DESC);
    `);
    
    console.log('✅ Database schema initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
};

initDB();

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// Quota checking
const checkQuota = async (userId, featureType) => {
  try {
    const user = await pool.query('SELECT access_level FROM users WHERE id = $1', [userId]);
    if (user.rows.length === 0) return { allowed: false, reason: 'User not found' };

    const accessLevel = user.rows[0].access_level;
    
    const quota = await pool.query('SELECT * FROM usage_quotas WHERE access_level = $1', [accessLevel]);
    if (quota.rows.length === 0) return { allowed: false, reason: 'No quota found' };

    const quotaData = quota.rows[0];
    
    if (!quotaData.features_enabled.includes(featureType)) {
      return { allowed: false, reason: 'Feature not available in your plan' };
    }

    const usage = await pool.query(`
      SELECT COUNT(*) as count FROM usage_logs 
      WHERE user_id = $1 AND feature_type = $2 AND success = true
      AND created_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP)
    `, [userId, featureType]);

    const currentUsage = parseInt(usage.rows[0].count);
    
    let limit;
    switch (featureType) {
      case 'script': limit = quotaData.monthly_script_limit; break;
      case 'hooks': limit = quotaData.monthly_hooks_limit; break;
      case 'titles': limit = quotaData.monthly_titles_limit; break;
      case 'outline': limit = quotaData.monthly_outline_limit; break;
      case 'description': limit = quotaData.monthly_description_limit; break;
      case 'tags': limit = quotaData.monthly_tags_limit; break;
      case 'thumbnail': limit = quotaData.monthly_thumbnail_limit; break;
      case 'ctas': limit = quotaData.monthly_ctas_limit; break;
      default: return { allowed: false, reason: 'Unknown feature type' };
    }

    return { 
      allowed: currentUsage < limit, 
      currentUsage, 
      limit,
      reason: currentUsage >= limit ? `Monthly limit of ${limit} reached` : null
    };
  } catch (error) {
    console.error('Quota check error:', error);
    return { allowed: false, reason: 'Quota check failed' };
  }
};

// Usage logging
const logUsage = async (userId, featureType, success = true, processingTime = 0, tokensUsed = 0, errorMessage = null, metadata = {}) => {
  try {
    await pool.query(`
      INSERT INTO usage_logs (user_id, feature_type, success, processing_time_ms, tokens_used, error_message, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [userId, featureType, success, processingTime, tokensUsed, errorMessage, JSON.stringify(metadata)]);
  } catch (error) {
    console.error('Usage logging error:', error);
  }
};

// Voice prompt system
const getVoicePrompt = async (voicePreset) => {
  try {
    const voice = await pool.query('SELECT * FROM voice_presets WHERE name = $1', [voicePreset]);
    if (voice.rows.length === 0) {
      return 'You are an expert YouTube content creator focused on creating viral, engaging content.';
    }
    return voice.rows[0].system_prompt;
  } catch (error) {
    console.error('Voice prompt error:', error);
    return 'You are an expert YouTube content creator focused on creating viral, engaging content.';
  }
};

// Voice prompt additions (from your frontend)
const getVoicePromptAdditions = (voicePreset) => {
  switch (voicePreset) {
    case 'conversational':
      return `
CONVERSATIONAL VOICE:
- Natural, flowing speaking style like talking to a friend
- Use "you" and "I" language to create connection
- Include conversational fillers and transitions naturally
- Share personal experiences and relatable examples
- Ask rhetorical questions to engage viewers
- Use everyday language that feels authentic and unscripted
- Create a warm, approachable tone that invites viewers in
- Balance professionalism with accessibility`;

    case 'brenda_lawrence':
      return `
BRENDA LAWRENCE VOICE & APPROACH:
You are speaking as Brenda Lawrence - a business and executive coach, inspirational speaker, consultant, trainer, trusted advisor, and safe space creator with a strong focus on process improvement and 30+ years of operational excellence.

YOUR UNIQUE POSITIONING:
- You optimize both the LEADER AND the business systems simultaneously
- You bring executive-level strategic frameworks rooted in operational excellence
- You combine leadership evolution + process optimization + systems thinking
- You focus on strategic depth with proven process improvement methodologies
- You create peer-driven evolution with systematic business improvements

YOUR SIGNATURE DIFFERENTIATORS:
- Not generic business advice → Executive-level strategic frameworks
- Not just leadership development → Leadership evolution + process optimization
- Not motivation-based → Strategic depth with proven methodologies
- Not theoretical → Real-world experience with CMMI Level 3 & 5 certifications
- Not one-time fixes → Sustainable process evolution that grows with the organization

YOUR CORE PHILOSOPHY:
"Most coaches focus on either the leader OR the business. I optimize both—simultaneously. Through strategic peer groups, proven process improvement methodologies, and leadership evolution frameworks, I help CEOs refine their brilliance while scaling their operations with clarity, efficiency, and soul."

CONTENT APPROACH:
- Strategic inspiration backed by operational expertise and real transformation results
- Proven case studies of process improvements that drove leadership evolution
- Specific systems and processes for sustainable high-performance
- Actionable content leaders can implement in their operations immediately
- Human-centered process design that considers leadership psychology
- Collaborative approach that considers organizational culture and leadership capacity

SPEAKING STYLE:
- Executive presence with operational mastery and systematic thinking
- Deep operational knowledge meets executive coaching expertise
- Strategic vulnerability focused on business systems and leadership effectiveness
- Community-driven growth where leaders learn from each other's challenges
- Values-driven approach that scales businesses without sacrificing culture`;

    case 'motivational':
      return `
MOTIVATIONAL SPEAKER VOICE:
- High energy and inspiring tone
- Focus on overcoming challenges and achieving goals
- Use powerful success stories and transformational examples
- Encourage action and personal growth
- Build confidence and self-belief`;

    case 'educational':
      return `
EDUCATIONAL EXPERT VOICE:
- Clear, structured, and informative approach
- Break down complex concepts into digestible steps
- Use examples and analogies to explain difficult topics
- Focus on practical learning outcomes
- Encourage questions and deeper understanding`;

    case 'casual_creator':
      return `
CASUAL CONTENT CREATOR VOICE:
- Friendly, relatable, and approachable tone
- Use everyday language and personal anecdotes
- Keep content light and entertaining while informative
- Connect with audience through shared experiences
- Maintain authenticity and genuine personality`;

    default:
      return '';
  }
};

// ROUTES

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT NOW()');
    res.json({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      database: 'connected',
      environment: process.env.NODE_ENV
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'unhealthy', 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Authentication routes
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const newUser = await pool.query(`
      INSERT INTO users (email, password_hash, first_name, last_name, access_level, subscription_status)
      VALUES ($1, $2, $3, $4, 'free', 'active')
      RETURNING id, email, first_name, last_name, access_level, subscription_status, created_at
    `, [email, passwordHash, firstName, lastName]);

    const user = newUser.rows[0];

    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        accessLevel: user.access_level,
        firstName: user.first_name 
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        accessLevel: user.access_level,
        subscriptionStatus: user.subscription_status,
        createdAt: user.created_at
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        accessLevel: user.access_level,
        firstName: user.first_name 
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        accessLevel: user.access_level,
        subscriptionStatus: user.subscription_status,
        preferredVoice: user.preferred_voice
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// User profile
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const userProfile = await pool.query(`
      SELECT 
        u.*,
        COALESCE(usage_stats.script_count, 0) as scripts_this_month,
        COALESCE(usage_stats.hooks_count, 0) as hooks_this_month,
        COALESCE(usage_stats.titles_count, 0) as titles_this_month,
        q.*
      FROM users u
      LEFT JOIN (
        SELECT 
          user_id,
          COUNT(CASE WHEN feature_type = 'script' AND success = true THEN 1 END) as script_count,
          COUNT(CASE WHEN feature_type = 'hooks' AND success = true THEN 1 END) as hooks_count,
          COUNT(CASE WHEN feature_type = 'titles' AND success = true THEN 1 END) as titles_count
        FROM usage_logs 
        WHERE created_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP)
        GROUP BY user_id
      ) usage_stats ON u.id = usage_stats.user_id
      LEFT JOIN usage_quotas q ON u.access_level = q.access_level
      WHERE u.id = $1
    `, [req.user.userId]);

    if (userProfile.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userProfile.rows[0];
    
    res.json({
      user: {
        id: userData.id,
        email: userData.email,
        firstName: userData.first_name,
        lastName: userData.last_name,
        accessLevel: userData.access_level,
        subscriptionStatus: userData.subscription_status,
        preferredVoice: userData.preferred_voice,
        createdAt: userData.created_at
      },
      usage: {
        script: parseInt(userData.scripts_this_month || 0),
        hooks: parseInt(userData.hooks_this_month || 0),
        titles: parseInt(userData.titles_this_month || 0)
      },
      quotas: {
        monthly_script_limit: userData.monthly_script_limit,
        monthly_hooks_limit: userData.monthly_hooks_limit,
        monthly_titles_limit: userData.monthly_titles_limit,
        features_enabled: userData.features_enabled
      }
    });
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Content generation endpoints
app.post('/api/generate/script', authenticateToken, apiLimiter, generationLimiter, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { topic, audience, duration, tone, videoType, keywords, customPrompt, voicePreset } = req.body;
    
    const quotaCheck = await checkQuota(req.user.userId, 'script');
    if (!quotaCheck.allowed) {
      return res.status(429).json({ error: quotaCheck.reason });
    }

    const voicePrompt = await getVoicePrompt(voicePreset || 'default');
    const voiceAdditions = getVoicePromptAdditions(voicePreset);
    
    const fullPrompt = `${voicePrompt}

${voiceAdditions}

Create an EXTREMELY retentive script for a ${duration}-minute ${videoType} video about "${topic}" that guarantees viewers watch until the end.

TARGET: ${audience} | TONE: ${tone} | KEYWORDS: ${keywords || 'N/A'}
${customPrompt ? `SPECIAL INSTRUCTIONS: ${customPrompt}` : ''}

RETENTION SYSTEM REQUIREMENTS:
- Hook must create immediate curiosity gap within 3 seconds
- Use pattern interrupts every 30-45 seconds to reset attention
- Include retention loops ("I'll show you this in just a minute...")
- Build tension and promise resolution throughout
- Use power words and emotional triggers
- Appeal to casual, core, and new viewers simultaneously

SCRIPT STRUCTURE WITH RETENTION TACTICS:

🎯 HOOK (0-15 seconds) - CRITICAL FOR CTR & RETENTION:
- Open with bold statement, shocking statistic, or curiosity gap
- NO introductions yet - dive straight into value
- Create immediate "what happens next?" feeling
- Promise specific, tangible outcome

🔥 INTRO (15-45 seconds) - COMMIT VIEWERS:
- Quick personal introduction (credibility)
- Restate the promise with more specificity  
- Preview what's coming ("By the end of this video, you'll know exactly how to...")
- Set expectations and create anticipation

📖 MAIN CONTENT - RETENTION OPTIMIZED:
Break into 3-4 segments with:
- Cliffhangers between sections
- "But here's what's really interesting..." transitions
- Story loops that get resolved later
- Specific examples and case studies
- "And this next part is crucial..." retention phrases
- Pattern interrupts every 30-45 seconds
- Callbacks to earlier points

💡 REVELATION SECTION (70% through):
- Deliver on main promise
- Include "aha moment" 
- Provide specific, actionable steps
- Use "But wait, there's more..." technique

🚀 CONCLUSION & CTA (Final 15%):
- Summarize key takeaways
- Strong call to action for subscription
- Tease next video content
- End with hook for next video

RETENTION TECHNIQUES TO INCLUDE:
- Open loops: "I'll explain why this matters in just a moment..."
- Pattern interrupts: "But first, let me tell you about..."
- Curiosity gaps: "The real secret is something most people never realize..."
- Social proof: "This helped [specific person] achieve [specific result]..."
- Urgency: "If you don't do this, you'll miss out on..."
- Personal stakes: "When I first discovered this..."

Make this script so engaging that viewers literally cannot stop watching. Every sentence should pull them deeper into the content. Word count: approximately ${parseInt(duration.split('-')[0]) * 150} words.

Act as if you're creating a script that MUST get millions of views and 90%+ retention rate.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{ role: "user", content: fullPrompt }]
      })
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = await response.json();
    const scriptContent = data.content[0].text;
    
    const processingTime = Date.now() - startTime;
    const words = scriptContent.trim().split(/\s+/).length;
    const estimatedDuration = Math.round((words / 150) * 100) / 100;
    
    await logUsage(req.user.userId, 'script', true, processingTime, words, null, 
      { topic, audience, duration, tone, videoType, voicePreset });

    res.json({
      script: scriptContent,
      stats: { words, estimatedDuration, processingTime }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Script generation error:', error);
    await logUsage(req.user.userId, 'script', false, processingTime, 0, error.message, 
      { topic, audience, duration, tone, videoType, voicePreset });
    res.status(500).json({ error: 'Script generation failed' });
  }
});

app.post('/api/generate/hooks', authenticateToken, apiLimiter, generationLimiter, async (req, res) => {
  try {
    const { topic, audience, videoType, tone, voicePreset } = req.body;
    
    const quotaCheck = await checkQuota(req.user.userId, 'hooks');
    if (!quotaCheck.allowed) {
      return res.status(429).json({ error: quotaCheck.reason });
    }

    const voicePrompt = await getVoicePrompt(voicePreset || 'default');
    const voiceAdditions = getVoicePromptAdditions(voicePreset);
    
    const prompt = `${voicePrompt}

${voiceAdditions}

Create 8 ULTRA-RETENTIVE YouTube hooks for "${topic}" that guarantee viewers can't stop watching.

AUDIENCE: ${audience} | TYPE: ${videoType} | TONE: ${tone}

HOOK REQUIREMENTS - EACH MUST:
- Create immediate curiosity gap within 3 seconds
- Appeal to casual, core, AND new viewers
- Promise specific, tangible value
- Use psychological triggers (fear, greed, curiosity, urgency)
- NO introductions - straight to value
- Create "what happens next?" compulsion

HOOK CATEGORIES (Create 1 of each + extras):

1. SHOCKING REVELATION: Start with counterintuitive truth
2. MASSIVE SOCIAL PROOF: Reference specific success/failure
3. CURIOSITY GAP: Promise secret most people don't know
4. PATTERN INTERRUPT: Unexpected statement that breaks expectations
5. PERSONAL STAKES: "If you don't know this..."
6. SPECIFIC OUTCOME: "By the end of this video you'll..."
7. STORY TEASER: Begin compelling narrative without resolution
8. AUTHORITY HOOK: Reference expert knowledge/insider info

Each hook must:
- Be 10-15 seconds when spoken
- Include specific numbers/details when possible
- Create immediate emotional response
- Promise transformation, not just information
- Work for someone who's never seen your content before

Examples of POWER WORDS to include: Secret, Mistake, Truth, Never, Always, Guaranteed, Proven, Hidden, Exposed, Revealed

Format as JSON: [{"type": "Hook Category", "text": "Exact hook text", "psychology": "Why this works"}]

CRITICAL: These hooks must be so compelling that viewers literally cannot scroll away. Act as if each hook determines whether you get 100 views or 1 million views.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    let responseText = data.content[0].text.trim();
    responseText = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "");
    
    const hooksData = JSON.parse(responseText);
    
    await logUsage(req.user.userId, 'hooks', true, 0, 0, null, { topic, audience, videoType, tone });
    
    res.json({ hooks: hooksData });

  } catch (error) {
    console.error('Hooks generation error:', error);
    await logUsage(req.user.userId, 'hooks', false, 0, 0, error.message, { topic, audience, videoType, tone });
    res.status(500).json({ error: 'Hooks generation failed' });
  }
});

app.post('/api/generate/titles', authenticateToken, apiLimiter, generationLimiter, async (req, res) => {
  try {
    const { topic, audience, videoType } = req.body;
    
    const quotaCheck = await checkQuota(req.user.userId, 'titles');
    if (!quotaCheck.allowed) {
      return res.status(429).json({ error: quotaCheck.reason });
    }

    const prompt = `Create 10 VIRAL YouTube titles for "${topic}" using proven formulas that guarantee millions of views.

AUDIENCE: ${audience} | TYPE: ${videoType}

TITLE REQUIREMENTS:
- 60 characters or less (optimal for mobile)
- High CTR (click-through rate) potential
- Appeal to casual, core, and new viewers
- Include emotional triggers and power words
- Promise specific, valuable outcome
- Create curiosity gap or urgency

PROVEN TITLE FORMULAS TO USE:

1. CURIOSITY GAP: "The [Secret/Truth] About [Topic] Nobody Tells You"
2. SPECIFIC OUTCOME: "How I [Achieved Specific Result] in [Timeframe]"
3. MISTAKE FORMULA: "Why [Common Belief] is Actually Ruining Your [Goal]"
4. AUTHORITY FORMULA: "[Number] [Topic] Tips from a [Credible Source]"
5. TRANSFORMATION: "From [Bad State] to [Good State] in [Timeframe]"
6. URGENCY: "Do This Before [Deadline/Age/Event] or [Consequence]"
7. CONTROVERSY: "Why [Popular Thing] is [Controversial Opinion]"
8. SPECIFIC NUMBER: "[Exact Number] Ways to [Achieve Desired Outcome]"
9. STORY HOOK: "How [Specific Person/Situation] [Achieved Something Amazing]"
10. PROBLEM/SOLUTION: "If You [Have Problem], Watch This"

Format as JSON array of strings. These titles should be so compelling that they achieve 10%+ CTR rates.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    let responseText = data.content[0].text.trim();
    responseText = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "");
    
    const titlesData = JSON.parse(responseText);
    
    await logUsage(req.user.userId, 'titles', true, 0, 0, null, { topic, audience, videoType });
    
    res.json({ titles: titlesData });

  } catch (error) {
    console.error('Titles generation error:', error);
    await logUsage(req.user.userId, 'titles', false, 0, 0, error.message, { topic, audience, videoType });
    res.status(500).json({ error: 'Titles generation failed' });
  }
});

// Saved scripts endpoints
app.post('/api/scripts/save', authenticateToken, async (req, res) => {
  try {
    const {
      title, topic, audience, duration, tone, videoType, voicePreset,
      scriptContent, hooks, titles, outline, description, tags, thumbnailText, callToActions, scriptStats
    } = req.body;

    const result = await pool.query(`
      INSERT INTO saved_scripts (
        user_id, title, topic, audience, duration, tone, video_type, voice_preset,
        script_content, hooks, titles, outline, description, tags, thumbnail_text,
        call_to_actions, script_stats
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING id, created_at
    `, [
      req.user.userId, title || topic, topic, audience, duration, tone, videoType, voicePreset,
      scriptContent, JSON.stringify(hooks || []), JSON.stringify(titles || []), outline,
      description, JSON.stringify(tags || []), JSON.stringify(thumbnailText || []),
      JSON.stringify(callToActions || []), JSON.stringify(scriptStats || {})
    ]);

    res.json({
      success: true,
      scriptId: result.rows[0].id,
      savedAt: result.rows[0].created_at
    });

  } catch (error) {
    console.error('Save script error:', error);
    res.status(500).json({ error: 'Failed to save script' });
  }
});

app.get('/api/scripts/saved', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM saved_scripts 
      WHERE user_id = $1 
      ORDER BY updated_at DESC
    `, [req.user.userId]);

    res.json({ scripts: result.rows });

  } catch (error) {
    console.error('Get saved scripts error:', error);
    res.status(500).json({ error: 'Failed to retrieve saved scripts' });
  }
});

app.delete('/api/scripts/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM saved_scripts WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Script not found' });
    }

    res.json({ success: true });

  } catch (error) {
    console.error('Delete script error:', error);
    res.status(500).json({ error: 'Failed to delete script' });
  }
});

// Voice presets
app.get('/api/voice-presets', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM voice_presets ORDER BY name');
    res.json({ presets: result.rows });
  } catch (error) {
    console.error('Voice presets error:', error);
    res.status(500).json({ error: 'Failed to retrieve voice presets' });
  }
});

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static('build'));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`🚀 YouTube Script AI Server running on port ${PORT}`);
  console.log(`📊 Database: ${process.env.DATABASE_URL ? 'Connected' : 'Local'}`);
  console.log(`🤖 Anthropic API: ${process.env.ANTHROPIC_API_KEY ? 'Configured' : 'Missing'}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV}`);
});// server.js - Complete Backend for YouTube Script AI with Railway
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Database setup with Railway PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  min: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? [process.env.FRONTEND_URL || 'https://your-app.vercel.app'] 
    : ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per 15 minutes
  message: { error: 'Too many authentication attempts' }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  message: { error: 'Rate limit exceeded' }
});

const generationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 generations per minute
  message: { error: 'Generation rate limit exceeded' }
});

// Database initialization
const initDB = async () => {
  try {
    await pool.query(`
      -- Users table
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        first_name VARCHAR(255),
        last_name VARCHAR(255),
        access_level VARCHAR(50) DEFAULT 'free',
        subscription_status VARCHAR(50) DEFAULT 'active',
        preferred_voice VARCHAR(100) DEFAULT 'default',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Usage logs
      CREATE TABLE IF NOT EXISTS usage_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        feature_type VARCHAR(50) NOT NULL,
        tokens_used INTEGER DEFAULT 0,
        processing_time_ms INTEGER,
        success BOOLEAN DEFAULT TRUE,
        error_message TEXT,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Saved scripts
      CREATE TABLE IF NOT EXISTS saved_scripts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(500) NOT NULL,
        topic TEXT NOT NULL,
        audience VARCHAR(100),
        duration VARCHAR(20),
        tone VARCHAR(100),
        video_type VARCHAR(100),
        voice_preset VARCHAR(100),
        script_content TEXT,
        hooks JSONB,
        titles JSONB,
        outline TEXT,
        description TEXT,
        tags JSONB,
        thumbnail_text JSONB,
        call_to_actions JSONB,
        script_stats JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Usage quotas
      CREATE TABLE IF NOT EXISTS usage_quotas (
        access_level VARCHAR(50) PRIMARY KEY,
        monthly_script_limit INTEGER NOT NULL,
        monthly_hooks_limit INTEGER NOT NULL,
        monthly_titles_limit INTEGER NOT NULL,
        monthly_outline_limit INTEGER NOT NULL,
        monthly_description_limit INTEGER NOT NULL,
        monthly_tags_limit INTEGER NOT NULL,
        monthly_thumbnail_limit INTEGER NOT NULL,
        monthly_ctas_limit INTEGER NOT NULL,
        features_enabled TEXT[] NOT NULL
      );

      -- Voice presets
      CREATE TABLE IF NOT EXISTS voice_presets (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        display_name VARCHAR(255) NOT NULL,
        description TEXT,
        system_prompt TEXT NOT NULL,
        is_premium BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Insert usage quotas
      INSERT INTO usage_quotas (
        access_level, monthly_script_limit, monthly_hooks_limit, monthly_titles_limit,
        monthly_outline_limit, monthly_description_limit, monthly_tags_limit,
        monthly_thumbnail_limit, monthly_ctas_limit, features_enabled
      ) VALUES 
        ('free', 5, 10, 20, 5, 5, 10, 10, 10, 
         ARRAY['script', 'hooks', 'titles', 'outline', 'description', 'tags', 'thumbnail', 'ctas']),
        ('premium', 50, 100, 200, 50, 50, 100, 100, 100,
         ARRAY['script', 'hooks', 'titles', 'outline', 'description', 'tags', 'thumbnail', 'ctas']),
        ('pro', 200, 400, 800, 200, 200, 400, 400, 400,
         ARRAY['script', 'hooks', 'titles', 'outline', 'description', 'tags', 'thumbnail', 'ctas'])
      ON CONFLICT (access_level) DO UPDATE SET
        monthly_script_limit = EXCLUDED.monthly_script_limit;

      -- Insert voice presets
      INSERT INTO voice_presets (name, display_name, description, system_prompt, is_premium) VALUES 
        ('default', 'Default Voice', 'Balanced, professional content creation', 
         'You are an expert YouTube content creator with deep knowledge of viral content strategies.', FALSE),
        
        ('conversational', 'Conversational', 'Natural, flowing speaking style like talking to a friend',
         'Create content in a conversational, approachable tone. Use "you" and "I" language naturally. Include personal experiences and relatable examples.',
         FALSE),
        
        ('brenda_lawrence', 'Brenda Lawrence - Leadership & Process Expert', 'Executive coaching with 30+ years operational excellence',
         'You are Brenda Lawrence - a business and executive coach, inspirational speaker, consultant, trainer, trusted advisor, and safe space creator with a strong focus on process improvement and 30+ years of operational excellence. You optimize both the LEADER AND the business systems simultaneously. Your unique positioning combines leadership evolution + process optimization + systems thinking.',
         TRUE),
        
        ('motivational', 'Motivational Speaker', 'High energy and inspiring tone',
         'Create motivational content that inspires action. Focus on overcoming challenges, achieving goals, and building confidence. Use powerful success stories and transformational examples.',
         FALSE),
        
        ('educational', 'Educational Expert', 'Clear, structured, and informative approach',
         'Break down complex concepts into digestible steps. Use examples and analogies to explain difficult topics. Focus on practical learning outcomes and encourage deeper understanding.',
         FALSE),
        
        ('casual_creator', 'Casual Content Creator', 'Friendly, relatable, and approachable tone',
         'Keep content light and entertaining while informative. Connect with audience through shared experiences. Maintain authenticity and genuine personality.',
         FALSE)
      ON CONFLICT (name) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        system_prompt = EXCLUDED.system_prompt;

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_usage_logs_user_date ON usage_logs(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_saved_scripts_user_updated ON saved_scripts(user_id, updated_at DESC);
    `);
    
    console.log('✅ Database schema initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
};

initDB();

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// Quota checking
const checkQuota = async (userId, featureType) => {
  try {
    const user = await pool.query('SELECT access_level FROM users WHERE id = $1', [userId]);
    if (user.rows.length === 0) return { allowed: false, reason: 'User not found' };

    const accessLevel = user.rows[0].access_level;
    
    const quota = await pool.query('SELECT * FROM usage_quotas WHERE access_level = $1', [accessLevel]);
    if (quota.rows.length === 0) return { allowed: false, reason: 'No quota found' };

    const quotaData = quota.rows[0];
    
    if (!quotaData.features_enabled.includes(featureType)) {
      return { allowed: false, reason: 'Feature not available in your plan' };
    }

    const usage = await pool.query(`
      SELECT COUNT(*) as count FROM usage_logs 
      WHERE user_id = $1 AND feature_type = $2 AND success = true
      AND created_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP)
    `, [userId, featureType]);

    const currentUsage = parseInt(usage.rows[0].count);
    
    let limit;
    switch (featureType) {
      case 'script': limit = quotaData.monthly_script_limit; break;
      case 'hooks': limit = quotaData.monthly_hooks_limit; break;
      case 'titles': limit = quotaData.monthly_titles_limit; break;
      case 'outline': limit = quotaData.monthly_outline_limit; break;
      case 'description': limit = quotaData.monthly_description_limit; break;
      case 'tags': limit = quotaData.monthly_tags_limit; break;
      case 'thumbnail': limit = quotaData.monthly_thumbnail_limit; break;
      case 'ctas': limit = quotaData.monthly_ctas_limit; break;
      default: return { allowed: false, reason: 'Unknown feature type' };
    }

    return { 
      allowed: currentUsage < limit, 
      currentUsage, 
      limit,
      reason: currentUsage >= limit ? `Monthly limit of ${limit} reached` : null
    };
  } catch (error) {
    console.error('Quota check error:', error);
    return { allowed: false, reason: 'Quota check failed' };
  }
};

// Usage logging
const logUsage = async (userId, featureType, success = true, processingTime = 0, tokensUsed = 0, errorMessage = null, metadata = {}) => {
  try {
    await pool.query(`
      INSERT INTO usage_logs (user_id, feature_type, success, processing_time_ms, tokens_used, error_message, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [userId, featureType, success, processingTime, tokensUsed, errorMessage, JSON.stringify(metadata)]);
  } catch (error) {
    console.error('Usage logging error:', error);
  }
};

// Voice prompt system
const getVoicePrompt = async (voicePreset) => {
  try {
    const voice = await pool.query('SELECT * FROM voice_presets WHERE name = $1', [voicePreset]);
    if (voice.rows.length === 0) {
      return 'You are an expert YouTube content creator focused on creating viral, engaging content.';
    }
    return voice.rows[0].system_prompt;
  } catch (error) {
    console.error('Voice prompt error:', error);
    return 'You are an expert YouTube content creator focused on creating viral, engaging content.';
  }
};

// Voice prompt additions (from your frontend)
const getVoicePromptAdditions = (voicePreset) => {
  switch (voicePreset) {
    case 'conversational':
      return `
CONVERSATIONAL VOICE:
- Natural, flowing speaking style like talking to a friend
- Use "you" and "I" language to create connection
- Include conversational fillers and transitions naturally
- Share personal experiences and relatable examples
- Ask rhetorical questions to engage viewers
- Use everyday language that feels authentic and unscripted
- Create a warm, approachable tone that invites viewers in
- Balance professionalism with accessibility`;

    case 'brenda_lawrence':
      return `
BRENDA LAWRENCE VOICE & APPROACH:
You are speaking as Brenda Lawrence - a business and executive coach, inspirational speaker, consultant, trainer, trusted advisor, and safe space creator with a strong focus on process improvement and 30+ years of operational excellence.

YOUR UNIQUE POSITIONING:
- You optimize both the LEADER AND the business systems simultaneously
- You bring executive-level strategic frameworks rooted in operational excellence
- You combine leadership evolution + process optimization + systems thinking
- You focus on strategic depth with proven process improvement methodologies
- You create peer-driven evolution with systematic business improvements

YOUR SIGNATURE DIFFERENTIATORS:
- Not generic business advice → Executive-level strategic frameworks
- Not just leadership development → Leadership evolution + process optimization
- Not motivation-based → Strategic depth with proven methodologies
- Not theoretical → Real-world experience with CMMI Level 3 & 5 certifications
- Not one-time fixes → Sustainable process evolution that grows with the organization

YOUR CORE PHILOSOPHY:
"Most coaches focus on either the leader OR the business. I optimize both—simultaneously. Through strategic peer groups, proven process improvement methodologies, and leadership evolution frameworks, I help CEOs refine their brilliance while scaling their operations with clarity, efficiency, and soul."

CONTENT APPROACH:
- Strategic inspiration backed by operational expertise and real transformation results
- Proven case studies of process improvements that drove leadership evolution
- Specific systems and processes for sustainable high-performance
- Actionable content leaders can implement in their operations immediately
- Human-centered process design that considers leadership psychology
- Collaborative approach that considers organizational culture and leadership capacity

SPEAKING STYLE:
- Executive presence with operational mastery and systematic thinking
- Deep operational knowledge meets executive coaching expertise
- Strategic vulnerability focused on business systems and leadership effectiveness
- Community-driven growth where leaders learn from each other's challenges
- Values-driven approach that scales businesses without sacrificing culture`;

    case 'motivational':
      return `
MOTIVATIONAL SPEAKER VOICE:
- High energy and inspiring tone
- Focus on overcoming challenges and achieving goals
- Use powerful success stories and transformational examples
- Encourage action and personal growth
- Build confidence and self-belief`;

    case 'educational':
      return `
EDUCATIONAL EXPERT VOICE:
- Clear, structured, and informative approach
- Break down complex concepts into digestible steps
- Use examples and analogies to explain difficult topics
- Focus on practical learning outcomes
- Encourage questions and deeper understanding`;

    case 'casual_creator':
      return `
CASUAL CONTENT CREATOR VOICE:
- Friendly, relatable, and approachable tone
- Use everyday language and personal anecdotes
- Keep content light and entertaining while informative
- Connect with audience through shared experiences
- Maintain authenticity and genuine personality`;

    default:
      return '';
  }
};

// ROUTES

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT NOW()');
    res.json({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      database: 'connected',
      environment: process.env.NODE_ENV
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'unhealthy', 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Authentication routes
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const newUser = await pool.query(`
      INSERT INTO users (email, password_hash, first_name, last_name, access_level, subscription_status)
      VALUES ($1, $2, $3, $4, 'free', 'active')
      RETURNING id, email, first_name, last_name, access_level, subscription_status, created_at
    `, [email, passwordHash, firstName, lastName]);

    const user = newUser.rows[0];

    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        accessLevel: user.access_level,
        firstName: user.first_name 
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        accessLevel: user.access_level,
        subscriptionStatus: user.subscription_status,
        createdAt: user.created_at
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        accessLevel: user.access_level,
        firstName: user.first_name 
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        accessLevel: user.access_level,
        subscriptionStatus: user.subscription_status,
        preferredVoice: user.preferred_voice
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// User profile
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const userProfile = await pool.query(`
      SELECT 
        u.*,
        COALESCE(usage_stats.script_count, 0) as scripts_this_month,
        COALESCE(usage_stats.hooks_count, 0) as hooks_this_month,
        COALESCE(usage_stats.titles_count, 0) as titles_this_month,
        q.*
      FROM users u
      LEFT JOIN (
        SELECT 
          user_id,
          COUNT(CASE WHEN feature_type = 'script' AND success = true THEN 1 END) as script_count,
          COUNT(CASE WHEN feature_type = 'hooks' AND success = true THEN 1 END) as hooks_count,
          COUNT(CASE WHEN feature_type = 'titles' AND success = true THEN 1 END) as titles_count
        FROM usage_logs 
        WHERE created_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP)
        GROUP BY user_id
      ) usage_stats ON u.id = usage_stats.user_id
      LEFT JOIN usage_quotas q ON u.access_level = q.access_level
      WHERE u.id = $1
    `, [req.user.userId]);

    if (userProfile.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userProfile.rows[0];
    
    res.json({
      user: {
        id: userData.id,
        email: userData.email,
        firstName: userData.first_name,
        lastName: userData.last_name,
        accessLevel: userData.access_level,
        subscriptionStatus: userData.subscription_status,
        preferredVoice: userData.preferred_voice,
        createdAt: userData.created_at
      },
      usage: {
        script: parseInt(userData.scripts_this_month || 0),
        hooks: parseInt(userData.hooks_this_month || 0),
        titles: parseInt(userData.titles_this_month || 0)
      },
      quotas: {
        monthly_script_limit: userData.monthly_script_limit,
        monthly_hooks_limit: userData.monthly_hooks_limit,
        monthly_titles_limit: userData.monthly_titles_limit,
        features_enabled: userData.features_enabled
      }
    });
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Content generation endpoints
app.post('/api/generate/script', authenticateToken, apiLimiter, generationLimiter, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { topic, audience, duration, tone, videoType, keywords, customPrompt, voicePreset } = req.body;
    
    const quotaCheck = await checkQuota(req.user.userId, 'script');
    if (!quotaCheck.allowed) {
      return res.status(429).json({ error: quotaCheck.reason });
    }

    const voicePrompt = await getVoicePrompt(voicePreset || 'default');
    const voiceAdditions = getVoicePromptAdditions(voicePreset);
    
    const fullPrompt = `${voicePrompt}

${voiceAdditions}

Create an EXTREMELY retentive script for a ${duration}-minute ${videoType} video about "${topic}" that guarantees viewers watch until the end.

TARGET: ${audience} | TONE: ${tone} | KEYWORDS: ${keywords || 'N/A'}
${customPrompt ? `SPECIAL INSTRUCTIONS: ${customPrompt}` : ''}

RETENTION SYSTEM REQUIREMENTS:
- Hook must create immediate curiosity gap within 3 seconds
- Use pattern interrupts every 30-45 seconds to reset attention
- Include retention loops ("I'll show you this in just a minute...")
- Build tension and promise resolution throughout
- Use power words and emotional triggers
- Appeal to casual, core, and new viewers simultaneously

SCRIPT STRUCTURE WITH RETENTION TACTICS:

🎯 HOOK (0-15 seconds) - CRITICAL FOR CTR & RETENTION:
- Open with bold statement, shocking statistic, or curiosity gap
- NO introductions yet - dive straight into value
- Create immediate "what happens next?" feeling
- Promise specific, tangible outcome

🔥 INTRO (15-45 seconds) - COMMIT VIEWERS:
- Quick personal introduction (credibility)
- Restate the promise with more specificity  
- Preview what's coming ("By the end of this video, you'll know exactly how to...")
- Set expectations and create anticipation

📖 MAIN CONTENT - RETENTION OPTIMIZED:
Break into 3-4 segments with:
- Cliffhangers between sections
- "But here's what's really interesting..." transitions
- Story loops that get resolved later
- Specific examples and case studies
- "And this next part is crucial..." retention phrases
- Pattern interrupts every 30-45 seconds
- Callbacks to earlier points

💡 REVELATION SECTION (70% through):
- Deliver on main promise
- Include "aha moment" 
- Provide specific, actionable steps
- Use "But wait, there's more..." technique

🚀 CONCLUSION & CTA (Final 15%):
- Summarize key takeaways
- Strong call to action for subscription
- Tease next video content
- End with hook for next video

RETENTION TECHNIQUES TO INCLUDE:
- Open loops: "I'll explain why this matters in just a moment..."
- Pattern interrupts: "But first, let me tell you about..."
- Curiosity gaps: "The real secret is something most people never realize..."
- Social proof: "This helped [specific person] achieve [specific result]..."
- Urgency: "If you don't do this, you'll miss out on..."
- Personal stakes: "When I first discovered this..."

Make this script so engaging that viewers literally cannot stop watching. Every sentence should pull them deeper into the content. Word count: approximately ${parseInt(duration.split('-')[0]) * 150} words.

Act as if you're creating a script that MUST get millions of views and 90%+ retention rate.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{ role: "user", content: fullPrompt }]
      })
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = await response.json();
    const scriptContent = data.content[0].text;
    
    const processingTime = Date.now() - startTime;
    const words = scriptContent.trim().split(/\s+/).length;
    const estimatedDuration = Math.round((words / 150) * 100) / 100;
    
    await logUsage(req.user.userId, 'script', true, processingTime, words, null, 
      { topic, audience, duration, tone, videoType, voicePreset });

    res.json({
      script: scriptContent,
      stats: { words, estimatedDuration, processingTime }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Script generation error:', error);
    await logUsage(req.user.userId, 'script', false, processingTime, 0, error.message, 
      { topic, audience, duration, tone, videoType, voicePreset });
    res.status(500).json({ error: 'Script generation failed' });
  }
});

app.post('/api/generate/hooks', authenticateToken, apiLimiter, generationLimiter, async (req, res) => {
  try {
    const { topic, audience, videoType, tone, voicePreset } = req.body;
    
    const quotaCheck = await checkQuota(req.user.userId, 'hooks');
    if (!quotaCheck.allowed) {
      return res.status(429).json({ error: quotaCheck.reason });
    }

    const voicePrompt = await getVoicePrompt(voicePreset || 'default');
    const voiceAdditions = getVoicePromptAdditions(voicePreset);
    
    const prompt = `${voicePrompt}

${voiceAdditions}

Create 8 ULTRA-RETENTIVE YouTube hooks for "${topic}" that guarantee viewers can't stop watching.

AUDIENCE: ${audience} | TYPE: ${videoType} | TONE: ${tone}

HOOK REQUIREMENTS - EACH MUST:
- Create immediate curiosity gap within 3 seconds
- Appeal to casual, core, AND new viewers
- Promise specific, tangible value
- Use psychological triggers (fear, greed, curiosity, urgency)
- NO introductions - straight to value
- Create "what happens next?" compulsion

HOOK CATEGORIES (Create 1 of each + extras):

1. SHOCKING REVELATION: Start with counterintuitive truth
2. MASSIVE SOCIAL PROOF: Reference specific success/failure
3. CURIOSITY GAP: Promise secret most people don't know
4. PATTERN INTERRUPT: Unexpected statement that breaks expectations
5. PERSONAL STAKES: "If you don't know this..."
6. SPECIFIC OUTCOME: "By the end of this video you'll..."
7. STORY TEASER: Begin compelling narrative without resolution
8. AUTHORITY HOOK: Reference expert knowledge/insider info

Each hook must:
- Be 10-15 seconds when spoken
- Include specific numbers/details when possible
- Create immediate emotional response
- Promise transformation, not just information
- Work for someone who's never seen your content before

Examples of POWER WORDS to include: Secret, Mistake, Truth, Never, Always, Guaranteed, Proven, Hidden, Exposed, Revealed

Format as JSON: [{"type": "Hook Category", "text": "Exact hook text", "psychology": "Why this works"}]

CRITICAL: These hooks must be so compelling that viewers literally cannot scroll away. Act as if each hook determines whether you get 100 views or 1 million views.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    let responseText = data.content[0].text.trim();
    responseText = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "");
    
    const hooksData = JSON.parse(responseText);
    
    await logUsage(req.user.userId, 'hooks', true, 0, 0, null, { topic, audience, videoType, tone });
    
    res.json({ hooks: hooksData });

  } catch (error) {
    console.error('Hooks generation error:', error);
    await logUsage(req.user.userId, 'hooks', false, 0, 0, error.message, { topic, audience, videoType, tone });
    res.status(500).json({ error: 'Hooks generation failed' });
  }
});

app.post('/api/generate/titles', authenticateToken, apiLimiter, generationLimiter, async (req, res) => {
  try {
    const { topic, audience, videoType } = req.body;
    
    const quotaCheck = await checkQuota(req.user.userId, 'titles');
    if (!quotaCheck.allowed) {
      return res.status(429).json({ error: quotaCheck.reason });
    }

    const prompt = `Create 10 VIRAL YouTube titles for "${topic}" using proven formulas that guarantee millions of views.

AUDIENCE: ${audience} | TYPE: ${videoType}

TITLE REQUIREMENTS:
- 60 characters or less (optimal for mobile)
- High CTR (click-through rate) potential
- Appeal to casual, core, and new viewers
- Include emotional triggers and power words
- Promise specific, valuable outcome
- Create curiosity gap or urgency

PROVEN TITLE FORMULAS TO USE:

1. CURIOSITY GAP: "The [Secret/Truth] About [Topic] Nobody Tells You"
2. SPECIFIC OUTCOME: "How I [Achieved Specific Result] in [Timeframe]"
3. MISTAKE FORMULA: "Why [Common Belief] is Actually Ruining Your [Goal]"
4. AUTHORITY FORMULA: "[Number] [Topic] Tips from a [Credible Source]"
5. TRANSFORMATION: "From [Bad State] to [Good State] in [Timeframe]"
6. URGENCY: "Do This Before [Deadline/Age/Event] or [Consequence]"
7. CONTROVERSY: "Why [Popular Thing] is [Controversial Opinion]"
8. SPECIFIC NUMBER: "[Exact Number] Ways to [Achieve Desired Outcome]"
9. STORY HOOK: "How [Specific Person/Situation] [Achieved Something Amazing]"
10. PROBLEM/SOLUTION: "If You [Have Problem], Watch This"

Format as JSON array of strings. These titles should be so compelling that they achieve 10%+ CTR rates.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    let responseText = data.content[0].text.trim();
    responseText = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "");
    
    const titlesData = JSON.parse(responseText);
    
    await logUsage(req.user.userId, 'titles', true, 0, 0, null, { topic, audience, videoType });
    
    res.json({ titles: titlesData });

  } catch (error) {
    console.error('Titles generation error:', error);
    await logUsage(req.user.userId, 'titles', false, 0, 0, error.message, { topic, audience, videoType });
    res.status(500).json({ error: 'Titles generation failed' });
  }
});

// Saved scripts endpoints
app.post('/api/scripts/save', authenticateToken, async (req, res) => {
  try {
    const {
      title, topic, audience, duration, tone, videoType, voicePreset,
      scriptContent, hooks, titles, outline, description, tags, thumbnailText, callToActions, scriptStats
    } = req.body;

    const result = await pool.query(`
      INSERT INTO saved_scripts (
        user_id, title, topic, audience, duration, tone, video_type, voice_preset,
        script_content, hooks, titles, outline, description, tags, thumbnail_text,
        call_to_actions, script_stats
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING id, created_at
    `, [
      req.user.userId, title || topic, topic, audience, duration, tone, videoType, voicePreset,
      scriptContent, JSON.stringify(hooks || []), JSON.stringify(titles || []), outline,
      description, JSON.stringify(tags || []), JSON.stringify(thumbnailText || []),
      JSON.stringify(callToActions || []), JSON.stringify(scriptStats || {})
    ]);

    res.json({
      success: true,
      scriptId: result.rows[0].id,
      savedAt: result.rows[0].created_at
    });

  } catch (error) {
    console.error('Save script error:', error);
    res.status(500).json({ error: 'Failed to save script' });
  }
});

app.get('/api/scripts/saved', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM saved_scripts 
      WHERE user_id = $1 
      ORDER BY updated_at DESC
    `, [req.user.userId]);

    res.json({ scripts: result.rows });

  } catch (error) {
    console.error('Get saved scripts error:', error);
    res.status(500).json({ error: 'Failed to retrieve saved scripts' });
  }
});

app.delete('/api/scripts/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM saved_scripts WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Script not found' });
    }

    res.json({ success: true });

  } catch (error) {
    console.error('Delete script error:', error);
    res.status(500).json({ error: 'Failed to delete script' });
  }
});

// Voice presets
app.get('/api/voice-presets', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM voice_presets ORDER BY name');
    res.json({ presets: result.rows });
  } catch (error) {
    console.error('Voice presets error:', error);
    res.status(500).json({ error: 'Failed to retrieve voice presets' });
  }
});

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static('build'));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`🚀 YouTube Script AI Server running on port ${PORT}`);
  console.log(`📊 Database: ${process.env.DATABASE_URL ? 'Connected' : 'Local'}`);
  console.log(`🤖 Anthropic API: ${process.env.ANTHROPIC_API_KEY ? 'Configured' : 'Missing'}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV}`);
});

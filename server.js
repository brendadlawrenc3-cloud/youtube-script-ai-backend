// Add these routes to your existing server.js file

// CONTENT GENERATION ENDPOINTS

// Generate Script
app.post('/api/generate/script', authenticateToken, apiLimiter, generationLimiter, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { topic, audience, duration, tone, videoType, keywords, customPrompt, voicePreset } = req.body;
    
    // Check quota
    const quotaCheck = await checkQuota(req.user.userId, 'script');
    if (!quotaCheck.allowed) {
      return res.status(429).json({ error: quotaCheck.reason });
    }

    // Get voice prompt
    const voicePrompt = await getVoicePrompt(voicePreset || 'default');
    
    // Build full prompt (using your existing frontend prompt logic)
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

    // Call Anthropic API (secure from backend)
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
    
    // Calculate stats
    const processingTime = Date.now() - startTime;
    const words = scriptContent.trim().split(/\s+/).length;
    const estimatedDuration = Math.round((words / 150) * 100) / 100;
    
    // Log usage
    await logUsage(req.user.userId, 'script', true, processingTime, words, null, null, null, 
      { topic, audience, duration, tone, videoType, voicePreset });

    res.json({
      script: scriptContent,
      stats: { words, estimatedDuration, processingTime }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Script generation error:', error);
    await logUsage(req.user.userId, 'script', false, processingTime, 0, null, null, error.message, 
      { topic, audience, duration, tone, videoType, voicePreset });
    res.status(500).json({ error: 'Script generation failed' });
  }
});

// Helper function for voice prompt additions (from your frontend)
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

// Generate Hooks
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
    
    await logUsage(req.user.userId, 'hooks', true, 0, 0, null, null, null, { topic, audience, videoType, tone });
    
    res.json({ hooks: hooksData });

  } catch (error) {
    console.error('Hooks generation error:', error);
    await logUsage(req.user.userId, 'hooks', false, 0, 0, null, null, error.message, { topic, audience, videoType, tone });
    res.status(500).json({ error: 'Hooks generation failed' });
  }
});

// Generate Titles  
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

POWER WORDS TO INCLUDE:
- Secret, Truth, Hidden, Exposed, Revealed
- Guaranteed, Proven, Tested, Verified
- Never, Always, Everyone, Nobody
- Mistake, Wrong, Right, Correct
- Easy, Simple, Fast, Quick, Instant
- Amazing, Incredible, Shocking, Surprising

PSYCHOLOGICAL TRIGGERS:
- Fear of missing out (FOMO)
- Desire for shortcuts/secrets
- Social proof and authority
- Specific numbers and timeframes
- Personal transformation promises

Each title must:
- Make viewer think "I NEED to watch this"
- Promise specific value or outcome
- Include emotional hook
- Be optimized for YouTube algorithm
- Work for someone who's never heard of the creator

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
    
    await logUsage(req.user.userId, 'titles', true, 0, 0, null, null, null, { topic, audience, videoType });
    
    res.json({ titles: titlesData });

  } catch (error) {
    console.error('Titles generation error:', error);
    await logUsage(req.user.userId, 'titles', false, 0, 0, null, null, error.message, { topic, audience, videoType });
    res.status(500).json({ error: 'Titles generation failed' });
  }
});

// Add similar endpoints for outline, description, tags, thumbnail, ctas...
// [You can add the rest following the same pattern]

// SAVED SCRIPTS ENDPOINTS

// Save Script
app.post('/api/scripts/save', authenticateToken, async (req, res) => {
  try {
    const {
      title,
      topic,
      audience,
      duration,
      tone,
      videoType,
      voicePreset,
      scriptContent,
      hooks,
      titles,
      outline,
      description,
      tags,
      thumbnailText,
      callToActions,
      scriptStats
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

// Get Saved Scripts
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

// Delete Script
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

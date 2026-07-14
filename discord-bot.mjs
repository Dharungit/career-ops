#!/usr/bin/env node

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } from 'discord.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^(['"])(.*?)\1$/, '$2');
    }
  }
}

const DISCORD_TOKEN    = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID       = process.env.DISCORD_CHANNEL_ID;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL   = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

if (!DISCORD_TOKEN)    { console.error('DISCORD_BOT_TOKEN required'); process.exit(1); }
if (!CHANNEL_ID)       { console.error('DISCORD_CHANNEL_ID required'); process.exit(1); }
if (!DEEPSEEK_API_KEY) { console.error('DEEPSEEK_API_KEY required'); process.exit(1); }

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

function readFile(p) {
  try { return readFileSync(join(__dirname, p), 'utf-8'); } catch { return null; }
}

function loadContext() {
  return {
    cv:          readFile('cv.md') ?? 'CV not found.',
    profile:     readFile('config/profile.yml') ?? '',
    shared:      readFile('modes/_shared.md') ?? '',
    profileMode: readFile('modes/_profile.md') ?? '',
    oferta:      readFile('modes/oferta.md') ?? '',
    pdfMode:     readFile('modes/pdf.md') ?? '',
    template:    readFile('templates/cv-template.html') ?? '',
  };
}

function buildSystemPrompt(ctx, modeContent) {
  return [
    ctx.shared,
    ctx.profileMode,
    modeContent,
    '---',
    'CANDIDATE PROFILE (YAML):',
    ctx.profile,
    '---',
    'CV (Markdown):',
    ctx.cv,
  ].filter(Boolean).join('\n\n');
}

async function callDeepSeek(systemPrompt, userPrompt, temperature = 0.3) {
  const resp = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
      max_tokens: 16384,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => 'unknown');
    throw new Error(`DeepSeek API ${resp.status}: ${err.slice(0, 500)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function fetchJobPage(url) {
  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2000);
    const text = await page.evaluate(() => {
      document.querySelectorAll('script,style,nav,footer,header').forEach(el => el.remove());
      return (document.body?.innerText || document.body?.textContent || '').replace(/\s+/g, ' ').trim();
    });
    return text.slice(0, 16_000);
  } catch (e) {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; career-ops/1.0)' } });
    if (!r.ok) throw new Error(`Fetch failed: HTTP ${r.status}`);
    const html = await r.text();
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 16_000);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function nextReportNum() {
  try {
    const nums = readdirSync(join(__dirname, 'reports'))
      .map(f => parseInt(f.match(/^(\d+)/)?.[1] ?? '0', 10))
      .filter(n => n > 0);
    return nums.length ? Math.max(...nums) + 1 : 1;
  } catch { return 1; }
}

function extractCompanySlug(text, url) {
  const m = text.match(/(?:at|@|company[:\s]+)\s*([A-Z][A-Za-z0-9]{2,25})/);
  if (m) return m[1].toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (url) {
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      return (parts[0] ?? 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    } catch {}
  }
  return 'company';
}

function extractScore(result) {
  const m = result.match(/(?:Score|score|Global|global|Puntuaci[oó]n)[^\d]*(\d+\.?\d*)/);
  return m ? parseFloat(m[1]) : NaN;
}

function extractLegitimacy(result) {
  const m = result.match(/\*\*Legitimacy:\*\*\s*([^\n]+)/);
  return m ? m[1].trim() : 'Unknown';
}

function extractTldr(result) {
  const m = result.match(/TL;DR[:\s]+([^\n]+)/i);
  return m ? m[1].trim() : '';
}

async function evaluateJob(jdText, url, ctx) {
  const systemPrompt = buildSystemPrompt(ctx, ctx.oferta);
  const userPrompt = `Evaluate this job listing. Provide a complete A-G evaluation in the format specified.\n\n${jdText}`;

  console.log('[eval] Calling DeepSeek...');
  const result = await callDeepSeek(systemPrompt, userPrompt);

  const today = new Date().toISOString().split('T')[0];
  const num = nextReportNum();
  const slug = extractCompanySlug(jdText, url);
  const numStr = String(num).padStart(3, '0');
  const relPath = `reports/${numStr}-${slug}-${today}.md`;

  const scoreVal = extractScore(result);
  const scoreStr = isFinite(scoreVal) ? `${scoreVal.toFixed(1)}/5` : '?/5';
  const legitTier = extractLegitimacy(result);
  const legitLine = `**Legitimacy:** ${legitTier}`;
  const urlLine = `**URL:** ${url || '(pasted)'}`;

  mkdirSync(join(__dirname, 'reports'), { recursive: true });
  writeFileSync(join(__dirname, relPath), `${urlLine}\n${legitLine}\n\n${result}`);

  // tracker-additions TSV
  const companyName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const tsvDir = join(__dirname, 'batch', 'tracker-additions');
  mkdirSync(tsvDir, { recursive: true });
  const tsvLine = `${num}\t${today}\t${companyName}\t(see report)\tEvaluated\t${scoreStr}\t❌\t[${numStr}](reports/${numStr}-${slug}-${today}.md)\t\n`;
  writeFileSync(join(tsvDir, `or-${numStr}-${slug}.tsv`), `num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\n${tsvLine}`);

  console.log(`[eval] Report saved: ${relPath}`);
  return { result, scoreStr, legitTier, tldr: extractTldr(result), num: numStr, slug, date: today, relPath };
}

async function generateCvHtml(reportContent, ctx, jdUrl) {
  const ROLE_BULLETS = ctx.cv.split('\n').filter(l => l.trim().startsWith('-')).map(l => l.replace(/^-\s*/, '').trim()).filter(Boolean);

  const systemPrompt = [
    'You are an HTML CV generator. Your ONLY job: output valid HTML with all template placeholders replaced.',
    'You are given: the HTML template, the candidate CV, and the job evaluation report.',
    '',
    'Fill the template EXACTLY as follows:',
    '- `{{LANG}}` → "en"',
    '- `{{PAGE_WIDTH}}` → "8.5in"',
    '- `{{PHOTO}}` → empty string (remove the whole {{PHOTO}} line)',
    '- `{{NAME}}` → "Dharun R"',
    '- `{{PHONE}}` → "+91 9965398433"',
    '- `{{EMAIL}}` → "dharun123wizz@gmail.com"',
    '- `{{LINKEDIN_URL}}` → "https://www.linkedin.com/in/dharun-r"',
    '- `{{LINKEDIN_DISPLAY}}` → "linkedin.com/in/dharun-r"',
    '- `{{PORTFOLIO_URL}}` → "" (omit the | separator before it too if empty)',
    '- `{{PORTFOLIO_DISPLAY}}` → "" (omit if empty)',
    '- `{{LOCATION}}` → "Chennai, TN - 603103"',
    '- `{{SECTION_SUMMARY}}` → "Professional Summary"',
    '- `{{SUMMARY_TEXT}}` → 3-4 line summary tailored to the job, using JD keywords from the report',
    '- `{{SECTION_COMPETENCIES}}` → "Core Competencies"',
    '- `{{COMPETENCIES}}` → 6-8 `<span class="competency-tag">keyword</span>` from JD requirements',
    '- `{{SECTION_EXPERIENCE}}` → "Work Experience"',
    '- `{{EXPERIENCE}}` → Full job entries as HTML (from CV data below)',
    '- `{{SECTION_PROJECTS}}` → "Projects"',
    '- `{{PROJECTS}}` → Project entries as HTML (from report/CV)',
    '- `{{SECTION_EDUCATION}}` → "Education"',
    '- `{{EDUCATION}}` → Education entry as HTML (from CV below)',
    '- `{{SECTION_CERTIFICATIONS}}` → "Certifications"',
    '- `{{CERTIFICATIONS}}` → empty string if none',
    '- `{{SECTION_SKILLS}}` → "Skills"',
    '- `{{SKILLS}}` → Skills as HTML (from CV below)',
    '',
    'CRITICAL RULES:',
    '- Return ONLY the rendered HTML. No markdown fences, no explanation, no conversation.',
    '- NEVER invent experience, metrics, or skills. Only use what is in the CV and report.',
    '- Reorder and rephrase existing achievements to match JD keywords (ethical reformulation).',
    '- Use action verbs, active voice, concrete metrics.',
    '- Output MUST be valid HTML that renders in a browser.',
  ].join('\n');

  const userPrompt = [
    'Generate the CV HTML. Here is everything you need:',
    '',
    `Job URL: ${jdUrl}`,
    '',
    '=== EVALUATION REPORT ===',
    reportContent,
    '',
    '=== CV (raw) ===',
    ctx.cv,
    '',
    '=== PROFILE ===',
    ctx.profile,
    '',
    '=== HTML TEMPLATE ===',
    ctx.template,
  ].join('\n');

  console.log('[cv] Calling DeepSeek for CV HTML...');
  let html = await callDeepSeek(systemPrompt, userPrompt, 0.2);
  let clean = html.trim();
  if (clean.startsWith('```')) {
    clean = clean.replace(/^```(?:html)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return clean;
}

function generatePdf(htmlPath, pdfPath, format) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [
      join(__dirname, 'generate-pdf.mjs'),
      htmlPath,
      pdfPath,
      `--format=${format}`,
    ], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve(pdfPath);
      else reject(new Error(`generate-pdf.mjs exited ${code}: ${stderr.slice(0, 1000)}`));
    });
    proc.on('error', reject);
  });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Monitoring channel ID: ${CHANNEL_ID} (${CHANNEL_ID ? 'set' : 'NOT SET — will respond in any channel'})`);
  if (!CHANNEL_ID) console.log('To restrict to one channel, set DISCORD_CHANNEL_ID in env.');

  console.log(`Connected to ${client.guilds.cache.size} guild(s):`);
  client.guilds.cache.forEach(g => console.log(`  - ${g.name} (${g.id})`));
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const chanId = message.channel.id;
  const chanName = message.channel.name || '(no name)';
  const isThread = message.channel.isThread?.() ?? false;
  const parentId = isThread ? message.channel.parentId : null;
  console.log(`[msg] #${chanName} (${chanId})${isThread ? ` thread of ${parentId}` : ''}: ${message.content.slice(0, 100)}`);

  // Accept if channel matches OR it's a thread inside the target channel
  if (CHANNEL_ID && chanId !== CHANNEL_ID && (!isThread || parentId !== CHANNEL_ID)) {
    console.log(`[msg] Skipping — not target channel`);
    return;
  }

  const urlMatch = message.content.match(/https?:\/\/[^\s]+/);
  if (!urlMatch) {
    console.log('No URL found in message, ignoring.');
    return;
  }

  const url = urlMatch[0];
  console.log(`Found URL: ${url}`);

  const ctx = loadContext();

  try {
    await message.react('⏳');
    console.log(`\n--- Processing: ${url} ---`);

    const jdText = await fetchJobPage(url);
    const fullText = `URL: ${url}\n\n${jdText}`;

    const { result, scoreStr, legitTier, tldr, num, slug, date, relPath } =
      await evaluateJob(fullText, url, ctx);

    const scoreColor = legitTier.toLowerCase().includes('high') ? 0x00ff00 : 0xffa500;

    const embed = new EmbedBuilder()
      .setColor(scoreColor)
      .setTitle(`📊 Evaluation #${num}`)
      .setDescription(tldr || 'Evaluation complete — see report for details.')
      .addFields(
        { name: 'Score', value: scoreStr, inline: true },
        { name: 'Legitimacy', value: legitTier, inline: true },
        { name: 'Report', value: `\`${relPath}\``, inline: false },
      )
      .setFooter({ text: `Requested by ${message.author.username}` })
      .setTimestamp();

    await message.channel.send({ embeds: [embed] });

    // CV generation
    const candidateName = 'dharun-r';
    const outputDir = join(__dirname, 'output');
    mkdirSync(outputDir, { recursive: true });

    const htmlPath = join(outputDir, `cv-${candidateName}-${slug}.html`);
    const pdfPath  = join(outputDir, `cv-${candidateName}-${slug}-${date}.pdf`);

    console.log('[cv] Generating CV HTML...');
    const html = await generateCvHtml(result, ctx, url);
    writeFileSync(htmlPath, html, 'utf-8');
    console.log(`[cv] HTML saved: ${htmlPath}`);

    console.log('[pdf] Generating PDF...');
    await generatePdf(htmlPath, pdfPath, 'letter');
    console.log(`[pdf] PDF saved: ${pdfPath}`);

    if (existsSync(pdfPath)) {
      const attachment = new AttachmentBuilder(pdfPath, { name: `cv-${candidateName}-${slug}.pdf` });
      const pdfEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`📄 CV for ${slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`)
        .setDescription(`Score: **${scoreStr}** | Legitimacy: **${legitTier}**`)
        .setTimestamp();

      await message.channel.send({ embeds: [pdfEmbed], files: [attachment] });
      await message.reactions.removeAll().catch(() => {});
      await message.react('✅');
    }
  } catch (error) {
    console.error('[error]', error);
    await message.reactions.removeAll().catch(() => {});
    await message.react('❌');

    try {
      const errEmbed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle('❌ Evaluation Failed')
        .setDescription(`\`\`\`${error.message.slice(0, 1500)}\`\`\``)
        .setTimestamp();
      await message.channel.send({ embeds: [errEmbed] });
    } catch { /* best effort */ }
  }
});

client.login(DISCORD_TOKEN);

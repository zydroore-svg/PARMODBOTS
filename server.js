// ─────────────────────────────────────────────────────────────
//  PAR — OAuth2 + API Backend  (server.js)
//  Run alongside bot.js:  node server.js
//  Handles: Discord OAuth2 login, /auth/me, /api/appeal, /api/ticket
// ─────────────────────────────────────────────────────────────
import express   from 'express';
import cors      from 'cors';
import crypto    from 'crypto';
import 'dotenv/config';

import { Client, GatewayIntentBits, EmbedBuilder, ButtonBuilder,
         ButtonStyle, ActionRowBuilder, ChannelType,
         PermissionFlagsBits } from 'discord.js';

import { initializeApp }    from 'firebase/app';
import { getFirestore, collection, addDoc, serverTimestamp } from 'firebase/firestore';

// ── 1. ENV ────────────────────────────────────────────────────
const {
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  REDIRECT_URI,          // e.g. http://localhost:3001/auth/callback
  FRONTEND_URL,          // e.g. http://localhost:5500  (where index.html is served)
  GUILD_ID,
  LOG_CHANNEL_ID,
  FIREBASE_API_KEY,
  FIREBASE_AUTH_DOMAIN,
  FIREBASE_PROJECT_ID,
  FIREBASE_STORAGE_BUCKET,
  FIREBASE_MESSAGING_SENDER_ID,
  FIREBASE_APP_ID,
} = process.env;

const MISSING = [
  'DISCORD_BOT_TOKEN','DISCORD_CLIENT_ID','DISCORD_CLIENT_SECRET',
  'REDIRECT_URI','FRONTEND_URL','GUILD_ID',
  'FIREBASE_API_KEY','FIREBASE_PROJECT_ID',
].filter(k => !process.env[k]);

if (MISSING.length) {
  console.error('❌  Missing required env vars:', MISSING.join(', '));
  process.exit(1);
}

// ── 2. Firebase ───────────────────────────────────────────────
const firebaseApp = initializeApp({
  apiKey:            FIREBASE_API_KEY,
  authDomain:        FIREBASE_AUTH_DOMAIN,
  projectId:         FIREBASE_PROJECT_ID,
  storageBucket:     FIREBASE_STORAGE_BUCKET,
  messagingSenderId: FIREBASE_MESSAGING_SENDER_ID,
  appId:             FIREBASE_APP_ID,
});
const db = getFirestore(firebaseApp);

// ── 3. Discord Bot Client ─────────────────────────────────────
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
discordClient.login(DISCORD_BOT_TOKEN);
discordClient.once('ready', () =>
  console.log(`🤖  Bot ready as ${discordClient.user.tag}`)
);

// ── 4. In-memory session store ────────────────────────────────
//  { [token]: { id, username, globalName, avatar, access_token } }
const sessions = new Map();

function getSession(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return token ? sessions.get(token) : null;
}

// ── 5. Express ────────────────────────────────────────────────
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

// Explicit root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── 6. AUTH ROUTES ────────────────────────────────────────────

// GET /auth/login  — redirect browser to Discord
app.get('/auth/login', (req, res) => {
  const params = new URLSearchParams({
    client_id:     DISCORD_CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         'identify',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// GET /auth/callback  — Discord returns ?code=… here
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect(`${FRONTEND_URL}/?auth_error=1`);

  try {
    // Exchange code → access token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description);

    // Fetch Discord user profile
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();

    // Create session
    const sessionToken = crypto.randomBytes(20).toString('hex');
    sessions.set(sessionToken, {
      id:           user.id,
      username:     user.username,
      globalName:   user.global_name ?? user.username,
      avatar:       user.avatar,
      access_token: tokenData.access_token,
    });

    // Redirect back to frontend with session hash
    res.redirect(`${FRONTEND_URL}/#session=${sessionToken}`);

  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect(`${FRONTEND_URL}/?auth_error=1`);
  }
});

// GET /auth/me  — frontend verifies session
app.get('/auth/me', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  res.json(user);
});

// ── 7. HELPER: create private channel ────────────────────────
async function createPrivateChannel(guild, targetUserId, channelName) {
  const member = await guild.members.fetch(targetUserId);
  return guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny:  [PermissionFlagsBits.ViewChannel] },
      { id: member.id,               allow: [PermissionFlagsBits.ViewChannel,
                                              PermissionFlagsBits.SendMessages,
                                              PermissionFlagsBits.ReadMessageHistory] },
    ],
  });
}

function closeButton(label = 'Close') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('close_ticket_btn')
      .setLabel(label)
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger)
  );
}

// ── 8. API ROUTES ─────────────────────────────────────────────

// POST /api/appeal
app.post('/api/appeal', async (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });

  const { robloxUsername, bannedFrom, banDate, banReason, appealReason } = req.body;
  if (!robloxUsername || !bannedFrom || !banDate || !banReason || !appealReason)
    return res.status(400).json({ error: 'Please fill in all fields.' });

  try {
    const guild       = await discordClient.guilds.fetch(GUILD_ID);
    const channelName = `appeal-${user.username.toLowerCase().replace(/[^a-z0-9-]/g, '')}`;

    // Duplicate guard
    await guild.channels.fetch();
    const existing = guild.channels.cache.find(c => c.name === channelName);
    if (existing)
      return res.status(400).json({
        error: 'You already have an open appeal ticket in the server.',
        channelUrl: `https://discord.com/channels/${GUILD_ID}/${existing.id}`,
      });

    // Save to Firestore
    await addDoc(collection(db, 'appeals'), {
      robloxUsername,
      discordUsername: user.username,
      discordId:       user.id,
      bannedFrom, banDate, banReason, appealReason,
      status:      'pending',
      submittedAt: serverTimestamp(),
    });

    // Create channel
    const channel = await createPrivateChannel(guild, user.id, channelName);

    const embed = new EmbedBuilder()
      .setTitle('📢 New Ban Appeal — Web Form')
      .setColor('#0099ff')
      .addFields(
        { name: 'Roblox Username',  value: robloxUsername,               inline: true },
        { name: 'Discord Account',  value: `<@${user.id}> (${user.username})`, inline: true },
        { name: 'Banned From',      value: bannedFrom },
        { name: 'Approx. Ban Date', value: banDate },
        { name: 'Reason for Ban',   value: banReason },
        { name: 'Appeal Statement', value: appealReason },
      )
      .setTimestamp();

    await channel.send({
      content: `<@${user.id}> Your appeal has been received. Staff will review it shortly.`,
      embeds:     [embed],
      components: [closeButton('Close Appeal')],
    });

    res.json({
      message:     'Appeal submitted successfully!',
      channelName,
      channelUrl:  `https://discord.com/channels/${GUILD_ID}/${channel.id}`,
    });

  } catch (err) {
    console.error('Appeal error:', err);
    res.status(500).json({ error: 'Server error — please try again.' });
  }
});

// POST /api/ticket
app.post('/api/ticket', async (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });

  const { ticketType, userId, banInfo, ruleBroken, eventExpl, liftReason } = req.body;
  if (!ticketType || !userId || !ruleBroken || !eventExpl || !liftReason)
    return res.status(400).json({ error: 'Please fill in all required fields.' });

  try {
    const guild       = await discordClient.guilds.fetch(GUILD_ID);
    const safeType    = ticketType.replace(/[^a-z0-9_]/gi, '').toLowerCase();
    const channelName = `${safeType}-${user.username.toLowerCase().replace(/[^a-z0-9-]/g, '')}`;

    // Duplicate guard
    await guild.channels.fetch();
    const existing = guild.channels.cache.find(c => c.name === channelName);
    if (existing)
      return res.status(400).json({
        error: 'You already have an open ticket of this type.',
        channelUrl: `https://discord.com/channels/${GUILD_ID}/${existing.id}`,
      });

    const channel = await createPrivateChannel(guild, user.id, channelName);

    const embed = new EmbedBuilder()
      .setTitle(`📋 New Ticket — ${ticketType.replace(/_/g, ' ').toUpperCase()}`)
      .setColor('#ffd700')
      .addFields(
        { name: 'Discord Account', value: `<@${user.id}> (${user.username})`, inline: true },
        { name: 'Reported User/ID', value: userId },
        { name: 'Ban Date / Staff',  value: banInfo || 'Unknown' },
        { name: 'Rule Broken',       value: ruleBroken },
        { name: 'Explanation',       value: eventExpl },
        { name: 'Why Lift Ban?',     value: liftReason },
      )
      .setTimestamp();

    await channel.send({
      content:    `<@${user.id}> Your ticket has been opened. A staff member will assist you shortly.`,
      embeds:     [embed],
      components: [closeButton('Close Ticket')],
    });

    res.json({
      message:    'Ticket submitted successfully!',
      channelName,
      channelUrl: `https://discord.com/channels/${GUILD_ID}/${channel.id}`,
    });

  } catch (err) {
    console.error('Ticket error:', err);
    res.status(500).json({ error: 'Server error — please try again.' });
  }
});

// ── 9. Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`🌐  PAR backend listening on port ${PORT}`)
);

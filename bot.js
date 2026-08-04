// ─────────────────────────────────────────────────────────────
//  PAR — Discord Bot + OAuth2/API Backend (UNIFIED)
//  Run with:  node bot.js
// ─────────────────────────────────────────────────────────────
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import {
  Client,
  GatewayIntentBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ChannelType,
  StringSelectMenuBuilder,
  AttachmentBuilder,
} from 'discord.js';

import {
  initializeApp,
} from 'firebase/app';
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  getDoc,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';

// ── 1. ENV VALIDATION ────────────────────────────────────────
const {
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  REDIRECT_URI,
  FRONTEND_URL,
  GUILD_ID,
  LOG_CHANNEL_ID,
  FIREBASE_API_KEY,
  FIREBASE_AUTH_DOMAIN,
  FIREBASE_PROJECT_ID,
  FIREBASE_STORAGE_BUCKET,
  FIREBASE_MESSAGING_SENDER_ID,
  FIREBASE_APP_ID,
  PORT,
} = process.env;

const REQUIRED = {
  DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET,
  REDIRECT_URI, FRONTEND_URL, GUILD_ID, LOG_CHANNEL_ID,
  FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID,
  FIREBASE_STORAGE_BUCKET, FIREBASE_MESSAGING_SENDER_ID, FIREBASE_APP_ID,
};

const missing = Object.entries(REQUIRED).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error('❌ Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

// ── Wellness check config ──────────────────────────────────────
// Optional overrides — falls back to LOG_CHANNEL_ID, a 60-minute interval,
// and a 5-minute scan cycle. Lower WELLNESS_CHECK_MINUTES and
// WELLNESS_POLL_SECONDS in your .env to test quickly, e.g.:
//   WELLNESS_CHECK_MINUTES=1
//   WELLNESS_POLL_SECONDS=20
const WELLNESS_CHANNEL_ID = process.env.WELLNESS_CHANNEL_ID || LOG_CHANNEL_ID;
const WELLNESS_CHECK_MINUTES = parseFloat(process.env.WELLNESS_CHECK_MINUTES) || 60;
const WELLNESS_POLL_SECONDS = parseFloat(process.env.WELLNESS_POLL_SECONDS) || 300; // default: scan every 5 min
const WELLNESS_POLL_MS = WELLNESS_POLL_SECONDS * 1000;

console.log(`🩺 Wellness checks: every ${WELLNESS_CHECK_MINUTES} min of active duty, scanned every ${WELLNESS_POLL_SECONDS}s, posting in channel ${WELLNESS_CHANNEL_ID}`);

process.on('unhandledRejection', (reason) => console.error('❌ Unhandled promise rejection:', reason));
process.on('uncaughtException', (err) => { console.error('❌ Uncaught exception:', err); process.exit(1); });

// ── 2. Firebase ───────────────────────────────────────────────
const firebaseApp = initializeApp({
  apiKey: FIREBASE_API_KEY,
  authDomain: FIREBASE_AUTH_DOMAIN,
  projectId: FIREBASE_PROJECT_ID,
  storageBucket: FIREBASE_STORAGE_BUCKET,
  messagingSenderId: FIREBASE_MESSAGING_SENDER_ID,
  appId: FIREBASE_APP_ID,
});
const db = getFirestore(firebaseApp);

// ── 3. Discord Client ────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Slash command definitions ─────────────────────────────────
const SLASH_COMMANDS = [
  // ── Ticket system ──
  { name: 'appeal',       description: 'Open the PAR ban appeal submission form' },
  { name: 'ticket-setup', description: 'Deploy the ticket creation panel into this channel' },
  { name: 'panel',        description: 'Alias: post the ticket panel in this channel' },

  // ── Ticket management ──
  { name: 'add',    description: 'Add a user to this ticket channel',        options: [{ name: 'user', description: 'User to add',    type: 6, required: true }] },
  { name: 'remove', description: 'Remove a user from this ticket channel',   options: [{ name: 'user', description: 'User to remove', type: 6, required: true }] },
  { name: 'rename', description: 'Rename this ticket channel',               options: [{ name: 'name', description: 'New name',       type: 3, required: true }] },
  { name: 'claim',   description: 'Claim this ticket as your own to handle' },
  { name: 'unclaim', description: 'Unclaim this ticket' },
  { name: 'close',   description: 'Close ticket — saves transcript and deletes channel' },
  { name: 'lock',    description: 'Prevent the ticket opener from sending messages' },
  { name: 'unlock',  description: 'Re-allow the ticket opener to send messages' },
  { name: 'note',   description: 'Post a visible staff note in this ticket', options: [{ name: 'text', description: 'Note content', type: 3, required: true }] },
  { name: 'slowmode', description: 'Set slowmode on this channel', options: [{ name: 'seconds', description: 'Seconds (0 = off)', type: 4, required: true, min_value: 0, max_value: 21600 }] },

  // ── Moderation ──
  { name: 'warn',      description: 'Warn a user and log it to Firebase',    options: [{ name: 'user', description: 'User to warn', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3, required: true }] },
  { name: 'warnings',  description: 'View all warnings for a user',          options: [{ name: 'user', description: 'User to check', type: 6, required: true }] },
  { name: 'clearwarn', description: 'Delete a specific warning by its ID',   options: [{ name: 'id',   description: 'Warning document ID', type: 3, required: true }] },
  { name: 'modlogs',   description: 'Full moderation history for a user',    options: [{ name: 'user', description: 'User to look up', type: 6, required: true }] },
  { name: 'kick',      description: 'Kick a member from the server',         options: [{ name: 'user', description: 'User to kick', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3, required: false }] },
  { name: 'ban',       description: 'Ban a user and log it to Firebase',     options: [{ name: 'user', description: 'User to ban', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3, required: true }, { name: 'days', description: 'Messages to delete (days, 0–7)', type: 4, required: false, min_value: 0, max_value: 7 }] },
  { name: 'unban',     description: 'Unban a user by their Discord ID',      options: [{ name: 'userid', description: 'Discord user ID', type: 3, required: true }, { name: 'reason', description: 'Reason', type: 3, required: false }] },
  { name: 'timeout',   description: 'Timeout a user for a set duration',     options: [{ name: 'user', description: 'User to timeout', type: 6, required: true }, { name: 'minutes', description: 'Duration in minutes', type: 4, required: true, min_value: 1, max_value: 40320 }, { name: 'reason', description: 'Reason', type: 3, required: false }] },
  { name: 'untimeout', description: 'Remove a timeout from a user',          options: [{ name: 'user', description: 'User to untimeout', type: 6, required: true }] },
  { name: 'purge',     description: 'Bulk-delete messages from this channel', options: [{ name: 'amount', description: 'Number of messages (1–100)', type: 4, required: true, min_value: 1, max_value: 100 }, { name: 'user', description: 'Only delete messages from this user (optional)', type: 6, required: false }] },

  // ── Shift management & wellness ──
  {
    name: 'shift',
    description: 'Manage your on-duty shift',
    options: [
      { name: 'start',  description: 'Start your shift (clock in / on duty)', type: 1 },
      { name: 'pause',  description: 'Pause your current shift',              type: 1 },
      { name: 'resume', description: 'Resume a paused shift',                 type: 1 },
      { name: 'end',    description: 'End your shift (clock out)',            type: 1 },
      { name: 'active', description: 'List everyone currently on shift',      type: 1 },
    ],
  },

  // ── Info & lookup ──
  { name: 'ping',       description: 'Check bot latency' },
  { name: 'userinfo',   description: 'Show info about a user',   options: [{ name: 'user', description: 'User to look up', type: 6, required: false }] },
  { name: 'serverinfo', description: 'Show server stats and info' },
  { name: 'roleinfo',   description: 'Show info about a role',   options: [{ name: 'role', description: 'Role to inspect', type: 8, required: true }] },
  { name: 'avatar',     description: 'Show a user\'s full avatar', options: [{ name: 'user', description: 'User to show', type: 6, required: false }] },
  { name: 'stats',      description: 'Show open ticket/appeal counts and warn totals' },

  // ── Utility ──
  { name: 'say',      description: 'Make the bot say something in a channel', options: [{ name: 'message', description: 'What to say', type: 3, required: true }, { name: 'channel', description: 'Target channel (default: here)', type: 7, required: false }] },
  { name: 'embed',    description: 'Post a custom embed in this channel', options: [{ name: 'title', description: 'Embed title', type: 3, required: true }, { name: 'description', description: 'Embed body', type: 3, required: true }, { name: 'color', description: 'Hex color e.g. #ff0000', type: 3, required: false }] },
  { name: 'announce', description: 'Send an announcement embed to a channel', options: [{ name: 'channel', description: 'Target channel', type: 7, required: true }, { name: 'message', description: 'Announcement text', type: 3, required: true }] },
  { name: 'poll',     description: 'Post a yes/no or custom poll', options: [{ name: 'question', description: 'Poll question', type: 3, required: true }, { name: 'options', description: 'Comma-separated choices (leave blank for Yes/No)', type: 3, required: false }] },
  { name: 'remind',   description: 'Set a reminder for yourself', options: [{ name: 'minutes', description: 'Minutes from now', type: 4, required: true, min_value: 1, max_value: 10080 }, { name: 'message', description: 'What to remind you about', type: 3, required: true }] },
  { name: 'dm',       description: 'Send a DM to a user as the bot', options: [{ name: 'user', description: 'User to DM', type: 6, required: true }, { name: 'message', description: 'Message to send', type: 3, required: true }] },
  { name: 'botinfo',  description: 'Show bot version, uptime, and system info' },
];

client.once('ready', async () => {
  console.log(`🤖 Bot ready as ${client.user.tag}`);
  try {
    await client.application.commands.set(SLASH_COMMANDS);
    console.log(`✅ ${SLASH_COMMANDS.length} slash commands registered`);
  } catch (err) {
    console.error('❌ Failed to register slash commands:', err);
  }
  // Start the wellness-check scheduler once the bot is logged in
  setInterval(runWellnessCheck, WELLNESS_POLL_MS);
  runWellnessCheck(); // run one pass immediately on boot
});

client.login(DISCORD_BOT_TOKEN).catch((err) => {
  console.error('❌ Discord login failed:', err.message);
  process.exit(1);
});

// ── 4. Helpers ────────────────────────────────────────────────

function isTicketChannel(channel) {
  const name = channel.name || '';
  return name.startsWith('appeal-') || name.startsWith('discord_ban-') ||
         name.startsWith('ingame_ban-') || name.startsWith('general_support-');
}

async function requireTicketChannel(interaction) {
  if (!isTicketChannel(interaction.channel)) {
    await interaction.reply({ content: '❌ This command can only be used inside a ticket or appeal channel.', ephemeral: true });
    return false;
  }
  return true;
}

function requireStaff(interaction, perm = PermissionFlagsBits.ManageChannels) {
  return interaction.member.permissions.has(perm);
}

async function createPrivateChannel(guild, targetUserId, channelName) {
  const member = await guild.members.fetch(targetUserId);
  return guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ],
  });
}

function closeButtonRow(label = 'Close') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('close_ticket_btn').setLabel(label).setEmoji('🔒').setStyle(ButtonStyle.Danger)
  );
}

async function findExistingChannel(guild, channelName) {
  await guild.channels.fetch();
  return guild.channels.cache.find((c) => c.name === channelName);
}

const TICKET_STYLE = {
  discord_ban:     { color: '#ed4245', emoji: '🔨', label: 'Discord Ban Appeal' },
  ingame_ban:      { color: '#f57c00', emoji: '🎮', label: 'In-Game Ban Appeal' },
  general_support: { color: '#5865f2', emoji: '🛠️', label: 'General Support' },
};
const APPEAL_STYLE = { color: '#0099ff', emoji: '⚖️' };

function styleFor(ticketType) {
  return TICKET_STYLE[ticketType] || { color: '#00ff00', emoji: '📋', label: ticketType.replace(/_/g, ' ').toUpperCase() };
}

// Send an action to the mod log channel
async function sendModLog(guild, embed) {
  const logChannel = guild.channels.cache.get(LOG_CHANNEL_ID);
  if (logChannel) await logChannel.send({ embeds: [embed] }).catch(console.error);
}

// ── Plain-text transcript ─────────────────────────────────────
async function fetchAllMessages(channel, cap = 1000) {
  let all = [], before;
  while (all.length < cap) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (batch.size === 0) break;
    all = all.concat([...batch.values()]);
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return all.reverse();
}

function buildTextTranscript({ channelName, ticketLabel, openedAt, closedAt, closedBy, messages }) {
  const D = '─'.repeat(60);
  const header = [D, `  PAR MODERATION — ${ticketLabel.toUpperCase()}`, D,
    `  Channel  : #${channelName}`, `  Opened   : ${openedAt}`,
    `  Closed   : ${closedAt}`, `  Closed by: ${closedBy}`,
    `  Messages : ${messages.length}`, D, ''].join('\n');

  const body = messages.map((m) => {
    const time = new Date(m.createdTimestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const lines = [`[${time}] ${m.author.username}${m.author.bot ? ' [BOT]' : ''}:`];
    if (m.content) lines.push(`  ${m.content.replace(/\n/g, '\n  ')}`);
    for (const e of m.embeds) {
      lines.push('  ┌── Embed ──────────────────────────');
      if (e.title) lines.push(`  │ Title: ${e.title}`);
      if (e.description) lines.push(`  │ Desc : ${e.description.replace(/\n/g, '\n  │        ')}`);
      for (const f of e.fields || []) {
        if (f.name && f.name !== '\u200B') lines.push(`  │ ${f.name}: ${f.value.replace(/\n/g, '\n  │   ')}`);
      }
      lines.push('  └────────────────────────────────────');
    }
    for (const att of m.attachments.values()) lines.push(`  [Attachment: ${att.name} — ${att.url}]`);
    return lines.join('\n');
  }).join('\n\n');

  return header + (body || '  (No messages.)') + `\n\n${D}\n  Generated by PAR Moderation • ${closedAt}\n${D}`;
}

async function performClose(interaction, channel) {
  const messages = await fetchAllMessages(channel);
  const openedAt = new Date(channel.createdTimestamp).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const closedAt = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const prefix = channel.name.split('-')[0];
  const style = prefix === 'appeal'
    ? { color: APPEAL_STYLE.color, label: 'Ban Appeal' }
    : { color: styleFor(prefix).color, label: styleFor(prefix).label };

  const transcript = buildTextTranscript({ channelName: channel.name, ticketLabel: style.label, openedAt, closedAt, closedBy: interaction.user.tag, messages });
  const attachment = new AttachmentBuilder(Buffer.from(transcript, 'utf-8'), { name: `transcript-${channel.name}.txt` });

  const summaryEmbed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`🔒 ${style.label} — Closed`)
    .addFields(
      { name: '📌 Channel',   value: `#${channel.name}`,   inline: true },
      { name: '👤 Closed By', value: interaction.user.tag, inline: true },
      { name: '💬 Messages',  value: `${messages.length}`, inline: true },
      { name: '🕒 Opened',    value: openedAt,             inline: true },
      { name: '🕒 Closed',    value: closedAt,             inline: true },
    )
    .setFooter({ text: 'Transcript attached as .txt' })
    .setTimestamp();

  const logChannel = interaction.guild.channels.cache.get(LOG_CHANNEL_ID);
  if (logChannel) await logChannel.send({ embeds: [summaryEmbed], files: [attachment] });

  try { await channel.send('🔒 Ticket closed. Channel deletes in 5 seconds.'); } catch { /**/ }
  setTimeout(() => channel.delete().catch(console.error), 5000);
}

// ── Firebase helpers ──────────────────────────────────────────

// Save a warning to Firestore and return the new doc ID
async function addWarning(targetUser, moderator, reason, guildId) {
  const ref = await addDoc(collection(db, 'warnings'), {
    userId: targetUser.id,
    username: targetUser.tag,
    moderatorId: moderator.id,
    moderatorTag: moderator.tag,
    reason,
    guildId,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

// Get all warnings for a user in this guild
async function getWarnings(userId, guildId) {
  const q = query(
    collection(db, 'warnings'),
    where('userId', '==', userId),
    where('guildId', '==', guildId),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Log a ban/kick/timeout action
async function logModAction(type, targetUser, moderator, reason, extra = {}) {
  await addDoc(collection(db, 'modlogs'), {
    type,
    userId: targetUser.id,
    username: targetUser.tag,
    moderatorId: moderator.id,
    moderatorTag: moderator.tag,
    reason: reason || 'No reason given',
    createdAt: serverTimestamp(),
    ...extra,
  });
}

// Get full mod history for a user
async function getModLogs(userId) {
  const q = query(collection(db, 'modlogs'), where('userId', '==', userId), orderBy('createdAt', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ── Shift / Wellness helpers ────────────────────────────────────

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m || h) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function shiftDocId(guildId, userId) {
  return `${guildId}_${userId}`;
}

// Fetch a single user's shift record (or null if they've never started one)
async function getShift(guildId, userId) {
  const ref = doc(db, 'shifts', shiftDocId(guildId, userId));
  const snap = await getDoc(ref);
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// Create/overwrite a shift record when someone starts a shift
async function createShift(guildId, userId, username) {
  const ref = doc(db, 'shifts', shiftDocId(guildId, userId));
  const now = Timestamp.now();
  await setDoc(ref, {
    guildId,
    userId,
    username,
    status: 'active',        // 'active' | 'paused' | 'ended'
    startedAt: now,
    activeSince: now,         // resets whenever status becomes 'active' (start or resume)
    lastWellnessCheckAt: now, // resets on start/resume and after every wellness ping
    createdAt: now,
    updatedAt: now,
  });
}

// All shift records in a guild that are currently active or paused (i.e. "on shift")
async function getActiveGuildShifts(guildId) {
  const q = query(
    collection(db, 'shifts'),
    where('guildId', '==', guildId),
    where('status', 'in', ['active', 'paused']),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ── Wellness check scheduler ────────────────────────────────────
// Runs on an interval. Only pings people whose shift status is 'active'
// (paused/ended staff are skipped entirely) and who have been active for
// WELLNESS_CHECK_MINUTES since their last check-in (or since shift start).
async function runWellnessCheck() {
  try {
    const q = query(
      collection(db, 'shifts'),
      where('guildId', '==', GUILD_ID),
      where('status', '==', 'active'),
    );
    const snap = await getDocs(q);
    if (snap.empty) return;

    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild) return;
    const channel = guild.channels.cache.get(WELLNESS_CHANNEL_ID) || await guild.channels.fetch(WELLNESS_CHANNEL_ID).catch(() => null);
    if (!channel) return;

    const now = Date.now();
    const thresholdMs = WELLNESS_CHECK_MINUTES * 60 * 1000;

    for (const docSnap of snap.docs) {
      const shift = docSnap.data();
      const checkpointMs = (shift.lastWellnessCheckAt || shift.activeSince || shift.startedAt)?.toDate?.().getTime();
      if (!checkpointMs) continue;
      if (now - checkpointMs < thresholdMs) continue; // not due yet

      const startedMs = shift.startedAt?.toDate?.().getTime() ?? now;

      const embed = new EmbedBuilder()
        .setColor('#faa61a')
        .setTitle('🩺 Wellness Check')
        .setDescription(`Hey <@${shift.userId}>, you've been on duty for a while — just checking in on you!`)
        .addFields(
          { name: '🕒 On Shift For', value: formatDuration(now - startedMs), inline: true },
          { name: '📋 Status',       value: 'ON DUTY',                      inline: true },
        )
        .setFooter({ text: "Tap the button below to let us know you're okay." })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`wellness_ack_${shift.userId}`)
          .setLabel("I'm okay")
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success)
      );

      try {
        await channel.send({ content: `<@${shift.userId}>`, embeds: [embed], components: [row] });
      } catch (err) {
        console.error('Wellness check send failed:', err);
      }

      // Reset the clock so they get pinged again in another WELLNESS_CHECK_MINUTES
      // if they're still on duty, rather than being pinged every poll cycle.
      await updateDoc(doc(db, 'shifts', docSnap.id), { lastWellnessCheckAt: Timestamp.now() });
    }
  } catch (err) {
    console.error('Wellness check error:', err);
  }
}

// ── 5. Express app ────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const sessions = new Map();
function getSession(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return token ? sessions.get(token) : null;
}

app.get('/auth/login', (req, res) => {
  const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'identify' });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect(`${FRONTEND_URL}/?auth_error=1`);
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description);
    const userRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    const user = await userRes.json();
    const sessionToken = crypto.randomBytes(20).toString('hex');
    sessions.set(sessionToken, { id: user.id, username: user.username, globalName: user.global_name ?? user.username, avatar: user.avatar, access_token: tokenData.access_token });
    res.redirect(`${FRONTEND_URL}/#session=${sessionToken}`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect(`${FRONTEND_URL}/?auth_error=1`);
  }
});

app.get('/auth/me', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  res.json(user);
});

app.post('/api/appeal', async (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  const { robloxUsername, bannedFrom, banDate, banReason, appealReason } = req.body;
  if (!robloxUsername || !bannedFrom || !banDate || !banReason || !appealReason)
    return res.status(400).json({ error: 'Please fill in all fields.' });
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channelName = `appeal-${user.username.toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
    const existing = await findExistingChannel(guild, channelName);
    if (existing) return res.status(400).json({ error: 'You already have an open appeal ticket.', channelUrl: `https://discord.com/channels/${GUILD_ID}/${existing.id}` });
    await addDoc(collection(db, 'appeals'), { robloxUsername, discordUsername: user.username, discordId: user.id, bannedFrom, banDate, banReason, appealReason, status: 'pending', submittedAt: serverTimestamp(), source: 'web' });
    const channel = await createPrivateChannel(guild, user.id, channelName);
    const embed = new EmbedBuilder().setColor(APPEAL_STYLE.color)
      .setAuthor({ name: `${APPEAL_STYLE.emoji} NEW BAN APPEAL — WEB FORM`, iconURL: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` })
      .setThumbnail(`https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`)
      .addFields(
        { name: '🧍 Roblox Username', value: robloxUsername, inline: true },
        { name: '💬 Discord Account', value: `<@${user.id}> (${user.username})`, inline: true },
        { name: '\u200B', value: '\u200B' },
        { name: '🚫 Banned From', value: bannedFrom }, { name: '📅 Approx. Ban Date', value: banDate },
        { name: '📜 Reason for Ban', value: banReason }, { name: '🙏 Appeal Statement', value: appealReason },
      ).setFooter({ text: 'Submitted via web portal' }).setTimestamp();
    await channel.send({ content: `<@${user.id}> Your appeal has been received. Staff will review it shortly.`, embeds: [embed], components: [closeButtonRow('Close Appeal')] });
    res.json({ message: 'Appeal submitted!', channelName, channelUrl: `https://discord.com/channels/${GUILD_ID}/${channel.id}` });
  } catch (err) { console.error('Appeal error:', err); res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/ticket', async (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  const { ticketType, userId, banInfo, ruleBroken, eventExpl, liftReason } = req.body;
  if (!ticketType || !userId || !ruleBroken || !eventExpl || !liftReason)
    return res.status(400).json({ error: 'Please fill in all required fields.' });
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const safeType = ticketType.replace(/[^a-z0-9_]/gi, '').toLowerCase();
    const channelName = `${safeType}-${user.username.toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
    const existing = await findExistingChannel(guild, channelName);
    if (existing) return res.status(400).json({ error: 'You already have an open ticket of this type.', channelUrl: `https://discord.com/channels/${GUILD_ID}/${existing.id}` });
    const channel = await createPrivateChannel(guild, user.id, channelName);
    const style = styleFor(safeType);
    const embed = new EmbedBuilder().setColor(style.color)
      .setAuthor({ name: `${style.emoji} ${style.label.toUpperCase()} — WEB FORM`, iconURL: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` })
      .setThumbnail(`https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`)
      .addFields(
        { name: '💬 Discord Account', value: `<@${user.id}> (${user.username})`, inline: true },
        { name: '🆔 Reported User/ID', value: userId, inline: true },
        { name: '\u200B', value: '\u200B' },
        { name: '📅 Ban Date / Staff', value: banInfo || 'Unknown' },
        { name: '📜 Rule Broken', value: ruleBroken }, { name: '🗒️ Explanation', value: eventExpl }, { name: '🙏 Why Lift Ban?', value: liftReason },
      ).setFooter({ text: 'Submitted via web portal' }).setTimestamp();
    await channel.send({ content: `<@${user.id}> Your ticket has been opened. Staff will assist you shortly.`, embeds: [embed], components: [closeButtonRow('Close Ticket')] });
    res.json({ message: 'Ticket submitted!', channelName, channelUrl: `https://discord.com/channels/${GUILD_ID}/${channel.id}` });
  } catch (err) { console.error('Ticket error:', err); res.status(500).json({ error: 'Server error.' }); }
});

app.listen(PORT || 3001, '0.0.0.0', () => console.log(`🌐 PAR backend listening on port ${PORT || 3001}`));

// ── 6. Interaction handler ────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // ════════════════════════════════════════════════════════════
  //  SLASH COMMANDS
  // ════════════════════════════════════════════════════════════
  if (interaction.isChatInputCommand()) {
    const cmd = interaction.commandName;

    // ── /ticket-setup & /panel ───────────────────────────────
    if (cmd === 'ticket-setup' || cmd === 'panel') {
      if (!requireStaff(interaction, PermissionFlagsBits.Administrator))
        return interaction.reply({ content: '❌ Administrators only.', ephemeral: true });

      const embed = new EmbedBuilder().setColor('#ffd700')
        .setTitle('📥 PAR Support Ticket System')
        .setDescription('Select the type of assistance you need below to open a private support room.');
      const select = new StringSelectMenuBuilder().setCustomId('ticket_type_select').setPlaceholder('Select ticket type...')
        .addOptions([
          { label: 'Discord Ban Appeal', value: 'discord_ban',     emoji: '🔨' },
          { label: 'In-Game Ban Appeal', value: 'ingame_ban',      emoji: '🎮' },
          { label: 'General Support',    value: 'general_support', emoji: '🛠️' },
        ]);
      await interaction.reply({ content: '✅ Panel deployed!', ephemeral: true });
      return interaction.channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] });
    }

    // ── /appeal ──────────────────────────────────────────────
    if (cmd === 'appeal') {
      const modal = new ModalBuilder().setCustomId('appealModal').setTitle('PAR Ban Appeal Form');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('robloxUser').setLabel('Your Roblox Username').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bannedFrom').setLabel('Banned From (Game / server?)').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('banDate').setLabel('Approximate Ban Date').setStyle(TextInputStyle.Short).setPlaceholder('e.g., June 15, 2026').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('banReason').setLabel('Reason for Ban').setStyle(TextInputStyle.Paragraph).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('appealReason').setLabel('Appeal Reason (Why unban?)').setStyle(TextInputStyle.Paragraph).setRequired(true)),
      );
      return interaction.showModal(modal);
    }

    // ── /ping ────────────────────────────────────────────────
    if (cmd === 'ping') {
      const sent = await interaction.reply({ content: '🏓 Pinging...', fetchReply: true });
      return interaction.editReply(`🏓 **Pong!**\nBot latency: **${sent.createdTimestamp - interaction.createdTimestamp}ms** | API: **${Math.round(client.ws.ping)}ms**`);
    }

    // ── /botinfo ─────────────────────────────────────────────
    if (cmd === 'botinfo') {
      const uptime = process.uptime();
      const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60), s = Math.floor(uptime % 60);
      const mem = process.memoryUsage();
      const embed = new EmbedBuilder().setColor('#5865f2')
        .setTitle(`🤖 ${client.user.username} — Bot Info`)
        .setThumbnail(client.user.displayAvatarURL())
        .addFields(
          { name: '⏱️ Uptime',       value: `${h}h ${m}m ${s}s`,                         inline: true },
          { name: '📡 API Latency',  value: `${Math.round(client.ws.ping)}ms`,             inline: true },
          { name: '💾 Memory',       value: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`, inline: true },
          { name: '🏠 Servers',      value: `${client.guilds.cache.size}`,                 inline: true },
          { name: '👥 Members',      value: `${client.guilds.cache.reduce((a, g) => a + g.memberCount, 0)}`, inline: true },
          { name: '⚙️ Commands',     value: `${SLASH_COMMANDS.length}`,                   inline: true },
          { name: '📦 Node.js',      value: process.version,                              inline: true },
          { name: '🔧 discord.js',   value: 'v14',                                        inline: true },
        ).setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ── /userinfo ────────────────────────────────────────────
    if (cmd === 'userinfo') {
      const target = interaction.options.getUser('user') || interaction.user;
      let member;
      try { member = await interaction.guild.members.fetch(target.id); } catch { /**/ }
      const warns = await getWarnings(target.id, interaction.guild.id);
      const embed = new EmbedBuilder().setColor('#5865f2')
        .setTitle(`👤 ${target.username}`)
        .setThumbnail(target.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'Tag',           value: target.tag,                                                                  inline: true },
          { name: 'ID',            value: target.id,                                                                   inline: true },
          { name: 'Bot?',          value: target.bot ? 'Yes' : 'No',                                                  inline: true },
          { name: 'Account Created', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:R>`,                    inline: true },
          { name: 'Joined Server',   value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'N/A',   inline: true },
          { name: '⚠️ Warnings',   value: `${warns.length}`,                                                          inline: true },
          { name: 'Roles',         value: member ? (member.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => `<@&${r.id}>`).join(', ') || 'None') : 'N/A' },
        ).setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ── /serverinfo ──────────────────────────────────────────
    if (cmd === 'serverinfo') {
      const g = interaction.guild;
      await g.fetch();
      const embed = new EmbedBuilder().setColor('#ffd700')
        .setTitle(`🏠 ${g.name}`)
        .setThumbnail(g.iconURL({ size: 256 }))
        .addFields(
          { name: 'Owner',       value: `<@${g.ownerId}>`,                                                  inline: true },
          { name: 'ID',          value: g.id,                                                               inline: true },
          { name: 'Created',     value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`,                  inline: true },
          { name: 'Members',     value: `${g.memberCount}`,                                                inline: true },
          { name: 'Channels',    value: `${g.channels.cache.size}`,                                        inline: true },
          { name: 'Roles',       value: `${g.roles.cache.size}`,                                           inline: true },
          { name: 'Boost Level', value: `Level ${g.premiumTier} (${g.premiumSubscriptionCount} boosts)`,  inline: true },
          { name: 'Verification', value: ['None','Low','Medium','High','Very High'][g.verificationLevel],  inline: true },
        ).setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    // ── /roleinfo ────────────────────────────────────────────
    if (cmd === 'roleinfo') {
      const role = interaction.options.getRole('role');
      const perms = role.permissions.toArray().slice(0, 10).map(p => `\`${p}\``).join(', ') || 'None';
      const embed = new EmbedBuilder().setColor(role.hexColor || '#5865f2')
        .setTitle(`🎭 ${role.name}`)
        .addFields(
          { name: 'ID',         value: role.id,                                                       inline: true },
          { name: 'Color',      value: role.hexColor,                                                 inline: true },
          { name: 'Position',   value: `${role.position}`,                                           inline: true },
          { name: 'Members',    value: `${role.members.size}`,                                       inline: true },
          { name: 'Mentionable', value: role.mentionable ? 'Yes' : 'No',                            inline: true },
          { name: 'Hoisted',    value: role.hoist ? 'Yes' : 'No',                                   inline: true },
          { name: 'Created',    value: `<t:${Math.floor(role.createdTimestamp / 1000)}:R>`,          inline: true },
          { name: 'Key Permissions', value: perms },
        ).setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ── /avatar ──────────────────────────────────────────────
    if (cmd === 'avatar') {
      const target = interaction.options.getUser('user') || interaction.user;
      const url = target.displayAvatarURL({ size: 1024, extension: 'png' });
      const embed = new EmbedBuilder().setColor('#5865f2')
        .setTitle(`🖼️ ${target.username}'s Avatar`)
        .setImage(url)
        .setDescription(`[Open full size](${url})`);
      return interaction.reply({ embeds: [embed] });
    }

    // ── /stats ───────────────────────────────────────────────
    if (cmd === 'stats') {
      if (!requireStaff(interaction)) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      await interaction.guild.channels.fetch();
      const openTickets = interaction.guild.channels.cache.filter(c => isTicketChannel(c)).size;
      const warnSnap = await getDocs(collection(db, 'warnings'));
      const appealSnap = await getDocs(query(collection(db, 'appeals'), where('status', '==', 'pending')));
      const embed = new EmbedBuilder().setColor('#5865f2')
        .setTitle('📊 PAR Bot Stats')
        .addFields(
          { name: '🎫 Open Tickets', value: `${openTickets}`, inline: true },
          { name: '⏳ Pending Appeals', value: `${appealSnap.size}`, inline: true },
          { name: '⚠️ Total Warnings', value: `${warnSnap.size}`, inline: true },
          { name: '🏠 Server Members', value: `${interaction.guild.memberCount}`, inline: true },
          { name: '⚙️ Commands',       value: `${SLASH_COMMANDS.length}`, inline: true },
          { name: '📡 API Latency',    value: `${Math.round(client.ws.ping)}ms`, inline: true },
        ).setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /warn ────────────────────────────────────────────────
    if (cmd === 'warn') {
      if (!requireStaff(interaction)) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
      const target = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason');
      await interaction.deferReply();
      const warnId = await addWarning(target, interaction.user, reason, interaction.guild.id);
      const allWarns = await getWarnings(target.id, interaction.guild.id);

      const embed = new EmbedBuilder().setColor('#fee75c')
        .setTitle('⚠️ Warning Issued')
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: '👤 User',      value: `<@${target.id}> (${target.tag})`, inline: true },
          { name: '👮 By',        value: `<@${interaction.user.id}>`,       inline: true },
          { name: '📋 Total Warns', value: `${allWarns.length}`,            inline: true },
          { name: '📜 Reason',    value: reason },
          { name: '🆔 Warning ID', value: `\`${warnId}\`` },
        ).setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      await sendModLog(interaction.guild, embed);

      // DM the warned user
      try {
        const dmEmbed = new EmbedBuilder().setColor('#fee75c')
          .setTitle(`⚠️ You have been warned in ${interaction.guild.name}`)
          .addFields({ name: '📜 Reason', value: reason }, { name: '📋 Total Warnings', value: `${allWarns.length}` })
          .setTimestamp();
        await target.send({ embeds: [dmEmbed] });
      } catch { /**/ }
    }

    // ── /warnings ────────────────────────────────────────────
    if (cmd === 'warnings') {
      if (!requireStaff(interaction)) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
      const target = interaction.options.getUser('user');
      await interaction.deferReply({ ephemeral: true });
      const warns = await getWarnings(target.id, interaction.guild.id);
      if (warns.length === 0) return interaction.editReply(`✅ **${target.tag}** has no warnings.`);

      const fields = warns.slice(0, 10).map((w, i) => {
        const ts = w.createdAt?.toDate ? Math.floor(w.createdAt.toDate().getTime() / 1000) : 0;
        return { name: `#${i + 1} — ID: \`${w.id}\``, value: `**Reason:** ${w.reason}\n**By:** ${w.moderatorTag}\n**When:** ${ts ? `<t:${ts}:R>` : 'Unknown'}` };
      });

      const embed = new EmbedBuilder().setColor('#fee75c')
        .setTitle(`⚠️ Warnings for ${target.tag}`)
        .setDescription(`Total: **${warns.length}**`)
        .addFields(fields)
        .setFooter({ text: warns.length > 10 ? `Showing 10 of ${warns.length}` : '' })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /clearwarn ───────────────────────────────────────────
    if (cmd === 'clearwarn') {
      if (!requireStaff(interaction)) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
      const warnId = interaction.options.getString('id');
      await interaction.deferReply({ ephemeral: true });
      try {
        const ref = doc(db, 'warnings', warnId);
        const snap = await getDoc(ref);
        if (!snap.exists()) return interaction.editReply('❌ Warning ID not found.');
        await deleteDoc(ref);
        return interaction.editReply(`✅ Warning \`${warnId}\` deleted.`);
      } catch (err) {
        console.error('/clearwarn:', err);
        return interaction.editReply('❌ Failed to delete warning.');
      }
    }

    // ── /modlogs ─────────────────────────────────────────────
    if (cmd === 'modlogs') {
      if (!requireStaff(interaction)) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
      const target = interaction.options.getUser('user');
      await interaction.deferReply({ ephemeral: true });
      const [logs, warns] = await Promise.all([getModLogs(target.id), getWarnings(target.id, interaction.guild.id)]);
      if (logs.length === 0 && warns.length === 0) return interaction.editReply(`✅ **${target.tag}** has a clean record.`);

      const logFields = logs.slice(0, 8).map((l) => {
        const ts = l.createdAt?.toDate ? Math.floor(l.createdAt.toDate().getTime() / 1000) : 0;
        const icon = { ban: '🔨', kick: '👢', timeout: '⏱️', unban: '✅', untimeout: '✅' }[l.type] || '📋';
        return { name: `${icon} ${l.type.toUpperCase()} ${ts ? `— <t:${ts}:R>` : ''}`, value: `**Reason:** ${l.reason}\n**By:** ${l.moderatorTag}` };
      });

      const embed = new EmbedBuilder().setColor('#ed4245')
        .setTitle(`📋 Mod History — ${target.tag}`)
        .setThumbnail(target.displayAvatarURL())
        .setDescription(`**${warns.length}** warning(s) • **${logs.length}** action(s)`)
        .addFields(logFields.length ? logFields : [{ name: 'Actions', value: 'None on record' }])
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /kick ────────────────────────────────────────────────
    if (cmd === 'kick') {
      if (!requireStaff(interaction, PermissionFlagsBits.KickMembers))
        return interaction.reply({ content: '❌ You need Kick Members permission.', ephemeral: true });
      const target = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'No reason given';
      await interaction.deferReply();
      try {
        const member = await interaction.guild.members.fetch(target.id);
        await member.kick(reason);
        await logModAction('kick', target, interaction.user, reason);
        const embed = new EmbedBuilder().setColor('#ed4245')
          .setTitle('👢 Member Kicked')
          .addFields(
            { name: '👤 User',    value: `${target.tag}`, inline: true },
            { name: '👮 By',      value: interaction.user.tag, inline: true },
            { name: '📜 Reason',  value: reason },
          ).setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        await sendModLog(interaction.guild, embed);
        try { await target.send(`👢 You have been kicked from **${interaction.guild.name}**.\nReason: ${reason}`); } catch { /**/ }
      } catch (err) {
        console.error('/kick:', err);
        return interaction.editReply('❌ Failed to kick. Check my permissions and role position.');
      }
    }

    // ── /ban ─────────────────────────────────────────────────
    if (cmd === 'ban') {
      if (!requireStaff(interaction, PermissionFlagsBits.BanMembers))
        return interaction.reply({ content: '❌ You need Ban Members permission.', ephemeral: true });
      const target = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason');
      const days = interaction.options.getInteger('days') ?? 0;
      await interaction.deferReply();
      try {
        try { await target.send(`🔨 You have been banned from **${interaction.guild.name}**.\nReason: ${reason}`); } catch { /**/ }
        await interaction.guild.members.ban(target.id, { reason, deleteMessageDays: days });
        await logModAction('ban', target, interaction.user, reason, { deleteMessageDays: days });
        const embed = new EmbedBuilder().setColor('#ed4245')
          .setTitle('🔨 Member Banned')
          .addFields(
            { name: '👤 User',         value: `${target.tag} (${target.id})`, inline: true },
            { name: '👮 By',           value: interaction.user.tag,           inline: true },
            { name: '🗑️ Msgs Deleted', value: `${days} day(s)`,              inline: true },
            { name: '📜 Reason',       value: reason },
          ).setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        await sendModLog(interaction.guild, embed);
      } catch (err) {
        console.error('/ban:', err);
        return interaction.editReply('❌ Failed to ban. Check my permissions and role position.');
      }
    }

    // ── /unban ───────────────────────────────────────────────
    if (cmd === 'unban') {
      if (!requireStaff(interaction, PermissionFlagsBits.BanMembers))
        return interaction.reply({ content: '❌ You need Ban Members permission.', ephemeral: true });
      const userId = interaction.options.getString('userid');
      const reason = interaction.options.getString('reason') || 'No reason given';
      await interaction.deferReply();
      try {
        const ban = await interaction.guild.bans.fetch(userId);
        await interaction.guild.members.unban(userId, reason);
        await logModAction('unban', { id: userId, tag: ban.user.tag }, interaction.user, reason);
        const embed = new EmbedBuilder().setColor('#57f287')
          .setTitle('✅ Member Unbanned')
          .addFields(
            { name: '👤 User',    value: `${ban.user.tag} (${userId})`, inline: true },
            { name: '👮 By',      value: interaction.user.tag,          inline: true },
            { name: '📜 Reason',  value: reason },
          ).setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        await sendModLog(interaction.guild, embed);
      } catch (err) {
        console.error('/unban:', err);
        return interaction.editReply('❌ Could not find that ban or failed to unban.');
      }
    }

    // ── /timeout ─────────────────────────────────────────────
    if (cmd === 'timeout') {
      if (!requireStaff(interaction, PermissionFlagsBits.ModerateMembers))
        return interaction.reply({ content: '❌ You need Moderate Members permission.', ephemeral: true });
      const target = interaction.options.getUser('user');
      const minutes = interaction.options.getInteger('minutes');
      const reason = interaction.options.getString('reason') || 'No reason given';
      await interaction.deferReply();
      try {
        const member = await interaction.guild.members.fetch(target.id);
        await member.timeout(minutes * 60 * 1000, reason);
        await logModAction('timeout', target, interaction.user, reason, { durationMinutes: minutes });
        const embed = new EmbedBuilder().setColor('#f57c00')
          .setTitle('⏱️ Member Timed Out')
          .addFields(
            { name: '👤 User',      value: `${target.tag}`,     inline: true },
            { name: '⏱️ Duration',  value: `${minutes} min(s)`, inline: true },
            { name: '👮 By',        value: interaction.user.tag, inline: true },
            { name: '📜 Reason',    value: reason },
          ).setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        await sendModLog(interaction.guild, embed);
        try { await target.send(`⏱️ You have been timed out in **${interaction.guild.name}** for ${minutes} minute(s).\nReason: ${reason}`); } catch { /**/ }
      } catch (err) {
        console.error('/timeout:', err);
        return interaction.editReply('❌ Failed to timeout. Check permissions.');
      }
    }

    // ── /untimeout ───────────────────────────────────────────
    if (cmd === 'untimeout') {
      if (!requireStaff(interaction, PermissionFlagsBits.ModerateMembers))
        return interaction.reply({ content: '❌ You need Moderate Members permission.', ephemeral: true });
      const target = interaction.options.getUser('user');
      await interaction.deferReply();
      try {
        const member = await interaction.guild.members.fetch(target.id);
        await member.timeout(null);
        const embed = new EmbedBuilder().setColor('#57f287')
          .setTitle('✅ Timeout Removed')
          .addFields({ name: '👤 User', value: `${target.tag}`, inline: true }, { name: '👮 By', value: interaction.user.tag, inline: true })
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        await sendModLog(interaction.guild, embed);
      } catch (err) {
        console.error('/untimeout:', err);
        return interaction.editReply('❌ Failed to remove timeout.');
      }
    }

    // ── /purge ───────────────────────────────────────────────
    if (cmd === 'purge') {
      if (!requireStaff(interaction, PermissionFlagsBits.ManageMessages))
        return interaction.reply({ content: '❌ You need Manage Messages permission.', ephemeral: true });
      const amount = interaction.options.getInteger('amount');
      const filterUser = interaction.options.getUser('user');
      await interaction.deferReply({ ephemeral: true });
      try {
        let messages = await interaction.channel.messages.fetch({ limit: 100 });
        if (filterUser) messages = messages.filter(m => m.author.id === filterUser.id);
        const toDelete = [...messages.values()].slice(0, amount);
        const deleted = await interaction.channel.bulkDelete(toDelete, true);
        return interaction.editReply(`🗑️ Deleted **${deleted.size}** message(s)${filterUser ? ` from ${filterUser.tag}` : ''}.`);
      } catch (err) {
        console.error('/purge:', err);
        return interaction.editReply('❌ Failed to delete messages. Messages older than 14 days cannot be bulk-deleted.');
      }
    }

    // ── /shift ───────────────────────────────────────────────
    if (cmd === 'shift') {
      const sub = interaction.options.getSubcommand();
      const guildId = interaction.guild.id;
      const userId = interaction.user.id;

      if (sub === 'start') {
        const existing = await getShift(guildId, userId);
        if (existing && existing.status !== 'ended') {
          return interaction.reply({ content: `❌ You're already on shift (status: **${existing.status.toUpperCase()}**). Use \`/shift end\` first.`, ephemeral: true });
        }
        await createShift(guildId, userId, interaction.user.username);
        const embed = new EmbedBuilder().setColor('#57f287')
          .setTitle('🟢 Shift Started')
          .setDescription(`<@${userId}> is now **ON DUTY**. You'll get a wellness check-in every ${WELLNESS_CHECK_MINUTES} minutes while active.`)
          .setTimestamp();
        await interaction.reply({ embeds: [embed] });
        return sendModLog(interaction.guild, embed);
      }

      if (sub === 'pause' || sub === 'resume' || sub === 'end') {
        const shift = await getShift(guildId, userId);
        if (!shift || shift.status === 'ended') {
          return interaction.reply({ content: '❌ You are not currently on shift.', ephemeral: true });
        }

        if (sub === 'pause') {
          if (shift.status === 'paused') return interaction.reply({ content: '⏸️ Your shift is already paused.', ephemeral: true });
          await updateDoc(doc(db, 'shifts', shiftDocId(guildId, userId)), { status: 'paused', updatedAt: Timestamp.now() });
          const embed = new EmbedBuilder().setColor('#fee75c').setDescription(`⏸️ <@${userId}>'s shift is now **PAUSED**. Wellness checks are paused too.`);
          await interaction.reply({ embeds: [embed] });
          return sendModLog(interaction.guild, embed);
        }

        if (sub === 'resume') {
          if (shift.status === 'active') return interaction.reply({ content: '▶️ Your shift is already active.', ephemeral: true });
          const now = Timestamp.now();
          await updateDoc(doc(db, 'shifts', shiftDocId(guildId, userId)), { status: 'active', activeSince: now, lastWellnessCheckAt: now, updatedAt: now });
          const embed = new EmbedBuilder().setColor('#57f287').setDescription(`▶️ <@${userId}>'s shift is **ACTIVE** again.`);
          await interaction.reply({ embeds: [embed] });
          return sendModLog(interaction.guild, embed);
        }

        if (sub === 'end') {
          const startedMs = shift.startedAt?.toDate?.().getTime() ?? Date.now();
          await updateDoc(doc(db, 'shifts', shiftDocId(guildId, userId)), { status: 'ended', endedAt: Timestamp.now(), updatedAt: Timestamp.now() });
          const embed = new EmbedBuilder().setColor('#ed4245')
            .setTitle('🔴 Shift Ended')
            .setDescription(`<@${userId}> has clocked out.`)
            .addFields({ name: '🕒 Total Duration', value: formatDuration(Date.now() - startedMs) })
            .setTimestamp();
          await interaction.reply({ embeds: [embed] });
          return sendModLog(interaction.guild, embed);
        }
      }

      if (sub === 'active') {
        await interaction.deferReply();
        const shifts = await getActiveGuildShifts(guildId);
        if (shifts.length === 0) return interaction.editReply('📭 No one is currently on shift.');

        const now = Date.now();
        const lines = shifts
          .sort((a, b) => (a.startedAt?.toDate?.().getTime() ?? 0) - (b.startedAt?.toDate?.().getTime() ?? 0))
          .map((s, i) => {
            const started = s.startedAt?.toDate?.().getTime() ?? now;
            const statusIcon = s.status === 'active' ? '🟢' : '⏸️';
            return `${i + 1}. ${statusIcon} <@${s.userId}> — ${formatDuration(now - started)} (${s.status.toUpperCase()})`;
          });

        const embed = new EmbedBuilder().setColor('#5865f2')
          .setTitle('🕒 Active Shifts')
          .setDescription(lines.join('\n'))
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      }
    }

    // ── /say ─────────────────────────────────────────────────
    if (cmd === 'say') {
      if (!requireStaff(interaction)) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
      const message = interaction.options.getString('message');
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      try {
        await channel.send(message);
        return interaction.reply({ content: `✅ Message sent to ${channel}.`, ephemeral: true });
      } catch (err) {
        return interaction.reply({ content: '❌ Could not send message to that channel.', ephemeral: true });
      }
    }

    // ── /embed ───────────────────────────────────────────────
    if (cmd === 'embed') {
      if (!requireStaff(interaction)) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
      const title = interaction.options.getString('title');
      const description = interaction.options.getString('description');
      const color = interaction.options.getString('color') || '#5865f2';
      const validColor = /^#[0-9A-Fa-f]{6}$/.test(color) ? color : '#5865f2';
      const embed = new EmbedBuilder().setColor(validColor).setTitle(title).setDescription(description).setTimestamp();
      await interaction.channel.send({ embeds: [embed] });
      return interaction.reply({ content: '✅ Embed posted.', ephemeral: true });
    }

    // ── /announce ────────────────────────────────────────────
    if (cmd === 'announce') {
      if (!requireStaff(interaction, PermissionFlagsBits.Administrator))
        return interaction.reply({ content: '❌ Administrators only.', ephemeral: true });
      const targetChannel = interaction.options.getChannel('channel');
      const message = interaction.options.getString('message');
      const embed = new EmbedBuilder().setColor('#ffd700')
        .setTitle('📢 Announcement')
        .setDescription(message)
        .setFooter({ text: `Posted by ${interaction.user.tag}` })
        .setTimestamp();
      try {
        await targetChannel.send({ content: '@everyone', embeds: [embed] });
        return interaction.reply({ content: `✅ Announcement sent to ${targetChannel}.`, ephemeral: true });
      } catch {
        return interaction.reply({ content: '❌ Could not post to that channel.', ephemeral: true });
      }
    }

    // ── /poll ────────────────────────────────────────────────
    if (cmd === 'poll') {
      const question = interaction.options.getString('question');
      const optionsRaw = interaction.options.getString('options');
      const embed = new EmbedBuilder().setColor('#5865f2')
        .setTitle(`📊 Poll`)
        .setDescription(`**${question}**`)
        .setFooter({ text: `Poll by ${interaction.user.tag}` })
        .setTimestamp();

      if (!optionsRaw) {
        // Yes / No poll
        embed.addFields({ name: 'Options', value: '✅ Yes\n❌ No' });
        const msg = await interaction.channel.send({ embeds: [embed] });
        await msg.react('✅');
        await msg.react('❌');
      } else {
        const opts = optionsRaw.split(',').map(o => o.trim()).slice(0, 9);
        const emojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];
        embed.addFields({ name: 'Options', value: opts.map((o, i) => `${emojis[i]} ${o}`).join('\n') });
        const msg = await interaction.channel.send({ embeds: [embed] });
        for (let i = 0; i < opts.length; i++) await msg.react(emojis[i]);
      }
      return interaction.reply({ content: '✅ Poll posted!', ephemeral: true });
    }

    // ── /remind ──────────────────────────────────────────────
    if (cmd === 'remind') {
      const minutes = interaction.options.getInteger('minutes');
      const message = interaction.options.getString('message');
      await interaction.reply({ content: `⏰ Got it! I'll remind you in **${minutes} minute(s)**: "${message}"`, ephemeral: true });
      setTimeout(async () => {
        try {
          await interaction.user.send(`⏰ **Reminder from ${interaction.guild.name}:**\n${message}`);
        } catch {
          // If DMs are closed, try posting in the channel
          try { await interaction.channel.send(`⏰ <@${interaction.user.id}> Reminder: ${message}`); } catch { /**/ }
        }
      }, minutes * 60 * 1000);
    }

    // ── /dm ──────────────────────────────────────────────────
    if (cmd === 'dm') {
      if (!requireStaff(interaction)) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
      const target = interaction.options.getUser('user');
      const message = interaction.options.getString('message');
      try {
        await target.send(`📨 **Message from ${interaction.guild.name} Staff:**\n${message}`);
        await interaction.reply({ content: `✅ DM sent to **${target.tag}**.`, ephemeral: true });
        await sendModLog(interaction.guild, new EmbedBuilder().setColor('#5865f2')
          .setTitle('📨 DM Sent via Bot')
          .addFields({ name: '👤 To', value: `${target.tag}`, inline: true }, { name: '👮 By', value: interaction.user.tag, inline: true }, { name: '📜 Message', value: message })
          .setTimestamp());
      } catch {
        return interaction.reply({ content: '❌ Could not DM that user (DMs may be closed).', ephemeral: true });
      }
    }

    // ── Ticket channel commands ───────────────────────────────

    if (cmd === 'add') {
      if (!await requireTicketChannel(interaction)) return;
      const target = interaction.options.getUser('user');
      try {
        await interaction.channel.permissionOverwrites.create(target.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        return interaction.reply({ embeds: [new EmbedBuilder().setColor('#57f287').setDescription(`✅ <@${target.id}> added to ticket by <@${interaction.user.id}>.`)] });
      } catch { return interaction.reply({ content: '❌ Failed to add user.', ephemeral: true }); }
    }

    if (cmd === 'remove') {
      if (!await requireTicketChannel(interaction)) return;
      const target = interaction.options.getUser('user');
      try {
        await interaction.channel.permissionOverwrites.delete(target.id);
        return interaction.reply({ embeds: [new EmbedBuilder().setColor('#ed4245').setDescription(`🚪 <@${target.id}> removed from ticket by <@${interaction.user.id}>.`)] });
      } catch { return interaction.reply({ content: '❌ Failed to remove user.', ephemeral: true }); }
    }

    if (cmd === 'rename') {
      if (!await requireTicketChannel(interaction)) return;
      const newName = interaction.options.getString('name').toLowerCase().replace(/[^a-z0-9-]/g, '-');
      try {
        const old = interaction.channel.name;
        await interaction.channel.setName(newName);
        return interaction.reply({ embeds: [new EmbedBuilder().setColor('#fee75c').setDescription(`✏️ Renamed **#${old}** → **#${newName}** by <@${interaction.user.id}>.`)] });
      } catch { return interaction.reply({ content: '❌ Failed to rename.', ephemeral: true }); }
    }

    if (cmd === 'claim') {
      if (!await requireTicketChannel(interaction)) return;
      try {
        await interaction.channel.setTopic(`🔵 Claimed by: ${interaction.user.tag}`);
        return interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865f2').setDescription(`🔵 **${interaction.user.tag}** has claimed this ticket.`)] });
      } catch { return interaction.reply({ content: '❌ Failed to claim.', ephemeral: true }); }
    }

    if (cmd === 'unclaim') {
      if (!await requireTicketChannel(interaction)) return;
      try {
        await interaction.channel.setTopic(null);
        return interaction.reply({ embeds: [new EmbedBuilder().setColor('#80848e').setDescription(`⚪ **${interaction.user.tag}** unclaimed this ticket. It is now unassigned.`)] });
      } catch { return interaction.reply({ content: '❌ Failed to unclaim.', ephemeral: true }); }
    }

    if (cmd === 'note') {
      if (!await requireTicketChannel(interaction)) return;
      if (!requireStaff(interaction)) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
      const text = interaction.options.getString('text');
      await interaction.reply({ content: '✅ Note saved.', ephemeral: true });
      return interaction.channel.send({ embeds: [new EmbedBuilder().setColor('#ffd700').setTitle('📝 Staff Note').setDescription(text).setFooter({ text: `By ${interaction.user.tag}` }).setTimestamp()] });
    }

    if (cmd === 'lock') {
      if (!await requireTicketChannel(interaction)) return;
      if (!requireStaff(interaction)) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
      try {
        const ow = interaction.channel.permissionOverwrites.cache.find(o => o.id !== interaction.guild.roles.everyone.id && o.id !== client.user.id);
        if (ow) await interaction.channel.permissionOverwrites.edit(ow.id, { SendMessages: false });
        return interaction.reply({ embeds: [new EmbedBuilder().setColor('#ed4245').setDescription(`🔒 Ticket locked by <@${interaction.user.id}>. Only staff can send messages.`)] });
      } catch { return interaction.reply({ content: '❌ Failed to lock.', ephemeral: true }); }
    }

    if (cmd === 'unlock') {
      if (!await requireTicketChannel(interaction)) return;
      if (!requireStaff(interaction)) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
      try {
        const ow = interaction.channel.permissionOverwrites.cache.find(o => o.id !== interaction.guild.roles.everyone.id && o.id !== client.user.id);
        if (ow) await interaction.channel.permissionOverwrites.edit(ow.id, { SendMessages: true });
        return interaction.reply({ embeds: [new EmbedBuilder().setColor('#57f287').setDescription(`🔓 Ticket unlocked by <@${interaction.user.id}>.`)] });
      } catch { return interaction.reply({ content: '❌ Failed to unlock.', ephemeral: true }); }
    }

    if (cmd === 'slowmode') {
      if (!requireStaff(interaction)) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
      const secs = interaction.options.getInteger('seconds');
      try {
        await interaction.channel.setRateLimitPerUser(secs);
        return interaction.reply({ content: secs === 0 ? '✅ Slowmode disabled.' : `✅ Slowmode set to **${secs}s**.` });
      } catch { return interaction.reply({ content: '❌ Failed.', ephemeral: true }); }
    }

    if (cmd === 'close') {
      if (!await requireTicketChannel(interaction)) return;
      if (!requireStaff(interaction)) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
      await interaction.reply({ content: '📑 Generating transcript and closing...' });
      await performClose(interaction, interaction.channel);
    }
  }

  // ════════════════════════════════════════════════════════════
  //  SELECT MENU
  // ════════════════════════════════════════════════════════════
  if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_type_select') {
    const modal = new ModalBuilder().setCustomId(`ticket_modal_${interaction.values[0]}`).setTitle('Kindly fill this form.');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('userId').setLabel('Discord Username & User ID').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('banInfo').setLabel('Date of Ban & Staff Member').setStyle(TextInputStyle.Short).setPlaceholder('(if known)').setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ruleBroken').setLabel('Exact Server Rule Broken').setStyle(TextInputStyle.Short).setPlaceholder('(e.g., Section B2)').setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('eventExpl').setLabel('Your detailed explanation').setStyle(TextInputStyle.Paragraph).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('liftReason').setLabel('Why should your ban be lifted?').setStyle(TextInputStyle.Paragraph).setRequired(true)),
    );
    return interaction.showModal(modal);
  }

  // ════════════════════════════════════════════════════════════
  //  MODAL SUBMITS
  // ════════════════════════════════════════════════════════════
  if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket_modal_')) {
    const ticketType = interaction.customId.replace('ticket_modal_', '');
    const { guild, user } = interaction;
    const channelName = `${ticketType}-${user.username.toLowerCase()}`;
    await interaction.deferReply({ ephemeral: true });
    const existing = await findExistingChannel(guild, channelName);
    if (existing) return interaction.editReply({ content: `❌ You already have an open ticket: ${existing}` });
    try {
      const ch = await createPrivateChannel(guild, user.id, channelName);
      const style = styleFor(ticketType);
      const embed = new EmbedBuilder().setColor(style.color)
        .setAuthor({ name: `${style.emoji} ${style.label.toUpperCase()} TICKET`, iconURL: user.displayAvatarURL() })
        .setThumbnail(user.displayAvatarURL())
        .addFields(
          { name: '🆔 User/ID',       value: interaction.fields.getTextInputValue('userId'),    inline: true },
          { name: '📅 Ban Date/Staff', value: interaction.fields.getTextInputValue('banInfo'),   inline: true },
          { name: '\u200B', value: '\u200B' },
          { name: '📜 Rule Broken',   value: interaction.fields.getTextInputValue('ruleBroken') },
          { name: '🗒️ Explanation',   value: interaction.fields.getTextInputValue('eventExpl') },
          { name: '🙏 Why Lift?',     value: interaction.fields.getTextInputValue('liftReason') },
        ).setFooter({ text: `Opened by ${user.tag}` }).setTimestamp();
      await ch.send({ content: `${user} welcome! Staff will be with you shortly.`, embeds: [embed], components: [closeButtonRow('Close Ticket')] });
      return interaction.editReply({ content: `✅ Ticket created: ${ch}` });
    } catch (err) {
      console.error('Ticket creation error:', err);
      return interaction.editReply({ content: '❌ Failed to create channel.' });
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === 'appealModal') {
    const robloxUsername = interaction.fields.getTextInputValue('robloxUser');
    const bannedFrom     = interaction.fields.getTextInputValue('bannedFrom');
    const banDate        = interaction.fields.getTextInputValue('banDate');
    const banReason      = interaction.fields.getTextInputValue('banReason');
    const appealReason   = interaction.fields.getTextInputValue('appealReason');
    const appealChannelName = `appeal-${interaction.user.username.toLowerCase()}`;
    await interaction.deferReply({ ephemeral: true });
    const existing = await findExistingChannel(interaction.guild, appealChannelName);
    if (existing) return interaction.editReply({ content: `❌ You already have an open appeal: ${existing}` });
    try {
      await addDoc(collection(db, 'appeals'), { robloxUsername, discordUsername: interaction.user.tag, discordId: interaction.user.id, bannedFrom, banDate, banReason, appealReason, status: 'pending', submittedAt: serverTimestamp(), source: 'discord' });
      const ch = await createPrivateChannel(interaction.guild, interaction.user.id, appealChannelName);
      const embed = new EmbedBuilder().setColor(APPEAL_STYLE.color)
        .setAuthor({ name: `${APPEAL_STYLE.emoji} NEW BAN APPEAL`, iconURL: interaction.user.displayAvatarURL() })
        .setThumbnail(interaction.user.displayAvatarURL())
        .addFields(
          { name: '🧍 Roblox Username', value: robloxUsername, inline: true },
          { name: '🚫 Banned From',     value: bannedFrom,     inline: true },
          { name: '\u200B', value: '\u200B' },
          { name: '📜 Reason',  value: banReason },
          { name: '🙏 Appeal',  value: appealReason },
        ).setFooter({ text: `Opened by ${interaction.user.tag}` }).setTimestamp();
      await ch.send({ content: `${interaction.user} Your appeal is logged. Staff will review it soon.`, embeds: [embed], components: [closeButtonRow('Close Appeal')] });
      return interaction.editReply({ content: `✅ Appeal submitted: ${ch}` });
    } catch (err) {
      console.error('Appeal modal error:', err);
      return interaction.editReply({ content: '❌ Error processing appeal.' });
    }
  }

  // ════════════════════════════════════════════════════════════
  //  BUTTONS
  // ════════════════════════════════════════════════════════════
  if (interaction.isButton() && interaction.customId === 'close_ticket_btn') {
    return interaction.reply({
      content: '⚠️ Are you sure? This will save a transcript and delete the channel.',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm_close').setLabel('Yes, Close & Save').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('cancel_close').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      )],
      ephemeral: true,
    });
  }

  if (interaction.isButton() && (interaction.customId === 'confirm_close' || interaction.customId === 'cancel_close')) {
    if (interaction.customId === 'cancel_close') return interaction.update({ content: '❌ Closing cancelled.', components: [] });
    await interaction.update({ content: '📑 Generating transcript...', components: [] });
    await performClose(interaction, interaction.channel);
  }

  // ── Wellness check acknowledge button ─────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('wellness_ack_')) {
    const targetId = interaction.customId.replace('wellness_ack_', '');
    if (interaction.user.id !== targetId) {
      return interaction.reply({ content: "❌ This check-in isn't for you.", ephemeral: true });
    }
    const original = interaction.message.embeds[0];
    const embed = EmbedBuilder.from(original)
      .setColor('#57f287')
      .setFooter({ text: `✅ Acknowledged by ${interaction.user.tag}` });
    return interaction.update({ embeds: [embed], components: [] });
  }
});

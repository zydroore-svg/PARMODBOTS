// ─────────────────────────────────────────────────────────────
//  PAR — Discord Bot (Moderation + Shift Management)
//  Run with:  node bot.js
// ─────────────────────────────────────────────────────────────
import express from 'express';
import { readFileSync } from 'fs';
import 'dotenv/config';

import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';

import admin from 'firebase-admin';

// ── 1. ENV VALIDATION ────────────────────────────────────────
const {
  DISCORD_BOT_TOKEN,
  GUILD_ID,
  LOG_CHANNEL_ID,
  FIREBASE_SERVICE_ACCOUNT_JSON,
  FIREBASE_SERVICE_ACCOUNT_PATH,
  FIREBASE_SERVICE_ACCOUNT_BASE64,
  PORT,
} = process.env;

const REQUIRED = { DISCORD_BOT_TOKEN, GUILD_ID, LOG_CHANNEL_ID };
const missing = Object.entries(REQUIRED).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error('Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

// ── Wellness check config ──────────────────────────────────────
const WELLNESS_CHANNEL_ID = process.env.WELLNESS_CHANNEL_ID || LOG_CHANNEL_ID;
const WELLNESS_CHECK_MINUTES = parseFloat(process.env.WELLNESS_CHECK_MINUTES) || 1;
const WELLNESS_POLL_SECONDS = parseFloat(process.env.WELLNESS_POLL_SECONDS) || 15;
const WELLNESS_POLL_MS = WELLNESS_POLL_SECONDS * 1000;
// How long a user has to hit "I'm okay" before it counts as a failed check / strike.
const WELLNESS_RESPONSE_MINUTES = parseFloat(process.env.WELLNESS_RESPONSE_MINUTES) || 1;
const WELLNESS_RESPONSE_MS = WELLNESS_RESPONSE_MINUTES * 1 * 1;

console.log(`Wellness checks: every ${WELLNESS_CHECK_MINUTES} min of active duty, scanned every ${WELLNESS_POLL_SECONDS}s, posting in channel ${WELLNESS_CHANNEL_ID}`);
console.log(`Response window: ${WELLNESS_RESPONSE_MINUTES} min before a missed check counts as a strike`);

process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason));
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); process.exit(1); });

// ── 2. Firebase (Admin SDK — bypasses Firestore security rules) ─
// IMPORTANT: the previous version used the *client* `firebase` package
// on the server. Firestore security rules block unauthenticated
// client-SDK access by default, which is why commands like /shift were
// failing with "Missing or insufficient permissions". firebase-admin
// authenticates with a service account and is meant for server use.
let serviceAccount;
try {
  if (FIREBASE_SERVICE_ACCOUNT_BASE64) {
    // Preferred on env-var-only hosts (Railway, Render, etc.) — base64 has no
    // quotes/newlines/backslashes for the platform's variable editor to mangle.
    const decoded = Buffer.from(FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8');
    serviceAccount = JSON.parse(decoded);
  } else if (FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);
  } else if (FIREBASE_SERVICE_ACCOUNT_PATH) {
    serviceAccount = JSON.parse(readFileSync(FIREBASE_SERVICE_ACCOUNT_PATH, 'utf-8'));
  } else {
    throw new Error('Set FIREBASE_SERVICE_ACCOUNT_BASE64 (recommended on Railway), FIREBASE_SERVICE_ACCOUNT_JSON (stringified JSON), or FIREBASE_SERVICE_ACCOUNT_PATH (path to the key file) in your .env.');
  }
} catch (err) {
  console.error('Firebase service account error:', err.message);
  console.error('   Generate one in Firebase Console -> Project Settings -> Service Accounts -> Generate new private key.');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

// ── 3. Discord Client ────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates, // required for /massmove to read members' voice channels
  ],
});

// ── Brand palette ────────────────────────────────────────────
// Centralized so every embed in the bot shares one consistent, professional
// look instead of a different ad-hoc hex code per command.
const COLORS = {
  primary: 0x2B2D42,   // neutral slate — default/informational
  success: 0x2E7D32,   // muted green — approvals, completions
  warning: 0xB8860B,   // muted gold — warnings, cautions
  danger: 0x8B1E2A,    // muted red — bans, kicks, failures
  info: 0x34495E,      // blue-grey — reference/lookup commands
};

const BRAND_FOOTER = 'PAR Staff Management';

// ── Slash command definitions ─────────────────────────────────
const SLASH_COMMANDS = [
  // ── Moderation ──
  { name: 'warn',      description: 'Warn a user and log it to Firebase',    options: [{ name: 'user', description: 'User to warn', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3, required: true }] },
  { name: 'warnings',  description: 'View all warnings for a user',          options: [{ name: 'user', description: 'User to check', type: 6, required: true }] },
  { name: 'clearwarn', description: 'Delete a specific warning by its ID',   options: [{ name: 'id',   description: 'Warning document ID', type: 3, required: true }] },
  { name: 'modlogs',   description: 'Full moderation history for a user',    options: [{ name: 'user', description: 'User to look up', type: 6, required: true }] },
  { name: 'kick',      description: 'Kick a member from the server',         options: [{ name: 'user', description: 'User to kick', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3, required: false }] },
  { name: 'ban',       description: 'Ban a user and log it to Firebase',     options: [{ name: 'user', description: 'User to ban', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3, required: true }, { name: 'days', description: 'Messages to delete (days, 0-7)', type: 4, required: false, min_value: 0, max_value: 7 }] },
  { name: 'unban',     description: 'Unban a user by their Discord ID',      options: [{ name: 'userid', description: 'Discord user ID', type: 3, required: true }, { name: 'reason', description: 'Reason', type: 3, required: false }] },
  { name: 'timeout',   description: 'Timeout a user for a set duration',     options: [{ name: 'user', description: 'User to timeout', type: 6, required: true }, { name: 'minutes', description: 'Duration in minutes', type: 4, required: true, min_value: 1, max_value: 40320 }, { name: 'reason', description: 'Reason', type: 3, required: false }] },
  { name: 'untimeout', description: 'Remove a timeout from a user',          options: [{ name: 'user', description: 'User to untimeout', type: 6, required: true }] },
  { name: 'purge',     description: 'Bulk-delete messages from this channel', options: [{ name: 'amount', description: 'Number of messages (1-100)', type: 4, required: true, min_value: 1, max_value: 100 }, { name: 'user', description: 'Only delete messages from this user (optional)', type: 6, required: false }] },

  // ── Shift management & wellness ──
  {
    name: 'shift',
    description: 'Manage staff on-duty shifts',
    options: [
      { name: 'manage', description: 'Open your shift management panel (start/pause/end via buttons)', type: 1 },
      {
        name: 'admin',
        description: 'Manage another staff member\'s shift on their behalf',
        type: 1,
        options: [
          { name: 'user', description: 'Staff member to manage', type: 6, required: true },
          {
            name: 'action',
            description: 'Action to take',
            type: 3,
            required: true,
            choices: [
              { name: 'Start',  value: 'start' },
              { name: 'Pause',  value: 'pause' },
              { name: 'Resume', value: 'resume' },
              { name: 'End',    value: 'end' },
            ],
          },
        ],
      },
      { name: 'active', description: 'List everyone currently on shift', type: 1 },
      {
        name: 'leaderboard',
        description: 'Show top staff by total shift time',
        type: 1,
        options: [{
          name: 'period',
          description: 'Time period (default: all time)',
          type: 3,
          required: false,
          choices: [
            { name: 'This Week',  value: 'week' },
            { name: 'This Month', value: 'month' },
            { name: 'All Time',   value: 'all' },
          ],
        }],
      },
      {
        name: 'wipe',
        description: 'Permanently clear recorded shift data (e.g. for a weekly quota reset)',
        type: 1,
        options: [
          {
            name: 'scope',
            description: 'What to wipe',
            type: 3,
            required: true,
            choices: [
              { name: 'Leaderboard history (completed shifts)', value: 'history' },
              { name: 'Everyone\'s live shift status',          value: 'live' },
              { name: 'Both',                                   value: 'all' },
            ],
          },
          { name: 'confirm', description: 'Type CONFIRM to proceed', type: 3, required: true },
        ],
      },
    ],
  },

  // ── Info & lookup ──
  { name: 'ping',       description: 'Check bot latency' },
  { name: 'userinfo',   description: 'Show info about a user',   options: [{ name: 'user', description: 'User to look up', type: 6, required: false }] },
  { name: 'serverinfo', description: 'Show server stats and info' },
  { name: 'roleinfo',   description: 'Show info about a role',   options: [{ name: 'role', description: 'Role to inspect', type: 8, required: true }] },
  { name: 'avatar',     description: 'Show a user\'s full avatar', options: [{ name: 'user', description: 'User to show', type: 6, required: false }] },
  { name: 'stats',      description: 'Show warn totals and who is on shift' },
  { name: 'membercount', description: 'Show the current member count' },
  { name: 'botinfo',    description: 'Show bot version, uptime, and system info' },

  // ── General utility ──
  { name: 'say',      description: 'Make the bot say something in a channel', options: [{ name: 'message', description: 'What to say', type: 3, required: true }, { name: 'channel', description: 'Target channel (default: here)', type: 7, required: false }] },
  { name: 'embed',    description: 'Post a custom embed in this channel', options: [{ name: 'title', description: 'Embed title', type: 3, required: true }, { name: 'description', description: 'Embed body', type: 3, required: true }, { name: 'color', description: 'Hex color e.g. #ff0000', type: 3, required: false }] },
  { name: 'announce', description: 'Send an announcement embed to a channel', options: [{ name: 'channel', description: 'Target channel', type: 7, required: true }, { name: 'message', description: 'Announcement text', type: 3, required: true }] },
  { name: 'poll',     description: 'Post a yes/no or custom poll', options: [{ name: 'question', description: 'Poll question', type: 3, required: true }, { name: 'options', description: 'Comma-separated choices (leave blank for Yes/No)', type: 3, required: false }] },
  { name: 'remind',   description: 'Set a reminder for yourself', options: [{ name: 'minutes', description: 'Minutes from now', type: 4, required: true, min_value: 1, max_value: 10080 }, { name: 'message', description: 'What to remind you about', type: 3, required: true }] },
  { name: 'dm',       description: 'Send a DM to a user as the bot', options: [{ name: 'user', description: 'User to DM', type: 6, required: true }, { name: 'message', description: 'Message to send', type: 3, required: true }] },
  { name: 'slowmode', description: 'Set slowmode on a channel', options: [{ name: 'seconds', description: 'Seconds (0 = off)', type: 4, required: true, min_value: 0, max_value: 21600 }, { name: 'channel', description: 'Target channel (default: here)', type: 7, required: false }] },

  // ── Admin utilities ──
  { name: 'addrole',      description: 'Add a role to a user',              options: [{ name: 'user', description: 'User', type: 6, required: true }, { name: 'role', description: 'Role to add', type: 8, required: true }] },
  { name: 'removerole',   description: 'Remove a role from a user',         options: [{ name: 'user', description: 'User', type: 6, required: true }, { name: 'role', description: 'Role to remove', type: 8, required: true }] },
  { name: 'nickname',     description: "Change a user's nickname",         options: [{ name: 'user', description: 'User', type: 6, required: true }, { name: 'name', description: 'New nickname (omit to reset)', type: 3, required: false }] },
  { name: 'lockdown',     description: 'Lock a channel (deny @everyone Send Messages)', options: [{ name: 'channel', description: 'Target channel (default: here)', type: 7, required: false }] },
  { name: 'unlockdown',   description: 'Unlock a previously locked channel', options: [{ name: 'channel', description: 'Target channel (default: here)', type: 7, required: false }] },
  { name: 'channelcreate', description: 'Create a new text or voice channel', options: [{ name: 'name', description: 'Channel name', type: 3, required: true }, { name: 'type', description: 'Channel type', type: 3, required: true, choices: [{ name: 'Text', value: 'text' }, { name: 'Voice', value: 'voice' }] }, { name: 'category', description: 'Parent category', type: 7, required: false }] },
  { name: 'channeldelete', description: 'Delete a channel',                 options: [{ name: 'channel', description: 'Channel to delete', type: 7, required: true }] },
  { name: 'massmove',     description: 'Move everyone from one voice channel to another', options: [{ name: 'from', description: 'Source voice channel', type: 7, required: true }, { name: 'to', description: 'Destination voice channel', type: 7, required: true }] },
];

client.once('ready', async () => {
  console.log(`Bot ready as ${client.user.tag}`);
  try {
    // Wipe any GLOBAL commands from a previous deploy first. If commands
    // were ever registered globally (client.application.commands.set) in
    // addition to this guild's commands, Discord shows BOTH copies in the
    // command picker — that's what causes entries like "/shift active" or
    // "/shift pause" to appear duplicated. This bot only ever wants
    // guild-scoped commands (they also update instantly, vs. up to an hour
    // for global ones), so we forcibly clear global commands on every boot
    // to guarantee stragglers can't linger or come back.
    await client.application.commands.set([]);
    console.log('Cleared global slash commands (guild commands are authoritative)');

    // Guild-scoped registration updates instantly (global commands can take
    // up to an hour to propagate, which is the usual reason "new" or
    // "changed" commands don't show up right away).
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.commands.set(SLASH_COMMANDS);
    console.log(`${SLASH_COMMANDS.length} slash commands registered to guild ${GUILD_ID}`);
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
  setInterval(runWellnessCheck, WELLNESS_POLL_MS);
  runWellnessCheck(); // run one pass immediately on boot
});

client.login(DISCORD_BOT_TOKEN).catch((err) => {
  console.error('Discord login failed:', err.message);
  process.exit(1);
});

// ── 4. Helpers ────────────────────────────────────────────────

function requireStaff(interaction, perm = PermissionFlagsBits.ManageChannels) {
  return interaction.member.permissions.has(perm);
}

// Send an action to the mod log channel. Pass the interaction's channel ID
// as `skipChannelId` so we don't double-post when staff run a command
// directly in the log channel — otherwise the reply and the log entry are
// the same embed landing in the same channel back to back.
async function sendModLog(guild, embed, skipChannelId = null) {
  const logChannel = guild.channels.cache.get(LOG_CHANNEL_ID);
  if (!logChannel) return;
  if (skipChannelId && logChannel.id === skipChannelId) return;
  await logChannel.send({ embeds: [embed] }).catch(console.error);
}

// ── Interaction dedup lock ──────────────────────────────────────
// Guards against the SAME interaction being handled twice, which happens
// when two bot processes are alive at once (e.g. a local dev instance and
// a deployed one, or an old deploy that hasn't fully shut down) — Discord
// dispatches gateway events to every live connection for the bot token, so
// both processes will otherwise try to answer the same command/button and
// you get duplicate replies like two "Shift Ended" embeds back to back.
// This claims the interaction ID in Firestore; whichever process gets
// there first wins, the other backs off silently.
async function claimInteraction(interaction) {
  try {
    await db.collection('processedInteractions').doc(interaction.id).create({
      handledAt: FieldValue.serverTimestamp(),
    });
    return true;
  } catch (err) {
    // ALREADY_EXISTS (code 6) means another instance already claimed it.
    if (err.code === 6 || err.code === 'already-exists') return false;
    // On any other error (e.g. transient Firestore issue), fail open so a
    // Firestore hiccup doesn't silently eat real commands.
    console.error('claimInteraction error, proceeding anyway:', err);
    return true;
  }
}

// ── Firebase helpers (firebase-admin syntax) ────────────────────

async function addWarning(targetUser, moderator, reason, guildId, extra = {}) {
  const ref = await db.collection('warnings').add({
    userId: targetUser.id,
    username: targetUser.tag,
    moderatorId: moderator.id,
    moderatorTag: moderator.tag,
    reason,
    guildId,
    createdAt: FieldValue.serverTimestamp(),
    ...extra,
  });
  return ref.id;
}

async function getWarnings(userId, guildId) {
  const snap = await db.collection('warnings')
    .where('userId', '==', userId)
    .where('guildId', '==', guildId)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function logModAction(type, targetUser, moderator, reason, extra = {}) {
  await db.collection('modlogs').add({
    type,
    userId: targetUser.id,
    username: targetUser.tag,
    moderatorId: moderator.id,
    moderatorTag: moderator.tag,
    reason: reason || 'No reason given',
    createdAt: FieldValue.serverTimestamp(),
    ...extra,
  });
}

async function getModLogs(userId) {
  // NOTE: this query combines a `where` with an `orderBy` on a different
  // field, which requires a composite index. On first run Firestore will
  // throw an error containing a direct link to auto-create that index —
  // click it once and the query will work from then on.
  const snap = await db.collection('modlogs')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .get();
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

async function getShift(guildId, userId) {
  const snap = await db.collection('shifts').doc(shiftDocId(guildId, userId)).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function createShift(guildId, userId, username) {
  const now = Timestamp.now();
  await db.collection('shifts').doc(shiftDocId(guildId, userId)).set({
    guildId,
    userId,
    username,
    status: 'active',        // 'active' | 'paused' | 'ended'
    startedAt: now,
    activeSince: now,
    lastWellnessCheckAt: now,
    // Wellness check response tracking
    pendingCheckSentAt: null,
    pendingCheckMessageId: null,
    pendingCheckChannelId: null,
    strikes: 0,
    createdAt: now,
    updatedAt: now,
  });
}

async function updateShift(guildId, userId, data) {
  await db.collection('shifts').doc(shiftDocId(guildId, userId)).update(data);
}

async function getActiveGuildShifts(guildId) {
  const snap = await db.collection('shifts')
    .where('guildId', '==', guildId)
    .where('status', 'in', ['active', 'paused'])
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// The `shifts` collection holds one LIVE doc per user, overwritten every
// time they hit Start on the /shift manage panel — so it can't answer "who's
// worked the most total time." Every completed shift gets archived here
// instead, which is what the leaderboard reads from.
async function logCompletedShift(guildId, userId, username, startedAt, endedAt, durationMs) {
  await db.collection('shiftHistory').add({
    guildId,
    userId,
    username,
    startedAt,
    endedAt,
    durationMs,
    createdAt: FieldValue.serverTimestamp(),
  });
}

// Single equality filter only (no range/orderBy) so this never needs a
// Firestore composite index — week/month filtering happens in memory below.
async function getShiftLeaderboard(guildId, period = 'all') {
  const snap = await db.collection('shiftHistory').where('guildId', '==', guildId).get();

  const now = Date.now();
  const cutoffMs = period === 'week' ? now - 7 * 24 * 60 * 60 * 1000
    : period === 'month' ? now - 30 * 24 * 60 * 60 * 1000
    : 0;

  const totals = new Map(); // userId -> { username, totalMs, shiftCount }
  for (const doc of snap.docs) {
    const d = doc.data();
    const endedMs = d.endedAt?.toDate?.().getTime();
    if (!endedMs) continue;
    if (period !== 'all' && endedMs < cutoffMs) continue;

    const entry = totals.get(d.userId) || { username: d.username, totalMs: 0, shiftCount: 0 };
    entry.totalMs += d.durationMs || 0;
    entry.shiftCount += 1;
    entry.username = d.username;
    totals.set(d.userId, entry);
  }

  return [...totals.entries()]
    .map(([userId, v]) => ({ userId, ...v }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

// All-time stats for a single user, used to populate the /shift manage panel.
// Equality-only filters (no orderBy), same pattern as getWarnings — no
// composite index required.
async function getShiftStats(guildId, userId) {
  const snap = await db.collection('shiftHistory')
    .where('guildId', '==', guildId)
    .where('userId', '==', userId)
    .get();

  let shiftCount = 0;
  let totalMs = 0;
  snap.forEach((doc) => {
    const d = doc.data();
    shiftCount += 1;
    totalMs += d.durationMs || 0;
  });

  return { shiftCount, totalMs, avgMs: shiftCount ? totalMs / shiftCount : 0 };
}

// Deletes every document in a Firestore collection matching `guildId`, in
// batches of 400 (comfortably under Firestore's 500-write batch limit).
// Used by /shift wipe to reset either the live-shift board or the
// completed-shift history that the leaderboard is built from.
async function wipeCollectionForGuild(collectionName, guildId) {
  const snap = await db.collection(collectionName).where('guildId', '==', guildId).get();
  let deleted = 0;
  let batch = db.batch();
  let opsInBatch = 0;

  for (const doc of snap.docs) {
    batch.delete(doc.ref);
    opsInBatch += 1;
    deleted += 1;
    if (opsInBatch === 400) {
      await batch.commit();
      batch = db.batch();
      opsInBatch = 0;
    }
  }
  if (opsInBatch > 0) await batch.commit();
  return deleted;
}

// Builds the embed + button row for the /shift manage panel. Buttons are
// disabled based on current status so there's nothing invalid to click:
// Start is only enabled when off-shift, Pause/Resume + End only when on
// shift. Called both when the panel is first opened and again after every
// button press, to refresh the message in place.
async function buildShiftPanel(guildId, userId, user) {
  const [stats, liveShift] = await Promise.all([
    getShiftStats(guildId, userId),
    getShift(guildId, userId),
  ]);

  const now = Date.now();
  let statusLabel = null;
  let statusDot = '\u25CB';
  let lastDurationMs = 0;

  if (liveShift) {
    const startedMs = liveShift.startedAt?.toDate?.().getTime() ?? now;
    if (liveShift.status === 'active') {
      statusLabel = 'Active';
      statusDot = '\u25CF';
      lastDurationMs = now - startedMs;
    } else if (liveShift.status === 'paused') {
      statusLabel = 'Paused';
      statusDot = '\u25D0';
      lastDurationMs = now - startedMs;
    } else {
      statusLabel = 'Ended';
      statusDot = '\u25CB';
      const endedMs = liveShift.endedAt?.toDate?.().getTime() ?? now;
      lastDurationMs = endedMs - startedMs;
    }
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setAuthor({ name: 'Shift Management', iconURL: user.displayAvatarURL() })
    .addFields(
      {
        name: 'All-Time Summary',
        value: `Shift Count: **${stats.shiftCount}**\nTotal Duration: **${formatDuration(stats.totalMs)}**\nAverage Duration: **${formatDuration(stats.avgMs)}**`,
      },
      {
        name: 'Current Shift',
        value: statusLabel
          ? `Status: **${statusDot} ${statusLabel}**\nElapsed: **${formatDuration(lastDurationMs)}**\nType: On Duty`
          : 'No shifts recorded yet.',
      },
    )
    .setFooter({ text: BRAND_FOOTER })
    .setTimestamp();

  const onShift = liveShift?.status === 'active' || liveShift?.status === 'paused';
  const isPaused = liveShift?.status === 'paused';

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`shift_start_${userId}`)
      .setLabel('Start')
      .setStyle(ButtonStyle.Success)
      .setDisabled(onShift),
    new ButtonBuilder()
      .setCustomId(`shift_pauseresume_${userId}`)
      .setLabel(isPaused ? 'Resume' : 'Pause')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!onShift),
    new ButtonBuilder()
      .setCustomId(`shift_end_${userId}`)
      .setLabel('End')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!onShift),
  );

  return { embeds: [embed], components: [row] };
}

// Issue a wellness-check strike — logged into the same `warnings` collection
// so it shows up in /warnings and /modlogs like any other warning.
async function addWellnessStrike(guildId, userId, username, reason) {
  const ref = await db.collection('warnings').add({
    userId,
    username,
    moderatorId: client.user.id,
    moderatorTag: client.user.tag,
    reason,
    guildId,
    type: 'wellness_strike',
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

// ── Wellness check scheduler ────────────────────────────────────

async function sendWellnessCheck(channel, shift, now) {
  const startedMs = shift.startedAt?.toDate?.().getTime() ?? now;

  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('Wellness Check')
    .setDescription(
      `Hi <@${shift.userId}>, you've been on duty for a while — just checking in.\n\n` +
      `You have **${WELLNESS_RESPONSE_MINUTES} minute(s)** to acknowledge this before it counts as a strike.`
    )
    .addFields(
      { name: 'On Shift For', value: formatDuration(now - startedMs), inline: true },
      { name: 'Status',       value: 'On Duty',                       inline: true },
    )
    .setFooter({ text: 'Select the button below to confirm you are okay.' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wellness_ack_${shift.userId}`)
      .setLabel("I'm okay")
      .setStyle(ButtonStyle.Success)
  );

  let sentMsg;
  try {
    sentMsg = await channel.send({ content: `<@${shift.userId}>`, embeds: [embed], components: [row] });
  } catch (err) {
    console.error('Wellness check send failed:', err);
    return;
  }

  await updateShift(shift.guildId, shift.userId, {
    lastWellnessCheckAt: Timestamp.now(),
    pendingCheckSentAt: Timestamp.now(),
    pendingCheckMessageId: sentMsg.id,
    pendingCheckChannelId: channel.id,
    updatedAt: Timestamp.now(),
  });
}

async function handleFailedWellnessCheck(guild, fallbackChannel, shift) {
  const newStrikeCount = (shift.strikes || 0) + 1;

  await updateShift(shift.guildId, shift.userId, {
    pendingCheckSentAt: null,
    pendingCheckMessageId: null,
    pendingCheckChannelId: null,
    strikes: newStrikeCount,
    lastWellnessCheckAt: Timestamp.now(), // restart the clock for the next check
    updatedAt: Timestamp.now(),
  });

  await addWellnessStrike(
    shift.guildId,
    shift.userId,
    shift.username,
    `Failed to acknowledge wellness check within ${WELLNESS_RESPONSE_MINUTES} minutes`
  ).catch((err) => console.error('Failed to log wellness strike:', err));

  // Disable/mark the original check message so it's clear it timed out.
  if (shift.pendingCheckMessageId && shift.pendingCheckChannelId) {
    try {
      const oldChannel = guild.channels.cache.get(shift.pendingCheckChannelId)
        || await guild.channels.fetch(shift.pendingCheckChannelId).catch(() => null);
      const oldMsg = oldChannel && await oldChannel.messages.fetch(shift.pendingCheckMessageId).catch(() => null);
      if (oldMsg && oldMsg.embeds[0]) {
        const failedEmbed = EmbedBuilder.from(oldMsg.embeds[0])
          .setColor(COLORS.danger)
          .setFooter({ text: 'No response received — strike issued' });
        await oldMsg.edit({ embeds: [failedEmbed], components: [] }).catch(() => {});
      }
    } catch { /* best effort */ }
  }

  const failEmbed = new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle('Wellness Check Failed')
    .setDescription(`<@${shift.userId}> did not respond to their wellness check within ${WELLNESS_RESPONSE_MINUTES} minute(s).`)
    .addFields({ name: 'Strike Count', value: `${newStrikeCount}`, inline: true })
    .setFooter({ text: BRAND_FOOTER })
    .setTimestamp();

  await fallbackChannel.send({ embeds: [failEmbed] }).catch((err) => console.error('Failed to post strike notice:', err));
}

async function runWellnessCheck() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild) return;
    const channel = guild.channels.cache.get(WELLNESS_CHANNEL_ID) || await guild.channels.fetch(WELLNESS_CHANNEL_ID).catch(() => null);
    if (!channel) return;

    const snap = await db.collection('shifts')
      .where('guildId', '==', GUILD_ID)
      .where('status', '==', 'active')
      .get();
    if (snap.empty) return;

    const now = Date.now();
    const thresholdMs = WELLNESS_CHECK_MINUTES * 60 * 1000;

    for (const docSnap of snap.docs) {
      const shift = { guildId: GUILD_ID, ...docSnap.data() };

      // ── If a check is already outstanding, see if it timed out ──
      if (shift.pendingCheckSentAt) {
        const sentMs = shift.pendingCheckSentAt?.toDate?.().getTime();
        if (sentMs && now - sentMs >= WELLNESS_RESPONSE_MS) {
          await handleFailedWellnessCheck(guild, channel, shift);
        }
        continue; // don't send a new check while one is (or just was) pending
      }

      // ── Otherwise, see if a new wellness check is due ──
      const checkpointMs = (shift.lastWellnessCheckAt || shift.activeSince || shift.startedAt)?.toDate?.().getTime();
      if (!checkpointMs) continue;
      if (now - checkpointMs < thresholdMs) continue;

      await sendWellnessCheck(channel, shift, now);
    }
  } catch (err) {
    console.error('Wellness check error:', err);
  }
}

// ── 6. Minimal Express server (health check for hosting platforms) ──
const app = express();
app.get('/', (req, res) => res.json({ status: 'ok', bot: client.user?.tag ?? 'starting' }));
app.listen(PORT || 3001, '0.0.0.0', () => console.log(`Health check listening on port ${PORT || 3001}`));

// ── Shared shift-transition logic ───────────────────────────────
// Powers both the /shift manage buttons and /shift admin, so the two paths
// can't drift apart. Returns { ok: true } or { ok: false, message }.
async function applyShiftAction(guildId, targetUserId, targetUsername, action) {
  const shift = await getShift(guildId, targetUserId);

  if (action === 'start') {
    if (shift && shift.status !== 'ended') {
      return { ok: false, message: `Already on shift (status: **${shift.status.toUpperCase()}**).` };
    }
    await createShift(guildId, targetUserId, targetUsername);
    return { ok: true };
  }

  if (action === 'pause' || action === 'resume') {
    if (!shift || shift.status === 'ended') {
      return { ok: false, message: 'Not currently on shift.' };
    }
    if (action === 'pause') {
      if (shift.status === 'paused') return { ok: false, message: 'Shift is already paused.' };
      await updateShift(guildId, targetUserId, { status: 'paused', updatedAt: Timestamp.now() });
    } else {
      if (shift.status === 'active') return { ok: false, message: 'Shift is already active.' };
      const now = Timestamp.now();
      await updateShift(guildId, targetUserId, { status: 'active', activeSince: now, lastWellnessCheckAt: now, updatedAt: now });
    }
    return { ok: true };
  }

  if (action === 'end') {
    if (!shift || shift.status === 'ended') {
      return { ok: false, message: 'Not currently on shift.' };
    }
    const startedMs = shift.startedAt?.toDate?.().getTime() ?? Date.now();
    const endedAtTs = Timestamp.now();
    const durationMs = Date.now() - startedMs;
    await updateShift(guildId, targetUserId, {
      status: 'ended',
      endedAt: endedAtTs,
      pendingCheckSentAt: null,
      pendingCheckMessageId: null,
      pendingCheckChannelId: null,
      updatedAt: Timestamp.now(),
    });
    await logCompletedShift(guildId, targetUserId, targetUsername, shift.startedAt, endedAtTs, durationMs)
      .catch((err) => console.error('Failed to archive completed shift for leaderboard:', err));
    return { ok: true };
  }

  return { ok: false, message: 'Unrecognized action.' };
}

// ── 7. Interaction handler ────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  // Dedup guard — if another live process already claimed this exact
  // interaction, stop here so we never send a duplicate reply.
  const claimed = await claimInteraction(interaction);
  if (!claimed) {
    console.warn(`Duplicate interaction ${interaction.id} ignored — another bot instance already handled it. If you keep seeing this, check for a second running process.`);
    return;
  }

  if (!interaction.isChatInputCommand()) {
    // ── Shift management panel buttons ─────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('shift_')) {
      const [, action, targetUserId] = interaction.customId.split('_');
      if (interaction.user.id !== targetUserId) {
        return interaction.reply({ content: "This isn't your shift panel.", ephemeral: true });
      }

      const guildId = interaction.guild.id;
      try {
        const mapped = action === 'pauseresume' ? null : action; // resolved below
        let result;
        if (action === 'pauseresume') {
          const shift = await getShift(guildId, targetUserId);
          const nextAction = shift?.status === 'active' ? 'pause' : 'resume';
          result = await applyShiftAction(guildId, targetUserId, interaction.user.username, nextAction);
        } else {
          result = await applyShiftAction(guildId, targetUserId, interaction.user.username, action);
        }

        if (!result.ok) {
          return interaction.reply({ content: result.message, ephemeral: true });
        }

        const panel = await buildShiftPanel(guildId, targetUserId, interaction.user);
        await interaction.update(panel);
        return sendModLog(interaction.guild, panel.embeds[0], interaction.channelId);
      } catch (err) {
        console.error('Shift panel button error:', err);
        const errMsg = `Something went wrong: \`${err.message}\``;
        return interaction.reply({ content: errMsg, ephemeral: true }).catch(() => {});
      }
    }

    // ── Wellness check acknowledge button ─────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('wellness_ack_')) {
      const targetId = interaction.customId.replace('wellness_ack_', '');
      if (interaction.user.id !== targetId) {
        return interaction.reply({ content: "This check-in isn't for you.", ephemeral: true });
      }
      const original = interaction.message.embeds[0];
      const embed = EmbedBuilder.from(original)
        .setColor(COLORS.success)
        .setFooter({ text: `Acknowledged by ${interaction.user.tag}` });

      // Clear the pending-check state so the poller stops counting toward a strike.
      try {
        await updateShift(GUILD_ID, targetId, {
          pendingCheckSentAt: null,
          pendingCheckMessageId: null,
          pendingCheckChannelId: null,
          lastWellnessCheckAt: Timestamp.now(),
          updatedAt: Timestamp.now(),
        });
      } catch (err) {
        console.error('Failed to clear pending wellness check on ack:', err);
      }

      return interaction.update({ embeds: [embed], components: [] });
    }
    return;
  }

  const cmd = interaction.commandName;

  // ── /ping ────────────────────────────────────────────────
  if (cmd === 'ping') {
    const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
    return interaction.editReply(`**Pong.**\nBot latency: **${sent.createdTimestamp - interaction.createdTimestamp}ms** · API: **${Math.round(client.ws.ping)}ms**`);
  }

  // ── /botinfo ─────────────────────────────────────────────
  if (cmd === 'botinfo') {
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60), s = Math.floor(uptime % 60);
    const mem = process.memoryUsage();
    const embed = new EmbedBuilder().setColor(COLORS.primary)
      .setTitle(`${client.user.username} — Bot Info`)
      .setThumbnail(client.user.displayAvatarURL())
      .addFields(
        { name: 'Uptime',       value: `${h}h ${m}m ${s}s`,                         inline: true },
        { name: 'API Latency',  value: `${Math.round(client.ws.ping)}ms`,             inline: true },
        { name: 'Memory',       value: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`, inline: true },
        { name: 'Servers',      value: `${client.guilds.cache.size}`,                 inline: true },
        { name: 'Members',      value: `${client.guilds.cache.reduce((a, g) => a + g.memberCount, 0)}`, inline: true },
        { name: 'Commands',     value: `${SLASH_COMMANDS.length}`,                   inline: true },
        { name: 'Node.js',      value: process.version,                              inline: true },
        { name: 'discord.js',   value: 'v14',                                        inline: true },
      )
      .setFooter({ text: BRAND_FOOTER })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /userinfo ────────────────────────────────────────────
  if (cmd === 'userinfo') {
    const target = interaction.options.getUser('user') || interaction.user;
    let member;
    try { member = await interaction.guild.members.fetch(target.id); } catch { /**/ }
    const warns = await getWarnings(target.id, interaction.guild.id);
    const embed = new EmbedBuilder().setColor(COLORS.info)
      .setTitle(target.username)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: 'Tag',              value: target.tag,                                                                  inline: true },
        { name: 'ID',               value: target.id,                                                                   inline: true },
        { name: 'Bot',              value: target.bot ? 'Yes' : 'No',                                                  inline: true },
        { name: 'Account Created',  value: `<t:${Math.floor(target.createdTimestamp / 1000)}:R>`,                    inline: true },
        { name: 'Joined Server',    value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'N/A',   inline: true },
        { name: 'Warnings',         value: `${warns.length}`,                                                          inline: true },
        { name: 'Roles',            value: member ? (member.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => `<@&${r.id}>`).join(', ') || 'None') : 'N/A' },
      )
      .setFooter({ text: BRAND_FOOTER })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /serverinfo ──────────────────────────────────────────
  if (cmd === 'serverinfo') {
    const g = interaction.guild;
    await g.fetch();
    const embed = new EmbedBuilder().setColor(COLORS.primary)
      .setTitle(g.name)
      .setThumbnail(g.iconURL({ size: 256 }))
      .addFields(
        { name: 'Owner',        value: `<@${g.ownerId}>`,                                                  inline: true },
        { name: 'ID',           value: g.id,                                                               inline: true },
        { name: 'Created',      value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`,                  inline: true },
        { name: 'Members',      value: `${g.memberCount}`,                                                inline: true },
        { name: 'Channels',     value: `${g.channels.cache.size}`,                                        inline: true },
        { name: 'Roles',        value: `${g.roles.cache.size}`,                                           inline: true },
        { name: 'Boost Level',  value: `Level ${g.premiumTier} (${g.premiumSubscriptionCount} boosts)`,  inline: true },
        { name: 'Verification', value: ['None','Low','Medium','High','Very High'][g.verificationLevel],  inline: true },
      )
      .setFooter({ text: BRAND_FOOTER })
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  // ── /roleinfo ────────────────────────────────────────────
  if (cmd === 'roleinfo') {
    const role = interaction.options.getRole('role');
    const perms = role.permissions.toArray().slice(0, 10).map(p => `\`${p}\``).join(', ') || 'None';
    const embed = new EmbedBuilder().setColor(role.color || COLORS.primary)
      .setTitle(role.name)
      .addFields(
        { name: 'ID',              value: role.id,                                                       inline: true },
        { name: 'Color',           value: role.hexColor,                                                 inline: true },
        { name: 'Position',        value: `${role.position}`,                                           inline: true },
        { name: 'Members',         value: `${role.members.size}`,                                       inline: true },
        { name: 'Mentionable',     value: role.mentionable ? 'Yes' : 'No',                            inline: true },
        { name: 'Hoisted',         value: role.hoist ? 'Yes' : 'No',                                   inline: true },
        { name: 'Created',         value: `<t:${Math.floor(role.createdTimestamp / 1000)}:R>`,          inline: true },
        { name: 'Key Permissions', value: perms },
      )
      .setFooter({ text: BRAND_FOOTER })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /avatar ──────────────────────────────────────────────
  if (cmd === 'avatar') {
    const target = interaction.options.getUser('user') || interaction.user;
    const url = target.displayAvatarURL({ size: 1024, extension: 'png' });
    const embed = new EmbedBuilder().setColor(COLORS.primary)
      .setTitle(`${target.username} — Avatar`)
      .setImage(url)
      .setDescription(`[Open full size](${url})`)
      .setFooter({ text: BRAND_FOOTER });
    return interaction.reply({ embeds: [embed] });
  }

  // ── /membercount ─────────────────────────────────────────
  if (cmd === 'membercount') {
    return interaction.reply(`**${interaction.guild.name}** has **${interaction.guild.memberCount}** members.`);
  }

  // ── /stats ───────────────────────────────────────────────
  if (cmd === 'stats') {
    if (!requireStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const warnSnap = await db.collection('warnings').get();
    const activeShifts = await getActiveGuildShifts(interaction.guild.id);
    const embed = new EmbedBuilder().setColor(COLORS.primary)
      .setTitle('PAR Bot Stats')
      .addFields(
        { name: 'Total Warnings',  value: `${warnSnap.size}`, inline: true },
        { name: 'Staff On Shift',  value: `${activeShifts.length}`, inline: true },
        { name: 'Server Members',  value: `${interaction.guild.memberCount}`, inline: true },
        { name: 'Commands',        value: `${SLASH_COMMANDS.length}`, inline: true },
        { name: 'API Latency',     value: `${Math.round(client.ws.ping)}ms`, inline: true },
      )
      .setFooter({ text: BRAND_FOOTER })
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  // ── /warn ────────────────────────────────────────────────
  if (cmd === 'warn') {
    if (!requireStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason');
    await interaction.deferReply();
    const warnId = await addWarning(target, interaction.user, reason, interaction.guild.id);
    const allWarns = await getWarnings(target.id, interaction.guild.id);

    const embed = new EmbedBuilder().setColor(COLORS.warning)
      .setTitle('Warning Issued')
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        { name: 'User',       value: `<@${target.id}> (${target.tag})`, inline: true },
        { name: 'Issued By',  value: `<@${interaction.user.id}>`,       inline: true },
        { name: 'Total Warns', value: `${allWarns.length}`,             inline: true },
        { name: 'Reason',     value: reason },
        { name: 'Warning ID', value: `\`${warnId}\`` },
      )
      .setFooter({ text: BRAND_FOOTER })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    await sendModLog(interaction.guild, embed, interaction.channelId);

    try {
      const dmEmbed = new EmbedBuilder().setColor(COLORS.warning)
        .setTitle(`You have been warned in ${interaction.guild.name}`)
        .addFields({ name: 'Reason', value: reason }, { name: 'Total Warnings', value: `${allWarns.length}` })
        .setTimestamp();
      await target.send({ embeds: [dmEmbed] });
    } catch { /**/ }
  }

  // ── /warnings ────────────────────────────────────────────
  if (cmd === 'warnings') {
    if (!requireStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    const target = interaction.options.getUser('user');
    await interaction.deferReply({ ephemeral: true });
    const warns = await getWarnings(target.id, interaction.guild.id);
    if (warns.length === 0) return interaction.editReply(`**${target.tag}** has no warnings.`);

    const fields = warns.slice(0, 10).map((w, i) => {
      const ts = w.createdAt?.toDate ? Math.floor(w.createdAt.toDate().getTime() / 1000) : 0;
      const tag = w.type === 'wellness_strike' ? ' (wellness)' : '';
      return { name: `#${i + 1}${tag} — ID: \`${w.id}\``, value: `Reason: ${w.reason}\nBy: ${w.moderatorTag}\nWhen: ${ts ? `<t:${ts}:R>` : 'Unknown'}` };
    });

    const embed = new EmbedBuilder().setColor(COLORS.warning)
      .setTitle(`Warnings — ${target.tag}`)
      .setDescription(`Total: **${warns.length}**`)
      .addFields(fields)
      .setFooter({ text: warns.length > 10 ? `Showing 10 of ${warns.length} · ${BRAND_FOOTER}` : BRAND_FOOTER })
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  // ── /clearwarn ───────────────────────────────────────────
  if (cmd === 'clearwarn') {
    if (!requireStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    const warnId = interaction.options.getString('id');
    await interaction.deferReply({ ephemeral: true });
    try {
      const ref = db.collection('warnings').doc(warnId);
      const snap = await ref.get();
      if (!snap.exists) return interaction.editReply('Warning ID not found.');
      await ref.delete();
      return interaction.editReply(`Warning \`${warnId}\` deleted.`);
    } catch (err) {
      console.error('/clearwarn:', err);
      return interaction.editReply('Failed to delete warning.');
    }
  }

  // ── /modlogs ─────────────────────────────────────────────
  if (cmd === 'modlogs') {
    if (!requireStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    const target = interaction.options.getUser('user');
    await interaction.deferReply({ ephemeral: true });
    const [logs, warns] = await Promise.all([getModLogs(target.id), getWarnings(target.id, interaction.guild.id)]);
    if (logs.length === 0 && warns.length === 0) return interaction.editReply(`**${target.tag}** has a clean record.`);

    const logFields = logs.slice(0, 8).map((l) => {
      const ts = l.createdAt?.toDate ? Math.floor(l.createdAt.toDate().getTime() / 1000) : 0;
      return { name: `${l.type.toUpperCase()} ${ts ? `— <t:${ts}:R>` : ''}`, value: `Reason: ${l.reason}\nBy: ${l.moderatorTag}` };
    });

    const embed = new EmbedBuilder().setColor(COLORS.danger)
      .setTitle(`Moderation History — ${target.tag}`)
      .setThumbnail(target.displayAvatarURL())
      .setDescription(`**${warns.length}** warning(s) · **${logs.length}** action(s)`)
      .addFields(logFields.length ? logFields : [{ name: 'Actions', value: 'None on record' }])
      .setFooter({ text: BRAND_FOOTER })
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  // ── /kick ────────────────────────────────────────────────
  if (cmd === 'kick') {
    if (!requireStaff(interaction, PermissionFlagsBits.KickMembers))
      return interaction.reply({ content: 'You need the Kick Members permission.', ephemeral: true });
    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason given';
    await interaction.deferReply();
    try {
      const member = await interaction.guild.members.fetch(target.id);
      await member.kick(reason);
      await logModAction('kick', target, interaction.user, reason);
      const embed = new EmbedBuilder().setColor(COLORS.danger)
        .setTitle('Member Kicked')
        .addFields(
          { name: 'User',   value: `${target.tag}`, inline: true },
          { name: 'By',     value: interaction.user.tag, inline: true },
          { name: 'Reason', value: reason },
        )
        .setFooter({ text: BRAND_FOOTER })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      await sendModLog(interaction.guild, embed, interaction.channelId);
      try { await target.send(`You have been kicked from **${interaction.guild.name}**.\nReason: ${reason}`); } catch { /**/ }
    } catch (err) {
      console.error('/kick:', err);
      return interaction.editReply('Failed to kick. Check my permissions and role position.');
    }
  }

  // ── /ban ─────────────────────────────────────────────────
  if (cmd === 'ban') {
    if (!requireStaff(interaction, PermissionFlagsBits.BanMembers))
      return interaction.reply({ content: 'You need the Ban Members permission.', ephemeral: true });
    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason');
    const days = interaction.options.getInteger('days') ?? 0;
    await interaction.deferReply();
    try {
      try { await target.send(`You have been banned from **${interaction.guild.name}**.\nReason: ${reason}`); } catch { /**/ }
      await interaction.guild.members.ban(target.id, { reason, deleteMessageDays: days });
      await logModAction('ban', target, interaction.user, reason, { deleteMessageDays: days });
      const embed = new EmbedBuilder().setColor(COLORS.danger)
        .setTitle('Member Banned')
        .addFields(
          { name: 'User',           value: `${target.tag} (${target.id})`, inline: true },
          { name: 'By',             value: interaction.user.tag,           inline: true },
          { name: 'Messages Deleted', value: `${days} day(s)`,              inline: true },
          { name: 'Reason',         value: reason },
        )
        .setFooter({ text: BRAND_FOOTER })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      await sendModLog(interaction.guild, embed, interaction.channelId);
    } catch (err) {
      console.error('/ban:', err);
      return interaction.editReply('Failed to ban. Check my permissions and role position.');
    }
  }

  // ── /unban ───────────────────────────────────────────────
  if (cmd === 'unban') {
    if (!requireStaff(interaction, PermissionFlagsBits.BanMembers))
      return interaction.reply({ content: 'You need the Ban Members permission.', ephemeral: true });
    const userId = interaction.options.getString('userid');
    const reason = interaction.options.getString('reason') || 'No reason given';
    await interaction.deferReply();
    try {
      const ban = await interaction.guild.bans.fetch(userId);
      await interaction.guild.members.unban(userId, reason);
      await logModAction('unban', { id: userId, tag: ban.user.tag }, interaction.user, reason);
      const embed = new EmbedBuilder().setColor(COLORS.success)
        .setTitle('Member Unbanned')
        .addFields(
          { name: 'User',   value: `${ban.user.tag} (${userId})`, inline: true },
          { name: 'By',     value: interaction.user.tag,          inline: true },
          { name: 'Reason', value: reason },
        )
        .setFooter({ text: BRAND_FOOTER })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      await sendModLog(interaction.guild, embed, interaction.channelId);
    } catch (err) {
      console.error('/unban:', err);
      return interaction.editReply('Could not find that ban or failed to unban.');
    }
  }

  // ── /timeout ─────────────────────────────────────────────
  if (cmd === 'timeout') {
    if (!requireStaff(interaction, PermissionFlagsBits.ModerateMembers))
      return interaction.reply({ content: 'You need the Moderate Members permission.', ephemeral: true });
    const target = interaction.options.getUser('user');
    const minutes = interaction.options.getInteger('minutes');
    const reason = interaction.options.getString('reason') || 'No reason given';
    await interaction.deferReply();
    try {
      const member = await interaction.guild.members.fetch(target.id);
      await member.timeout(minutes * 60 * 1000, reason);
      await logModAction('timeout', target, interaction.user, reason, { durationMinutes: minutes });
      const embed = new EmbedBuilder().setColor(COLORS.warning)
        .setTitle('Member Timed Out')
        .addFields(
          { name: 'User',     value: `${target.tag}`,     inline: true },
          { name: 'Duration', value: `${minutes} min(s)`, inline: true },
          { name: 'By',       value: interaction.user.tag, inline: true },
          { name: 'Reason',   value: reason },
        )
        .setFooter({ text: BRAND_FOOTER })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      await sendModLog(interaction.guild, embed, interaction.channelId);
      try { await target.send(`You have been timed out in **${interaction.guild.name}** for ${minutes} minute(s).\nReason: ${reason}`); } catch { /**/ }
    } catch (err) {
      console.error('/timeout:', err);
      return interaction.editReply('Failed to timeout. Check permissions.');
    }
  }

  // ── /untimeout ───────────────────────────────────────────
  if (cmd === 'untimeout') {
    if (!requireStaff(interaction, PermissionFlagsBits.ModerateMembers))
      return interaction.reply({ content: 'You need the Moderate Members permission.', ephemeral: true });
    const target = interaction.options.getUser('user');
    await interaction.deferReply();
    try {
      const member = await interaction.guild.members.fetch(target.id);
      await member.timeout(null);
      const embed = new EmbedBuilder().setColor(COLORS.success)
        .setTitle('Timeout Removed')
        .addFields({ name: 'User', value: `${target.tag}`, inline: true }, { name: 'By', value: interaction.user.tag, inline: true })
        .setFooter({ text: BRAND_FOOTER })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      await sendModLog(interaction.guild, embed, interaction.channelId);
    } catch (err) {
      console.error('/untimeout:', err);
      return interaction.editReply('Failed to remove timeout.');
    }
  }

  // ── /purge ───────────────────────────────────────────────
  if (cmd === 'purge') {
    if (!requireStaff(interaction, PermissionFlagsBits.ManageMessages))
      return interaction.reply({ content: 'You need the Manage Messages permission.', ephemeral: true });
    const amount = interaction.options.getInteger('amount');
    const filterUser = interaction.options.getUser('user');
    await interaction.deferReply({ ephemeral: true });
    try {
      let messages = await interaction.channel.messages.fetch({ limit: 100 });
      if (filterUser) messages = messages.filter(m => m.author.id === filterUser.id);
      const toDelete = [...messages.values()].slice(0, amount);
      const deleted = await interaction.channel.bulkDelete(toDelete, true);
      return interaction.editReply(`Deleted **${deleted.size}** message(s)${filterUser ? ` from ${filterUser.tag}` : ''}.`);
    } catch (err) {
      console.error('/purge:', err);
      return interaction.editReply('Failed to delete messages. Messages older than 14 days cannot be bulk-deleted.');
    }
  }

  // ── /shift ───────────────────────────────────────────────
  if (cmd === 'shift') {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;

    try {
      if (sub === 'manage') {
        await interaction.deferReply();
        const panel = await buildShiftPanel(guildId, userId, interaction.user);
        return interaction.editReply(panel);
      }

      if (sub === 'admin') {
        if (!requireStaff(interaction, PermissionFlagsBits.ManageChannels))
          return interaction.reply({ content: 'You need staff permissions to manage another member\'s shift.', ephemeral: true });

        const target = interaction.options.getUser('user');
        const action = interaction.options.getString('action');
        await interaction.deferReply();

        const result = await applyShiftAction(guildId, target.id, target.username, action);
        if (!result.ok) return interaction.editReply(result.message);

        const embed = new EmbedBuilder().setColor(COLORS.primary)
          .setTitle('Shift Updated by Staff')
          .addFields(
            { name: 'Staff Member', value: `<@${target.id}>`, inline: true },
            { name: 'Action',       value: action.charAt(0).toUpperCase() + action.slice(1), inline: true },
            { name: 'Updated By',   value: `<@${interaction.user.id}>`, inline: true },
          )
          .setFooter({ text: BRAND_FOOTER })
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        return sendModLog(interaction.guild, embed, interaction.channelId);
      }

      if (sub === 'active') {
        await interaction.deferReply();
        const shifts = await getActiveGuildShifts(guildId);
        if (shifts.length === 0) return interaction.editReply('No one is currently on shift.');

        const now = Date.now();
        const lines = shifts
          .sort((a, b) => (a.startedAt?.toDate?.().getTime() ?? 0) - (b.startedAt?.toDate?.().getTime() ?? 0))
          .map((s, i) => {
            const started = s.startedAt?.toDate?.().getTime() ?? now;
            const strikeTag = s.strikes ? ` — ${s.strikes} strike(s)` : '';
            return `${i + 1}. <@${s.userId}> — ${formatDuration(now - started)} (${s.status.toUpperCase()})${strikeTag}`;
          });

        const embed = new EmbedBuilder().setColor(COLORS.primary)
          .setTitle('Active Shifts')
          .setDescription(lines.join('\n'))
          .setFooter({ text: BRAND_FOOTER })
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      }

      if (sub === 'leaderboard') {
        await interaction.deferReply();
        const period = interaction.options.getString('period') || 'all';
        const board = await getShiftLeaderboard(guildId, period);
        if (board.length === 0) return interaction.editReply('No completed shifts recorded yet for that period.');

        const lines = board.slice(0, 10).map((entry, i) => {
          return `**${i + 1}.** <@${entry.userId}> — **${formatDuration(entry.totalMs)}** (${entry.shiftCount} shift${entry.shiftCount === 1 ? '' : 's'})`;
        });

        const periodLabel = period === 'week' ? 'This Week' : period === 'month' ? 'This Month' : 'All Time';
        const embed = new EmbedBuilder().setColor(COLORS.primary)
          .setTitle(`Shift Leaderboard — ${periodLabel}`)
          .setDescription(lines.join('\n'))
          .setFooter({ text: `Showing top ${Math.min(board.length, 10)} of ${board.length} · ${BRAND_FOOTER}` })
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      }

      if (sub === 'wipe') {
        if (!requireStaff(interaction, PermissionFlagsBits.Administrator))
          return interaction.reply({ content: 'Administrators only — this permanently deletes shift data.', ephemeral: true });

        const scope = interaction.options.getString('scope');
        const confirm = interaction.options.getString('confirm');
        if (confirm !== 'CONFIRM') {
          return interaction.reply({ content: 'Not confirmed. Re-run the command with `confirm` set to exactly `CONFIRM` to proceed.', ephemeral: true });
        }

        await interaction.deferReply();
        let historyDeleted = 0;
        let liveDeleted = 0;

        if (scope === 'history' || scope === 'all') {
          historyDeleted = await wipeCollectionForGuild('shiftHistory', guildId);
        }
        if (scope === 'live' || scope === 'all') {
          liveDeleted = await wipeCollectionForGuild('shifts', guildId);
        }

        const scopeLabel = scope === 'history' ? 'Leaderboard history' : scope === 'live' ? 'Live shift status' : 'Leaderboard history and live shift status';
        const embed = new EmbedBuilder().setColor(COLORS.danger)
          .setTitle('Shift Data Wiped')
          .setDescription(`${scopeLabel} for this server has been permanently cleared.`)
          .addFields(
            { name: 'Completed Shifts Removed', value: `${historyDeleted}`, inline: true },
            { name: 'Live Shifts Removed',      value: `${liveDeleted}`,    inline: true },
            { name: 'Performed By',             value: `<@${interaction.user.id}>`, inline: true },
          )
          .setFooter({ text: BRAND_FOOTER })
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        return sendModLog(interaction.guild, embed, interaction.channelId);
      }
    } catch (err) {
      console.error('/shift error:', err);
      const errMsg = `Something went wrong running \`/shift ${sub}\`: \`${err.message}\``;
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply(errMsg).catch(() => {});
      }
      return interaction.reply({ content: errMsg, ephemeral: true }).catch(() => {});
    }
  }

  // ── /say ─────────────────────────────────────────────────
  if (cmd === 'say') {
    if (!requireStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    const message = interaction.options.getString('message');
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    try {
      await channel.send(message);
      return interaction.reply({ content: `Message sent to ${channel}.`, ephemeral: true });
    } catch (err) {
      return interaction.reply({ content: 'Could not send message to that channel.', ephemeral: true });
    }
  }

  // ── /embed ───────────────────────────────────────────────
  if (cmd === 'embed') {
    if (!requireStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description');
    const color = interaction.options.getString('color') || '#2B2D42';
    const validColor = /^#[0-9A-Fa-f]{6}$/.test(color) ? color : '#2B2D42';
    const embed = new EmbedBuilder().setColor(validColor).setTitle(title).setDescription(description).setTimestamp();
    await interaction.channel.send({ embeds: [embed] });
    return interaction.reply({ content: 'Embed posted.', ephemeral: true });
  }

  // ── /announce ────────────────────────────────────────────
  if (cmd === 'announce') {
    if (!requireStaff(interaction, PermissionFlagsBits.Administrator))
      return interaction.reply({ content: 'Administrators only.', ephemeral: true });
    const targetChannel = interaction.options.getChannel('channel');
    const message = interaction.options.getString('message');
    const embed = new EmbedBuilder().setColor(COLORS.primary)
      .setTitle('Announcement')
      .setDescription(message)
      .setFooter({ text: `Posted by ${interaction.user.tag}` })
      .setTimestamp();
    try {
      await targetChannel.send({ content: '@everyone', embeds: [embed] });
      return interaction.reply({ content: `Announcement sent to ${targetChannel}.`, ephemeral: true });
    } catch {
      return interaction.reply({ content: 'Could not post to that channel.', ephemeral: true });
    }
  }

  // ── /poll ────────────────────────────────────────────────
  if (cmd === 'poll') {
    const question = interaction.options.getString('question');
    const optionsRaw = interaction.options.getString('options');
    const embed = new EmbedBuilder().setColor(COLORS.primary)
      .setTitle('Poll')
      .setDescription(`**${question}**`)
      .setFooter({ text: `Poll by ${interaction.user.tag}` })
      .setTimestamp();

    if (!optionsRaw) {
      embed.addFields({ name: 'Options', value: 'Yes\nNo' });
      const msg = await interaction.channel.send({ embeds: [embed] });
      await msg.react('✅');
      await msg.react('❌');
    } else {
      const opts = optionsRaw.split(',').map(o => o.trim()).slice(0, 9);
      const emojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];
      embed.addFields({ name: 'Options', value: opts.map((o, i) => `${i + 1}. ${o}`).join('\n') });
      const msg = await interaction.channel.send({ embeds: [embed] });
      for (let i = 0; i < opts.length; i++) await msg.react(emojis[i]);
    }
    return interaction.reply({ content: 'Poll posted.', ephemeral: true });
  }

  // ── /remind ──────────────────────────────────────────────
  if (cmd === 'remind') {
    const minutes = interaction.options.getInteger('minutes');
    const message = interaction.options.getString('message');
    await interaction.reply({ content: `Got it — I'll remind you in **${minutes} minute(s)**: "${message}"`, ephemeral: true });
    setTimeout(async () => {
      try {
        await interaction.user.send(`Reminder from ${interaction.guild.name}:\n${message}`);
      } catch {
        try { await interaction.channel.send(`<@${interaction.user.id}> Reminder: ${message}`); } catch { /**/ }
      }
    }, minutes * 60 * 1000);
  }

  // ── /dm ──────────────────────────────────────────────────
  if (cmd === 'dm') {
    if (!requireStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    const target = interaction.options.getUser('user');
    const message = interaction.options.getString('message');
    try {
      await target.send(`Message from ${interaction.guild.name} Staff:\n${message}`);
      await interaction.reply({ content: `DM sent to **${target.tag}**.`, ephemeral: true });
      await sendModLog(interaction.guild, new EmbedBuilder().setColor(COLORS.primary)
        .setTitle('DM Sent via Bot')
        .addFields({ name: 'To', value: `${target.tag}`, inline: true }, { name: 'By', value: interaction.user.tag, inline: true }, { name: 'Message', value: message })
        .setFooter({ text: BRAND_FOOTER })
        .setTimestamp());
    } catch {
      return interaction.reply({ content: 'Could not DM that user (DMs may be closed).', ephemeral: true });
    }
  }

  // ── /slowmode ────────────────────────────────────────────
  if (cmd === 'slowmode') {
    if (!requireStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    const secs = interaction.options.getInteger('seconds');
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    try {
      await channel.setRateLimitPerUser(secs);
      return interaction.reply({ content: secs === 0 ? `Slowmode disabled in ${channel}.` : `Slowmode set to **${secs}s** in ${channel}.` });
    } catch { return interaction.reply({ content: 'Failed.', ephemeral: true }); }
  }

  // ── /addrole ─────────────────────────────────────────────
  if (cmd === 'addrole') {
    if (!requireStaff(interaction, PermissionFlagsBits.ManageRoles))
      return interaction.reply({ content: 'You need the Manage Roles permission.', ephemeral: true });
    const target = interaction.options.getUser('user');
    const role = interaction.options.getRole('role');
    try {
      const member = await interaction.guild.members.fetch(target.id);
      await member.roles.add(role);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(COLORS.success).setDescription(`Added ${role} to <@${target.id}>.`)] });
    } catch (err) {
      console.error('/addrole:', err);
      return interaction.reply({ content: 'Failed to add role. Check my role position and permissions.', ephemeral: true });
    }
  }

  // ── /removerole ──────────────────────────────────────────
  if (cmd === 'removerole') {
    if (!requireStaff(interaction, PermissionFlagsBits.ManageRoles))
      return interaction.reply({ content: 'You need the Manage Roles permission.', ephemeral: true });
    const target = interaction.options.getUser('user');
    const role = interaction.options.getRole('role');
    try {
      const member = await interaction.guild.members.fetch(target.id);
      await member.roles.remove(role);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(COLORS.danger).setDescription(`Removed ${role} from <@${target.id}>.`)] });
    } catch (err) {
      console.error('/removerole:', err);
      return interaction.reply({ content: 'Failed to remove role. Check my role position and permissions.', ephemeral: true });
    }
  }

  // ── /nickname ────────────────────────────────────────────
  if (cmd === 'nickname') {
    if (!requireStaff(interaction, PermissionFlagsBits.ManageNicknames))
      return interaction.reply({ content: 'You need the Manage Nicknames permission.', ephemeral: true });
    const target = interaction.options.getUser('user');
    const name = interaction.options.getString('name') || null;
    try {
      const member = await interaction.guild.members.fetch(target.id);
      await member.setNickname(name);
      return interaction.reply(name ? `Set <@${target.id}>'s nickname to **${name}**.` : `Reset <@${target.id}>'s nickname.`);
    } catch (err) {
      console.error('/nickname:', err);
      return interaction.reply({ content: 'Failed to change nickname. Check my role position.', ephemeral: true });
    }
  }

  // ── /lockdown & /unlockdown ──────────────────────────────
  if (cmd === 'lockdown' || cmd === 'unlockdown') {
    if (!requireStaff(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const locking = cmd === 'lockdown';
    try {
      await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: !locking });
      return interaction.reply({ embeds: [new EmbedBuilder()
        .setColor(locking ? COLORS.danger : COLORS.success)
        .setDescription(`${locking ? 'Locked' : 'Unlocked'} ${channel} by <@${interaction.user.id}>.`)] });
    } catch (err) {
      console.error(`/${cmd}:`, err);
      return interaction.reply({ content: 'Failed. Check my permissions in that channel.', ephemeral: true });
    }
  }

  // ── /channelcreate ───────────────────────────────────────
  if (cmd === 'channelcreate') {
    if (!requireStaff(interaction, PermissionFlagsBits.Administrator))
      return interaction.reply({ content: 'Administrators only.', ephemeral: true });
    const name = interaction.options.getString('name');
    const type = interaction.options.getString('type');
    const category = interaction.options.getChannel('category');
    try {
      const channel = await interaction.guild.channels.create({
        name,
        type: type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
        parent: category?.id,
      });
      return interaction.reply(`Created ${channel}.`);
    } catch (err) {
      console.error('/channelcreate:', err);
      return interaction.reply({ content: 'Failed to create channel.', ephemeral: true });
    }
  }

  // ── /channeldelete ───────────────────────────────────────
  if (cmd === 'channeldelete') {
    if (!requireStaff(interaction, PermissionFlagsBits.Administrator))
      return interaction.reply({ content: 'Administrators only.', ephemeral: true });
    const channel = interaction.options.getChannel('channel');
    try {
      const name = channel.name;
      await channel.delete();
      return interaction.reply(`Deleted #${name}.`);
    } catch (err) {
      console.error('/channeldelete:', err);
      return interaction.reply({ content: 'Failed to delete channel.', ephemeral: true });
    }
  }

  // ── /massmove ────────────────────────────────────────────
  if (cmd === 'massmove') {
    if (!requireStaff(interaction, PermissionFlagsBits.MoveMembers))
      return interaction.reply({ content: 'You need the Move Members permission.', ephemeral: true });
    const from = interaction.options.getChannel('from');
    const to = interaction.options.getChannel('to');
    if (from.type !== ChannelType.GuildVoice || to.type !== ChannelType.GuildVoice)
      return interaction.reply({ content: 'Both channels must be voice channels.', ephemeral: true });
    await interaction.deferReply();
    try {
      const members = [...from.members.values()];
      await Promise.all(members.map((m) => m.voice.setChannel(to).catch(() => {})));
      return interaction.editReply(`Moved **${members.length}** member(s) from ${from} to ${to}.`);
    } catch (err) {
      console.error('/massmove:', err);
      return interaction.editReply('Failed to move members.');
    }
  }

});

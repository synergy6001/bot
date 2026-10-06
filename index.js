// index.js - Discord invite tracker (single file).
// discord.js v14, better-sqlite3, slash commands only, no message content intent.
require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  escapeMarkdown,
  Events,
  GatewayIntentBits,
  FileUploadBuilder,
  InteractionContextType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  Options,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

// ===========================================================================
// 1. CONFIG
// ===========================================================================
const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
const OWNER_ID = (process.env.OWNER_ID || '').trim();

if (!DISCORD_TOKEN || !OWNER_ID) {
  console.error('Missing DISCORD_TOKEN or OWNER_ID in your environment/.env file.');
  process.exit(1);
}

const COLOR = 0x0056cd; // one consistent embed color
const ERROR_COLOR = 0xed4245; // red, used for error embeds
const SUCCESS_COLOR = 0x57f287; // green, used for the claim successful embed
const REVIEW_COLOR = 0xfee75c; // gold, used for posted reviews
const NO_MENTIONS = { parse: [] }; // nothing the bot sends can ping anyone
const DELETED_TTL_MS = 15_000;
// TESTING: the Claim button's step 1 never shows more than this many invites, and the automatic invite
// message stops being sent once an inviter's real total goes above it. Tracking is unaffected and the
// commands show the real number. Set to Infinity to remove.
const TEST_DISPLAY_INVITE_CAP = 2;
const NOTICE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// ===========================================================================
// 2. DATABASE (SQLite). Tables are created automatically.
//    joins.source  : 'invite' | 'vanity' | 'unknown'
//    joins.counted : 1 while the join counts toward inviter_stats; set to 0 when
//                    the inviter's stats are reset so old leaves can't go negative.
// ===========================================================================
const dbPath = path.resolve(process.env.DB_PATH || './data/bot.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -2000'); // ~2 MB page cache keeps memory low

db.exec(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id       TEXT PRIMARY KEY,
    channel_id     TEXT,
    log_channel_id TEXT
  );
  CREATE TABLE IF NOT EXISTS joins (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT NOT NULL,
    member_id   TEXT NOT NULL,
    inviter_id  TEXT,
    invite_code TEXT,
    source      TEXT NOT NULL DEFAULT 'unknown',
    joined_at   INTEGER NOT NULL,
    left_at     INTEGER,
    counted     INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_joins_member  ON joins (guild_id, member_id, id);
  CREATE INDEX IF NOT EXISTS idx_joins_inviter ON joins (guild_id, inviter_id);
  CREATE TABLE IF NOT EXISTS inviter_stats (
    guild_id   TEXT NOT NULL,
    inviter_id TEXT NOT NULL,
    joins      INTEGER NOT NULL DEFAULT 0,
    leaves     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, inviter_id)
  );
`);

// Databases created before claim logging existed don't have the column yet.
if (!db.prepare('PRAGMA table_info(guild_settings)').all().some((c) => c.name === 'log_channel_id')) {
  db.exec('ALTER TABLE guild_settings ADD COLUMN log_channel_id TEXT');
}

const q = {
  getChannel: db.prepare('SELECT channel_id, log_channel_id FROM guild_settings WHERE guild_id = ?'),
  setChannel: db.prepare(`
    INSERT INTO guild_settings (guild_id, channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id`),
  setLogChannel: db.prepare(`
    INSERT INTO guild_settings (guild_id, log_channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET log_channel_id = excluded.log_channel_id`),
  clearChannel: db.prepare(
    'UPDATE guild_settings SET channel_id = NULL WHERE guild_id = ? AND channel_id IS NOT NULL'),
  clearLogChannel: db.prepare(
    'UPDATE guild_settings SET log_channel_id = NULL WHERE guild_id = ? AND log_channel_id IS NOT NULL'),
  activeJoin: db.prepare(`
    SELECT * FROM joins WHERE guild_id = ? AND member_id = ? AND left_at IS NULL
    ORDER BY id DESC LIMIT 1`),
  latestJoin: db.prepare(`
    SELECT * FROM joins WHERE guild_id = ? AND member_id = ?
    ORDER BY id DESC LIMIT 1`),
  insertJoin: db.prepare(`
    INSERT INTO joins (guild_id, member_id, inviter_id, invite_code, source, joined_at)
    VALUES (@guildId, @memberId, @inviterId, @inviteCode, @source, @joinedAt)`),
  markLeft: db.prepare('UPDATE joins SET left_at = ? WHERE id = ?'),
  addJoinStat: db.prepare(`
    INSERT INTO inviter_stats (guild_id, inviter_id, joins, leaves) VALUES (?, ?, 1, 0)
    ON CONFLICT(guild_id, inviter_id) DO UPDATE SET joins = joins + 1`),
  addLeaveStat: db.prepare(
    'UPDATE inviter_stats SET leaves = MIN(leaves + 1, joins) WHERE guild_id = ? AND inviter_id = ?'),
  addJoinsBy: db.prepare(`
    INSERT INTO inviter_stats (guild_id, inviter_id, joins, leaves) VALUES (?, ?, ?, 0)
    ON CONFLICT(guild_id, inviter_id) DO UPDATE SET joins = joins + excluded.joins`),
  addLeavesBy: db.prepare(
    'UPDATE inviter_stats SET leaves = leaves + ? WHERE guild_id = ? AND inviter_id = ?'),
  stats: db.prepare('SELECT joins, leaves FROM inviter_stats WHERE guild_id = ? AND inviter_id = ?'),
  leaderboard: db.prepare(`
    SELECT inviter_id, joins, leaves, (joins - leaves) AS current
    FROM inviter_stats WHERE guild_id = ? AND joins > 0
    ORDER BY current DESC, joins DESC LIMIT ?`),
  deleteStats: db.prepare('DELETE FROM inviter_stats WHERE guild_id = ? AND inviter_id = ?'),
  uncountJoins: db.prepare('UPDATE joins SET counted = 0 WHERE guild_id = ? AND inviter_id = ?'),
};

function getChannelId(guildId) {
  return q.getChannel.get(guildId)?.channel_id ?? null;
}

function setChannelId(guildId, channelId) {
  q.setChannel.run(guildId, channelId);
}

/** Returns true if a tracking channel was actually removed. */
function clearChannelId(guildId) {
  return q.clearChannel.run(guildId).changes > 0;
}

function getLogChannelId(guildId) {
  return q.getChannel.get(guildId)?.log_channel_id ?? null;
}

function setLogChannelId(guildId, channelId) {
  q.setLogChannel.run(guildId, channelId);
}

/** Returns true if a log channel was actually removed. */
function clearLogChannelId(guildId) {
  return q.clearLogChannel.run(guildId).changes > 0;
}

/** Closes a join record and counts a leave for its inviter (if it was counted). */
function closeJoin(record, leftAt) {
  q.markLeft.run(leftAt, record.id);
  if (record.inviter_id && record.counted) {
    q.addLeaveStat.run(record.guild_id, record.inviter_id);
  }
}

/**
 * Records a new join. If the member still has an "active" record (their leave was
 * missed, e.g. the bot was offline), it is closed first so the earlier join is
 * never double counted.
 */
const recordJoin = db.transaction(({ guildId, memberId, inviterId, inviteCode, source, joinedAt }) => {
  const stale = q.activeJoin.get(guildId, memberId);
  if (stale) closeJoin(stale, joinedAt);

  q.insertJoin.run({
    guildId,
    memberId,
    inviterId: inviterId ?? null,
    inviteCode: inviteCode ?? null,
    source,
    joinedAt,
  });
  if (inviterId) q.addJoinStat.run(guildId, inviterId);
});

/** Marks the member's active join as left. */
const recordLeave = db.transaction((guildId, memberId) => {
  const active = q.activeJoin.get(guildId, memberId);
  if (active) closeJoin(active, Date.now());
});

function getLatestJoin(guildId, memberId) {
  return q.latestJoin.get(guildId, memberId) ?? null;
}

function getStats(guildId, inviterId) {
  const row = q.stats.get(guildId, inviterId);
  const joins = row?.joins ?? 0;
  const leaves = row?.leaves ?? 0;
  return { joins, leaves, current: joins - leaves };
}

function getLeaderboard(guildId, limit = 10) {
  return q.leaderboard.all(guildId, limit).map((r) => ({
    inviterId: r.inviter_id,
    joins: r.joins,
    leaves: r.leaves,
    current: r.current,
  }));
}

/** Resets stats. Old join records stay (for /user) but stop counting. */
const resetStats = db.transaction((guildId, inviterId) => {
  q.deleteStats.run(guildId, inviterId);
  q.uncountJoins.run(guildId, inviterId);
});

/**
 * Adds (positive delta) or removes (negative delta) invites by hand. Additions count as joins,
 * removals as leaves, and removing never takes the total below 0.
 * Returns how many invites were actually added or removed.
 */
const adjustInvites = db.transaction((guildId, inviterId, delta) => {
  if (delta > 0) {
    q.addJoinsBy.run(guildId, inviterId, delta);
    return delta;
  }
  const take = Math.min(-delta, getStats(guildId, inviterId).current);
  if (take > 0) q.addLeavesBy.run(take, guildId, inviterId);
  return take;
});

// ===========================================================================
// 3. HELPERS (embeds, replies, formatting)
// ===========================================================================
function embed(title, description) {
  const e = new EmbedBuilder().setColor(COLOR);
  if (title) e.setTitle(title);
  if (description) e.setDescription(description);
  return e;
}

const fullDate = (ms) => `<t:${Math.floor(ms / 1000)}:F>`;
const relativeDate = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;

/** Replies (or follows up). Never throws, so a failed reply can't crash the bot. */
async function safeReply(interaction, payload) {
  const options = { allowedMentions: NO_MENTIONS, ...payload };
  try {
    if (interaction.deferred || interaction.replied) return await interaction.followUp(options);
    return await interaction.reply(options);
  } catch (err) {
    console.error('Failed to reply to interaction:', err);
    return null;
  }
}

function send(interaction, embeds, { ephemeral = false } = {}) {
  const payload = { embeds: Array.isArray(embeds) ? embeds : [embeds] };
  if (ephemeral) payload.flags = MessageFlags.Ephemeral;
  return safeReply(interaction, payload);
}

function describeInviter(record) {
  if (record.source === 'vanity') return 'Vanity URL';
  if (record.inviter_id) return `<@${record.inviter_id}>`;
  return 'Unknown';
}

// ===========================================================================
// 4. INVITE TRACKER (cache + join detection)
// ===========================================================================
const inviteCache = new Map(); // guildId -> Map(code -> { uses, maxUses, inviterId })
const vanityUses = new Map(); // guildId -> last known vanity use count
const recentlyDeleted = new Map(); // guildId -> Map(code -> { entry, at })
const lastPermissionNotice = new Map(); // guildId -> timestamp
const queues = new Map(); // guildId -> promise chain (keeps joins in order)

function toEntry(invite) {
  return {
    uses: invite.uses ?? 0,
    maxUses: invite.maxUses ?? 0,
    inviterId: invite.inviterId ?? invite.inviter?.id ?? null,
  };
}

function toCache(invites) {
  const map = new Map();
  for (const invite of invites.values()) map.set(invite.code, toEntry(invite));
  return map;
}

/** True if one more use exhausts this invite (Discord then deletes it). */
function isLastUse(entry) {
  return entry.maxUses > 0 && entry.uses + 1 >= entry.maxUses;
}

function canReadInvites(guild) {
  return Boolean(guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild));
}

/** Runs tasks for one guild strictly in arrival order. */
function enqueue(guildId, task) {
  const previous = queues.get(guildId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  queues.set(guildId, next);
  next
    .finally(() => {
      if (queues.get(guildId) === next) queues.delete(guildId);
    })
    .catch(() => {});
  return next;
}

async function getTrackingChannel(guild) {
  const channelId = getChannelId(guild.id);
  if (!channelId) return null;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

async function getLogChannel(guild) {
  const channelId = getLogChannelId(guild.id);
  if (!channelId) return null;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

/** Tells the owner the bot can't read invites (tracking channel, else console). */
async function reportMissingPermission(guild) {
  const last = lastPermissionNotice.get(guild.id) ?? 0;
  if (Date.now() - last < NOTICE_COOLDOWN_MS) return;
  lastPermissionNotice.set(guild.id, Date.now());

  const text =
    'I need the **Manage Server** permission to read invites. ' +
    'Until it is granted, new joins will be recorded as "Unknown".';

  try {
    const channel = await getTrackingChannel(guild);
    if (channel) {
      await channel.send({
        embeds: [embed('Missing permission', `<@${OWNER_ID}> ${text}`)],
        allowedMentions: NO_MENTIONS,
      });
      return;
    }
  } catch (err) {
    console.warn(`[${guild.name}] Could not post permission notice:`, err.message);
  }
  console.warn(`[${guild.name}] ${text.replace(/\*\*/g, '')}`);
}

/** Fetches and caches all invites (and vanity uses) for a guild. */
async function cacheGuildInvites(guild) {
  if (!canReadInvites(guild)) {
    inviteCache.delete(guild.id);
    await reportMissingPermission(guild);
    return;
  }

  try {
    inviteCache.set(guild.id, toCache(await guild.invites.fetch()));
  } catch (err) {
    inviteCache.delete(guild.id);
    console.warn(`[${guild.name}] Could not fetch invites:`, err.message);
    return;
  }

  if (guild.features.includes('VANITY_URL')) {
    try {
      vanityUses.set(guild.id, (await guild.fetchVanityData()).uses);
    } catch {
      // Vanity data is optional.
    }
  }
}

function dropGuild(guildId) {
  inviteCache.delete(guildId);
  vanityUses.delete(guildId);
  recentlyDeleted.delete(guildId);
  lastPermissionNotice.delete(guildId);
}

function addInvite(invite) {
  const cache = invite.guild && inviteCache.get(invite.guild.id);
  if (cache) cache.set(invite.code, toEntry(invite));
}

function removeInvite(invite) {
  const guildId = invite.guild?.id;
  const cache = guildId && inviteCache.get(guildId);
  const entry = cache?.get(invite.code);
  if (!entry) return;

  cache.delete(invite.code);

  // Remember briefly: a max-use invite can be deleted before the member-add event.
  const stash = recentlyDeleted.get(guildId) ?? new Map();
  const now = Date.now();
  for (const [code, item] of stash) {
    if (now - item.at > DELETED_TTL_MS) stash.delete(code);
  }
  stash.set(invite.code, { entry, at: now });
  recentlyDeleted.set(guildId, stash);
}

/** Works out how a member joined. Always refreshes the cache. */
async function detectInvite(guild) {
  const unknown = { source: 'unknown', inviterId: null, code: null };

  if (!canReadInvites(guild)) {
    await reportMissingPermission(guild);
    return unknown;
  }

  let current;
  try {
    current = await guild.invites.fetch();
  } catch (err) {
    console.warn(`[${guild.name}] Could not fetch invites on join:`, err.message);
    return unknown;
  }

  const next = toCache(current);
  const previous = inviteCache.get(guild.id);
  inviteCache.set(guild.id, next);
  if (!previous) return unknown; // nothing to compare against yet

  // 1) An invite whose use count went up.
  for (const [code, entry] of next) {
    if (entry.uses > (previous.get(code)?.uses ?? 0)) {
      return { source: 'invite', inviterId: entry.inviterId, code };
    }
  }

  // 2) An invite that vanished because its final use was just consumed.
  const stash = recentlyDeleted.get(guild.id) ?? new Map();
  const missing = [];
  for (const [code, entry] of previous) {
    if (!next.has(code)) missing.push([code, entry]);
  }
  for (const [code, item] of stash) {
    if (Date.now() - item.at <= DELETED_TTL_MS && !next.has(code)) missing.push([code, item.entry]);
  }
  const consumed = missing.find(([, entry]) => isLastUse(entry));
  if (consumed) {
    stash.delete(consumed[0]);
    return { source: 'invite', inviterId: consumed[1].inviterId, code: consumed[0] };
  }

  // 3) The vanity URL.
  if (guild.features.includes('VANITY_URL')) {
    try {
      const vanity = await guild.fetchVanityData();
      const before = vanityUses.get(guild.id);
      vanityUses.set(guild.id, vanity.uses);
      if (before !== undefined && vanity.uses > before) {
        return { source: 'vanity', inviterId: null, code: vanity.code ?? guild.vanityURLCode ?? null };
      }
    } catch {
      // Fall through to unknown.
    }
  }

  return unknown;
}

/** A person's display name (server nickname > global display name > username), markdown-escaped. */
async function nameOf(guild, userId) {
  const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
  const user = member?.user ?? (await guild.client.users.fetch(userId).catch(() => null));
  const name = member?.displayName ?? user?.globalName ?? user?.username ?? 'Unknown';
  return escapeMarkdown(name);
}

/** The invite announcement. Shared by real joins and /test. Names only, no pings. */
function inviteText(inviterName, inviteeName, count) {
  return `${inviterName} invited ${inviteeName} to the server.\nThey now have **${count}** ${count === 1 ? 'invite' : 'invites'}! ⭐`;
}

async function sendJoinMessage(member, detected) {
  const channel = await getTrackingChannel(member.guild);
  if (!channel) return;

  const inviteeName = escapeMarkdown(member.displayName);
  let text;
  if (detected.source === 'vanity') {
    text = `${inviteeName} joined via the vanity URL.`;
  } else if (detected.inviterId) {
    // Tracking already happened in handleJoin; past the cap we just don't announce it.
    const count = getStats(member.guild.id, detected.inviterId).current;
    if (count > TEST_DISPLAY_INVITE_CAP) return;
    text = inviteText(await nameOf(member.guild, detected.inviterId), inviteeName, count);
  } else {
    text = `${inviteeName} joined (inviter unknown).`;
  }

  try {
    await channel.send({ embeds: [embed(null, text)], allowedMentions: NO_MENTIONS });
  } catch (err) {
    console.warn(`[${member.guild.name}] Could not send join message:`, err.message);
  }
}

function handleJoin(member) {
  return enqueue(member.guild.id, async () => {
    const detected = await detectInvite(member.guild);
    recordJoin({
      guildId: member.guild.id,
      memberId: member.id,
      inviterId: detected.inviterId,
      inviteCode: detected.code,
      source: detected.source,
      joinedAt: Date.now(),
    });
    await sendJoinMessage(member, detected);
  });
}

function handleLeave(member) {
  return enqueue(member.guild.id, async () => recordLeave(member.guild.id, member.id));
}

// ===========================================================================
// 5. SLASH COMMANDS
// ===========================================================================
// ---- Rewards: public Claim button + reward menu (usable by everyone) ----
const CLAIM_BUTTON_ID = 'rewards:claim';
const CLAIM_SELECT_ID = 'rewards:select';
const REVIEWS_URL = 'https://discord.com/channels/1379048382684987463/1381262550347415593';

const REWARDS = [
  { id: 'pass', name: 'Brawl Pass', invites: 3, emoji: { id: '1556695553025515560', name: 'pass' } },
  { id: 'passplus', name: 'Brawl Pass Plus', invites: 6, emoji: { id: '1500797805353107648', name: 'passplus' } },
  { id: 'propass', name: 'Pro Pass', invites: 9, emoji: { id: '1500798443961061476', name: 'propass' } },
];

const ARROW_ICON = 'https://cdn.discordapp.com/emojis/1556702446104088646.png';
const emojiText = (e) => `<:${e.name}:${e.id}>`;

const TAG_BUTTON_PREFIX = 'rewards:tag:'; // + reward id
const TAG_MODAL_PREFIX = 'rewards:modal:'; // + reward id
const TAG_INPUT_ID = 'rewards:tag-input';
const REVIEWS_CHANNEL_ID = REVIEWS_URL.split('/').pop(); // reviews are posted in the channel REVIEWS_URL points to
const REVIEW_BUTTON_PREFIX = 'rewards:review:'; // + reward id
const REVIEW_MODAL_PREFIX = 'rewards:reviewmodal:'; // + reward id
const REVIEW_RATING_ID = 'rewards:review-rating';
const REVIEW_TEXT_ID = 'rewards:review-text';
const REVIEW_IMAGE_ID = 'rewards:review-image';
const REVIEW_PFP_ID = 'rewards:review-pfp';
const REVIEW_NAME_ID = 'rewards:review-name';
const TEST_TAG_PREFIX = '8080#'; // TESTING: "8080#PLAYERTAG" shows the success message (the 8080 is stripped)
const TUTORIAL_URL = 'https://discord.com/channels/1379048382684987463/1379755843485958194';

const stepFooter = (n) => ({ text: `Step ${n}/3` });

/** Text progress bar with one symbol per required invite, e.g. 2/6 -> ▰▰▱▱▱▱. */
function progressBar(current, total) {
  const filled = Math.min(Math.max(0, Math.floor(current)), total);
  return '▰'.repeat(filled) + '▱'.repeat(total - filled);
}

/** Step 1/3: the private claim menu. The user's current invite total is shown at the top. */
function claimPayload(guildId, userId) {
  const current = Math.min(getStats(guildId, userId).current, TEST_DISPLAY_INVITE_CAP);
  const top = `You currently have **${current}** ${current === 1 ? 'invite' : 'invites'}.`;

  const menu = new StringSelectMenuBuilder()
    .setCustomId(CLAIM_SELECT_ID)
    .setPlaceholder('Select a reward')
    .addOptions(
      REWARDS.map((r) => ({
        label: r.name,
        description: `Price: ${r.invites} invites`,
        value: r.id,
        emoji: r.emoji,
      })),
    );

  return {
    embeds: [
      embed('📥 Claim a reward', `${top}\n\nSelect the reward you want to claim below.`).setFooter(stepFooter(1)),
    ],
    components: [new ActionRowBuilder().addComponents(menu)],
    allowedMentions: NO_MENTIONS,
  };
}

/** Step 2/3: ask for the player tag. Typing happens in a popup form (no message content intent needed). */
function tagPayload(reward) {
  const e = embed(
    `Selected: ${emojiText(reward.emoji)} ${reward.name}`,
    'Press the button below and enter your Brawl Stars **player tag**, this is where your reward will be sent.\n\n' +
      '**Example:**',
  ).setFooter(stepFooter(2));

  const files = [];
  const examplePath = path.resolve(__dirname, 'playertag.png');
  if (fs.existsSync(examplePath)) {
    files.push(new AttachmentBuilder(examplePath, { name: 'playertag.png' }));
    e.setImage('attachment://playertag.png');
  } else {
    console.warn(`playertag.png not found at ${examplePath}; showing step 2 without the example image.`);
  }

  const button = new ButtonBuilder()
    .setCustomId(`${TAG_BUTTON_PREFIX}${reward.id}`)
    .setLabel('Enter player tag')
    .setEmoji('✏️')
    .setStyle(ButtonStyle.Secondary);

  return {
    embeds: [e],
    files,
    components: [new ActionRowBuilder().addComponents(button)],
    allowedMentions: NO_MENTIONS,
  };
}

/**
 * Step 3/3: for now always the "not enough invites" view (testing). The bar never reaches
 * the goal: with enough invites it shows one below it (e.g. 8/9 instead of 10/9).
 */
function resultPayload(reward, have) {
  have = Math.min(have, reward.invites - 1);

  const missing = reward.invites - have;
  const e = embed(
    '❌ Not enough invites',
    `You don't have enough invites to claim ${emojiText(reward.emoji)} **${reward.name}**.\n\n` +
      `**${have}/${reward.invites}** invites\n${progressBar(have, reward.invites)}\n\n` +
      `You need **${missing} more** ${missing === 1 ? 'invite' : 'invites'}.`,
  ).setFooter(stepFooter(3));

  const tutorial = new ButtonBuilder().setLabel('Tutorial').setEmoji('❓').setStyle(ButtonStyle.Link).setURL(TUTORIAL_URL);

  return {
    embeds: [e],
    components: [new ActionRowBuilder().addComponents(tutorial)],
    allowedMentions: NO_MENTIONS,
  };
}

/** Step 3/3: TESTING success message (shown when the player tag is 8080). Nothing is deducted. */
function successPayload(reward, tag) {
  const e = embed(
    '✅ Claim successful!',
    `You claimed ${emojiText(reward.emoji)} **${reward.name}**.\n\n` +
      `**Player tag:** \`${tag}\`\n` +
      `**Invites spent:** ${reward.invites}\n\n` +
      'You should receive your reward in-game within ~10 minutes.\n\n' +
      '📸 Once you receive it, take a screenshot of the item and leave a review using the button below.',
  )
    .setColor(SUCCESS_COLOR)
    .setFooter(stepFooter(3));

  const review = new ButtonBuilder()
    .setCustomId(`${REVIEW_BUTTON_PREFIX}${reward.id}:${tag}`) // the tag rides along for the review
    .setLabel('Submit Review')
    .setEmoji('⭐')
    .setStyle(ButtonStyle.Secondary);

  return { embeds: [e], components: [new ActionRowBuilder().addComponents(review)], allowedMentions: NO_MENTIONS };
}

/**
 * Accepts English letters and numbers in any case, with or without a leading "#"
 * ("#20FJGIV9R3", "fj3igorb"). Returns it as "#UPPERCASE", or null if it contains spaces,
 * emojis, symbols or non-English letters. The check runs before uppercasing so characters
 * like "ß" can't turn into plain letters.
 */
function normalizeTag(raw) {
  const text = raw.trim();
  if (!/^#?[A-Za-z0-9]{3,15}$/.test(text)) return null;
  return `#${text.replace(/^#/, '').toUpperCase()}`;
}

/** Posts one log embed per claim attempt (success or failure). Never throws. */
async function logClaimAttempt(interaction, { reward, tag, have, success }) {
  try {
    const channel = await getLogChannel(interaction.guild);
    if (!channel) return;

    const avatar = interaction.user.displayAvatarURL();
    const log = embed(
      success ? '✅ Claim succeeded' : '❌ Claim failed',
      success
        ? 'The member had enough invites.'
        : `The member didn't have enough invites (${reward.invites - have} short).`,
    )
      .setAuthor({ name: interaction.user.username, iconURL: avatar })
      .setThumbnail(avatar)
      .addFields(
        { name: 'User', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Reward', value: `${emojiText(reward.emoji)} ${reward.name}`, inline: true },
        { name: 'Invites', value: `${have}/${reward.invites}`, inline: true },
        { name: 'Player tag', value: `\`${tag}\``, inline: true },
      )
      .setTimestamp();

    await channel.send({ embeds: [log], allowedMentions: NO_MENTIONS });
  } catch (err) {
    console.warn(`[${interaction.guild?.name}] Could not send claim log:`, err.message);
  }
}

async function handleClaimButton(interaction) {
  await interaction.reply({
    ...claimPayload(interaction.guildId, interaction.user.id),
    flags: MessageFlags.Ephemeral,
  });
}

// Step 1 -> 2
async function handleClaimSelect(interaction) {
  const reward = REWARDS.find((r) => r.id === interaction.values[0]);
  if (!reward) {
    await interaction.deferUpdate();
    return;
  }
  await interaction.update({ ...tagPayload(reward), attachments: [] });
}

// Step 2: the button opens the player tag popup.
async function handleTagButton(interaction) {
  const reward = REWARDS.find((r) => r.id === interaction.customId.slice(TAG_BUTTON_PREFIX.length));
  if (!reward) {
    await interaction.deferUpdate();
    return;
  }

  const input = new TextInputBuilder()
    .setCustomId(TAG_INPUT_ID)
    .setLabel('Your Brawl Stars player tag')
    .setPlaceholder('Enter player tag (e.g: #ABCD1234)')
    .setStyle(TextInputStyle.Short)
    .setMinLength(3)
    .setMaxLength(20) // room for the 8080 testing prefix
    .setRequired(true);

  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`${TAG_MODAL_PREFIX}${reward.id}`)
      .setTitle('Player tag')
      .addComponents(new ActionRowBuilder().addComponents(input)),
  );
}

// Step 2 -> 3
async function handleTagModal(interaction) {
  const reward = REWARDS.find((r) => r.id === interaction.customId.slice(TAG_MODAL_PREFIX.length));
  if (!reward || !interaction.isFromMessage()) {
    await safeReply(interaction, {
      embeds: [embed(null, 'Something went wrong. Press Claim and try again.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // TESTING: "8080#PLAYERTAG" triggers the fake success; the prefix is removed before the tag is used.
  const rawTag = interaction.fields.getTextInputValue(TAG_INPUT_ID).trim();
  const isTest = rawTag.startsWith(TEST_TAG_PREFIX);
  const tag = normalizeTag(isTest ? rawTag.slice(TEST_TAG_PREFIX.length - 1) : rawTag);
  if (!tag) {
    // A separate red message; the step 2 embed stays untouched so they can press the button again.
    await safeReply(interaction, {
      embeds: [
        embed(
          'Invalid player tag',
          "That doesn't look like a valid player tag. Use only English letters and numbers, " +
            'with no spaces or emojis, then press **Enter player tag** to try again.',
        ).setColor(ERROR_COLOR),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // TESTING: a fake successful claim, no invites are actually spent and nothing is logged.
  if (isTest) {
    await interaction.update({ ...successPayload(reward, tag), attachments: [] });
    return;
  }

  const have = Math.max(0, getStats(interaction.guildId, interaction.user.id).current);
  const success = have >= reward.invites;

  // TODO: once claiming exists, pass `tag` along to the staff request.
  await interaction.update({ ...resultPayload(reward, have), attachments: [] });
  await logClaimAttempt(interaction, { reward, tag, have, success });
}

// ---- Reviews: "Submit Review" button -> popup (rating, description, screenshot) -> posted in the reviews channel ----
async function handleReviewButton(interaction) {
  const [rewardId, tag] = interaction.customId.slice(REVIEW_BUTTON_PREFIX.length).split(':');
  const reward = REWARDS.find((r) => r.id === rewardId);
  if (!reward || !tag) {
    await interaction.deferUpdate();
    return;
  }

  const rating = new StringSelectMenuBuilder()
    .setCustomId(REVIEW_RATING_ID)
    .setPlaceholder('Select a rating')
    .addOptions(
      [5, 4, 3, 2, 1].map((n) => ({
        label: `${n} ${n === 1 ? 'star' : 'stars'}`,
        description: '⭐'.repeat(n),
        value: String(n),
      })),
    );

  const text = new TextInputBuilder()
    .setCustomId(REVIEW_TEXT_ID)
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Tell us about your experience')
    .setMinLength(10)
    .setMaxLength(1000)
    .setRequired(true);

  const image = new FileUploadBuilder().setCustomId(REVIEW_IMAGE_ID).setMinValues(1).setMaxValues(1).setRequired(true);
  const pfp = new FileUploadBuilder().setCustomId(REVIEW_PFP_ID).setMinValues(1).setMaxValues(1).setRequired(true);

  const name = new TextInputBuilder()
    .setCustomId(REVIEW_NAME_ID)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Your Brawl Stars name')
    .setMinLength(1)
    .setMaxLength(30)
    .setRequired(true);

  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`${REVIEW_MODAL_PREFIX}${reward.id}:${tag}`)
      .setTitle('Submit a review')
      .addLabelComponents(
        new LabelBuilder().setLabel('Rating').setStringSelectMenuComponent(rating),
        new LabelBuilder().setLabel('Review').setTextInputComponent(text),
        new LabelBuilder()
          .setLabel('Screenshot')
          .setDescription('A screenshot of the item you received')
          .setFileUploadComponent(image),
        new LabelBuilder()
          .setLabel('Profile Picture')
          .setDescription('Your Brawl Stars profile picture, shown on your review')
          .setFileUploadComponent(pfp),
        new LabelBuilder().setLabel('Player Name').setTextInputComponent(name),
      ),
  );
}

async function handleReviewModal(interaction) {
  const [rewardId, tag] = interaction.customId.slice(REVIEW_MODAL_PREFIX.length).split(':');
  const reward = REWARDS.find((r) => r.id === rewardId);
  if (!reward || !tag || !interaction.isFromMessage()) {
    await safeReply(interaction, {
      embeds: [embed(null, 'Something went wrong. Press Claim and try again.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const rating = Number(interaction.fields.getStringSelectValues(REVIEW_RATING_ID)[0]);
  const text = interaction.fields.getTextInputValue(REVIEW_TEXT_ID).trim();
  const playerName = interaction.fields.getTextInputValue(REVIEW_NAME_ID).trim();
  const file = interaction.fields.getUploadedFiles(REVIEW_IMAGE_ID, true).first();
  const pfpFile = interaction.fields.getUploadedFiles(REVIEW_PFP_ID, true).first();

  const fail = (message) =>
    safeReply(interaction, {
      embeds: [embed('Review not posted', message).setColor(ERROR_COLOR)],
      flags: MessageFlags.Ephemeral,
    });

  if (!(rating >= 1 && rating <= 5)) return fail('Please pick a rating from 1 to 5 stars, then try again.');
  if (!playerName) return fail('Please enter your player name, then try again.');
  if (!file?.contentType?.startsWith('image/') || !pfpFile?.contentType?.startsWith('image/')) {
    return fail('The screenshot and profile picture must be images (PNG, JPG, etc). Press **Submit Review** to try again.');
  }

  // Posting involves downloading and re-uploading the image, which can take over 3 seconds.
  await interaction.deferUpdate();

  const channel = await interaction.guild.channels.fetch(REVIEWS_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) return fail("Couldn't find the reviews channel. Please tell a staff member.");

  const fileName = `review${path.extname(file.name || '') || '.png'}`;
  const pfpName = `pfp${path.extname(pfpFile.name || '') || '.png'}`;
  // The player's own name, tag and profile picture are used; the Discord account is never shown or pinged.
  const review = embed(`${'⭐'.repeat(rating)}  ${rating}/5`, text)
    .setColor(REVIEW_COLOR)
    .setAuthor({ name: `${playerName} left a new review!`, iconURL: `attachment://${pfpName}` })
    .setThumbnail(`attachment://${pfpName}`)
    .addFields(
      { name: 'Reward', value: `${emojiText(reward.emoji)} ${reward.name}`, inline: true },
      { name: 'Reviewer', value: `${escapeMarkdown(playerName)} [${tag}]`, inline: true },
    )
    .setImage(`attachment://${fileName}`)
    .setTimestamp();

  let posted;
  try {
    // Re-uploaded so the image stays up (Discord's modal attachment links expire).
    posted = await channel.send({
      embeds: [review],
      files: [
        new AttachmentBuilder(file.url, { name: fileName }),
        new AttachmentBuilder(pfpFile.url, { name: pfpName }),
      ],
      allowedMentions: NO_MENTIONS,
    });
  } catch (err) {
    console.warn(`[${interaction.guild?.name}] Could not post review:`, err.message);
    return fail(`Couldn't post your review: ${err.message}`);
  }

  // Replace step 3 with a thank-you so the same claim can't be reviewed twice.
  const view = new ButtonBuilder().setLabel('View your review').setEmoji('⭐').setStyle(ButtonStyle.Link).setURL(posted.url);
  await interaction.editReply({
    embeds: [embed('Thank you for your review!', 'Your review has been posted.').setColor(SUCCESS_COLOR)],
    components: [new ActionRowBuilder().addComponents(view)],
    attachments: [],
  });
}

// ---- /user panel: member info plus owner-only Add / Remove / Reset buttons ----
const USER_PREFIX = 'user:'; // customIds look like user:<action>:<userId>
const USER_AMOUNT_ID = 'user:amount';

/** Builds the /user embed + buttons. `notice` is an optional line shown under the mention. */
async function userPanelPayload(guild, userId, notice) {
  const user = await guild.client.users.fetch(userId);
  const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
  const stats = getStats(guild.id, userId);
  const record = getLatestJoin(guild.id, userId);
  const avatar = user.displayAvatarURL();
  const displayName = member?.displayName ?? user.globalName ?? user.username;

  const joinedAt = member?.joinedTimestamp ?? record?.joined_at ?? null;
  let status = 'Not in the server';
  if (member) status = 'In the server';
  else if (record?.left_at) status = `Left ${fullDate(record.left_at)}`;

  const e = embed(null, `<@${userId}>${notice ? `\n\n${notice}` : ''}`)
    .setAuthor({ name: user.username, iconURL: avatar })
    .setThumbnail(avatar)
    .addFields(
      { name: 'Username', value: escapeMarkdown(user.username), inline: true },
      { name: 'Display name', value: escapeMarkdown(displayName), inline: true },
      { name: 'User ID', value: `\`${user.id}\``, inline: true },
      { name: 'Current invites', value: String(stats.current), inline: true },
      { name: 'Total joins', value: String(stats.joins), inline: true },
      { name: 'Leaves', value: String(stats.leaves), inline: true },
      { name: 'Account created', value: `${fullDate(user.createdTimestamp)} (${relativeDate(user.createdTimestamp)})` },
      {
        name: 'Joined server',
        value: joinedAt ? `${fullDate(joinedAt)} (${relativeDate(joinedAt)})` : 'Unknown',
      },
      { name: 'Status', value: status },
    );

  if (record) {
    e.addFields(
      { name: 'Invited by', value: describeInviter(record), inline: true },
      { name: 'Invite code', value: record.invite_code ? `\`${record.invite_code}\`` : 'N/A', inline: true },
    );
  } else {
    e.addFields({
      name: 'Invited by',
      value: 'No join record. They may have joined before the bot started tracking.',
    });
  }

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${USER_PREFIX}add:${userId}`).setLabel('Add').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${USER_PREFIX}remove:${userId}`).setLabel('Remove').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${USER_PREFIX}reset:${userId}`).setLabel('Reset').setStyle(ButtonStyle.Danger),
  );

  return { embeds: [e], components: [buttons], allowedMentions: NO_MENTIONS };
}

const errorReply = (text) => ({
  embeds: [embed(null, text).setColor(ERROR_COLOR)],
  flags: MessageFlags.Ephemeral,
});

/** Buttons and popups from the /user panel. Only reached by the owner (checked in InteractionCreate). */
async function handleUserPanel(interaction) {
  const [, action, userId] = interaction.customId.split(':');
  if (!/^\d+$/.test(userId ?? '')) {
    await safeReply(interaction, errorReply('Something went wrong. Run `/user` again.'));
    return;
  }
  const guild = interaction.guild;
  const plural = (n) => (n === 1 ? 'invite' : 'invites');

  // Add / Remove: open the amount popup.
  if (interaction.isButton() && (action === 'add' || action === 'remove')) {
    const input = new TextInputBuilder()
      .setCustomId(USER_AMOUNT_ID)
      .setLabel(action === 'add' ? 'How many invites to add?' : 'How many invites to remove?')
      .setPlaceholder('e.g: 3')
      .setStyle(TextInputStyle.Short)
      .setMinLength(1)
      .setMaxLength(6)
      .setRequired(true);
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`${USER_PREFIX}modal-${action}:${userId}`)
        .setTitle(action === 'add' ? 'Add invites' : 'Remove invites')
        .addComponents(new ActionRowBuilder().addComponents(input)),
    );
    return;
  }

  // Reset: back to 0 straight away.
  if (interaction.isButton() && action === 'reset') {
    resetStats(guild.id, userId);
    await interaction.deferUpdate();
    await interaction.editReply(await userPanelPayload(guild, userId, '✅ Invites reset to 0.'));
    return;
  }

  // Amount popup submitted.
  if (interaction.isModalSubmit() && (action === 'modal-add' || action === 'modal-remove')) {
    if (!interaction.isFromMessage()) {
      await safeReply(interaction, errorReply('Something went wrong. Run `/user` again.'));
      return;
    }

    const raw = interaction.fields.getTextInputValue(USER_AMOUNT_ID).trim();
    const amount = /^\d{1,6}$/.test(raw) ? Number(raw) : 0;
    if (amount < 1) {
      await safeReply(interaction, errorReply('Enter a whole number greater than 0.'));
      return;
    }

    let notice;
    if (action === 'modal-add') {
      adjustInvites(guild.id, userId, amount);
      notice = `✅ Added **${amount}** ${plural(amount)}.`;
    } else {
      const removed = adjustInvites(guild.id, userId, -amount);
      if (removed === 0) notice = 'ℹ️ They have no invites to remove.';
      else if (removed < amount) notice = `✅ Removed **${removed}** ${plural(removed)} (all they had).`;
      else notice = `✅ Removed **${removed}** ${plural(removed)}.`;
    }

    await interaction.deferUpdate();
    await interaction.editReply(await userPanelPayload(guild, userId, notice));
    return;
  }

  await interaction.deferUpdate().catch(() => {});
}

// ---- /placeholder: sample invite messages to preview an active server ----
// Owner only, off by default, in-memory only (a restart turns it off). /placeholder opens a private panel
// (only you see it) with the current inviters, their progress to 6, an Update button and an On/Off button.
// Messages are posted in the invite tracking channel set with /set (the same one real invite messages use).
//
// Names come from OFFLINE members, picked a few at a time, never by loading the whole member list:
//   1. one REST page of members is read from a random point in the member list,
//   2. only a small shuffled batch of those ids is checked for presence over the gateway,
//   3. offline, non-bot members are kept until enough are found.
// A handful of inviters are active at once. Every 3 to 10 minutes one of them invites a member from a small
// queue (each queued member is used once). An inviter who reaches 6 is replaced by a new offline member.
// It never touches the database, stats or real invites, and the invite display cap does NOT apply here.
const PLACEHOLDER_ACTIVE_INVITERS = 4;
const PLACEHOLDER_MAX_INVITES = 6;
const PLACEHOLDER_MIN_DELAY_MS = 3 * 60_000;
const PLACEHOLDER_MAX_DELAY_MS = 10 * 60_000;
const PLACEHOLDER_POOL_BATCH = 10; // how many offline members to queue per lookup
const PLACEHOLDER_UPDATE_ID = 'placeholder:update';
const PLACEHOLDER_TOGGLE_ID = 'placeholder:toggle';
const DISCORD_EPOCH = 1420070400000n;

// guildId -> { timer, nextAt, sent, active: [{ id, name, count }], pool: [{ id, name }], seen: Set }
const placeholderRuns = new Map();
const placeholderStopped = new Map(); // guildId -> why it stopped by itself (shown once on the panel)

const randomItem = (list) => list[Math.floor(Math.random() * list.length)];

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** A random snowflake between 2016 and now, used as the starting point of one page of members. */
function randomMemberCursor() {
  const min = Date.UTC(2016, 0, 1);
  const ts = BigInt(Math.floor(min + Math.random() * (Date.now() - min)));
  return String((ts - DISCORD_EPOCH) << 22n);
}

/**
 * Finds up to `need` offline, non-bot members without loading everyone: one REST page from a random
 * point, then presence is only checked for a small shuffled batch of those members at a time.
 */
async function pickOfflineMembers(guild, need, exclude) {
  const picked = [];
  const taken = new Set(exclude);
  const starts = [randomMemberCursor(), randomMemberCursor(), randomMemberCursor(), randomMemberCursor(), '0'];

  for (const after of starts) {
    if (picked.length >= need) break;
    const page = await guild.members.list({ limit: 500, after });
    const ids = shuffle([...page.values()].filter((m) => !m.user.bot && !taken.has(m.id)).map((m) => m.id));

    for (let i = 0; i < ids.length && picked.length < need; ) {
      const step = Math.min(100, Math.max(20, (need - picked.length) * 3));
      const chunk = ids.slice(i, i + step);
      i += step;

      // Asks the gateway for just these members plus their presence. Online members come back with a
      // presence; offline ones don't.
      const members = await guild.members.fetch({ user: chunk, withPresences: true });
      for (const m of members.values()) {
        if (picked.length >= need) break;
        const status = m.presence?.status;
        if (m.user.bot || taken.has(m.id) || (status && status !== 'offline')) continue;
        picked.push({ id: m.id, name: m.displayName });
        taken.add(m.id);
      }
    }
  }
  return picked;
}

/** Next unused offline member from the queue, refilling the queue (a few at a time) when it is empty. */
async function takeFromPool(guild, run) {
  if (run.pool.length === 0) {
    let found = await pickOfflineMembers(guild, PLACEHOLDER_POOL_BATCH, run.seen);
    if (found.length === 0 && run.seen.size > 0) {
      // Everyone available was already used (small server): allow reuse, but never the active inviters.
      run.seen = new Set(run.active.map((a) => a.id));
      found = await pickOfflineMembers(guild, PLACEHOLDER_POOL_BATCH, run.seen);
    }
    run.pool.push(...found);
  }
  const member = run.pool.shift() ?? null;
  if (member) run.seen.add(member.id);
  return member;
}

/** Tops the active inviters back up to PLACEHOLDER_ACTIVE_INVITERS. */
async function fillInviters(guild, run) {
  while (run.active.length < PLACEHOLDER_ACTIVE_INVITERS) {
    const member = await takeFromPool(guild, run);
    if (!member) break;
    run.active.push({ ...member, count: 0 });
  }
  if (run.active.length === 0) throw new Error("Couldn't find any offline members.");
}

function stopPlaceholder(guildId) {
  const run = placeholderRuns.get(guildId);
  if (!run) return false;
  clearTimeout(run.timer);
  placeholderRuns.delete(guildId);
  return true;
}

async function startPlaceholder(guild) {
  const run = { timer: null, nextAt: 0, sent: 0, active: [], pool: [], seen: new Set() };
  placeholderRuns.set(guild.id, run);
  placeholderStopped.delete(guild.id);
  try {
    await fillInviters(guild, run);
  } catch (err) {
    if (placeholderRuns.get(guild.id) === run) placeholderRuns.delete(guild.id);
    throw err;
  }
  if (placeholderRuns.get(guild.id) !== run) return; // switched off while looking up members
  schedulePlaceholder(guild.id);
}

function schedulePlaceholder(guildId) {
  const run = placeholderRuns.get(guildId);
  if (!run) return;

  // Random gap of 3 to 10 minutes so it doesn't look like a clock.
  const delay = PLACEHOLDER_MIN_DELAY_MS + Math.floor(Math.random() * (PLACEHOLDER_MAX_DELAY_MS - PLACEHOLDER_MIN_DELAY_MS));
  run.nextAt = Date.now() + delay;
  run.timer = setTimeout(async () => {
    if (placeholderRuns.get(guildId) !== run) return;

    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) throw new Error('Server not available.');

      await fillInviters(guild, run);
      const invitee = await takeFromPool(guild, run);
      if (placeholderRuns.get(guildId) !== run) return; // switched off while looking up members
      if (!invitee) throw new Error('Ran out of offline members to use.');

      const inviter = randomItem(run.active);
      const channel = await getTrackingChannel(guild);
      if (!channel) throw new Error('No invite tracking channel is set (use /set).');
      // No display cap here: the real count is shown (the cap only applies to real invite messages).
      await channel.send({
        embeds: [embed(null, inviteText(escapeMarkdown(inviter.name), escapeMarkdown(invitee.name), inviter.count + 1))],
        allowedMentions: NO_MENTIONS,
      });

      run.sent += 1;
      inviter.count += 1;
      if (inviter.count >= PLACEHOLDER_MAX_INVITES) {
        // Reached the max: swap in a new offline member (a failed lookup is retried on the next tick).
        run.active.splice(run.active.indexOf(inviter), 1);
        await fillInviters(guild, run).catch((err) => console.warn('[placeholder] Refill failed:', err.message));
      }
    } catch (err) {
      console.warn(`[placeholder] Stopping in guild ${guildId}:`, err.message);
      placeholderStopped.set(guildId, err.message);
      stopPlaceholder(guildId);
      return;
    }
    if (placeholderRuns.get(guildId) === run) schedulePlaceholder(guildId);
  }, delay);
}

function placeholderPanel(guildId, notice) {
  const run = placeholderRuns.get(guildId);
  const lines = [];

  if (run) {
    const trackingId = getChannelId(guildId);
    lines.push(`**On** in ${trackingId ? `<#${trackingId}>` : 'no channel (use /set)'}. Next invite ${relativeDate(run.nextAt)}.`, '');
    if (run.active.length === 0) lines.push('Picking inviters...');
    for (const a of run.active) {
      const bar = '▰'.repeat(a.count) + '▱'.repeat(PLACEHOLDER_MAX_INVITES - a.count);
      lines.push(`**${escapeMarkdown(a.name)}**  ${bar}  ${a.count}/${PLACEHOLDER_MAX_INVITES}`);
    }
    lines.push('', `Invites posted: **${run.sent}** · Offline members queued: **${run.pool.length}**`);
  } else {
    lines.push('**Off**. Press **Turn on** to start posting sample invites in the invite tracking channel.');
    const why = placeholderStopped.get(guildId);
    if (why) lines.push('', `Stopped on its own: ${why}`);
  }
  if (notice) lines.push('', notice);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PLACEHOLDER_UPDATE_ID).setLabel('Update').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(PLACEHOLDER_TOGGLE_ID)
      .setLabel(run ? 'Turn off' : 'Turn on')
      .setStyle(run ? ButtonStyle.Danger : ButtonStyle.Success),
  );
  return { embeds: [embed('Placeholder invites', lines.join('\n'))], components: [row], allowedMentions: NO_MENTIONS };
}

async function handlePlaceholderButton(interaction) {
  const guild = interaction.guild;

  if (interaction.customId === PLACEHOLDER_UPDATE_ID) {
    await interaction.update(placeholderPanel(guild.id));
    return;
  }

  // Toggle. Looking up members can take a moment, so acknowledge first.
  await interaction.deferUpdate();
  let notice;
  if (placeholderRuns.has(guild.id)) {
    stopPlaceholder(guild.id);
    placeholderStopped.delete(guild.id);
  } else if (!(await getTrackingChannel(guild))) {
    notice = 'Set the invite tracking channel first with /set.';
  } else {
    try {
      await startPlaceholder(guild);
    } catch (err) {
      notice = `Couldn't turn on: ${err.message}`;
    }
  }
  await interaction.editReply(placeholderPanel(guild.id, notice));
}

const commands = [
  // /set type:<Invite tracking | Claim logs> channel:<text channel>
  {
    data: new SlashCommandBuilder()
      .setName('set')
      .setDescription('Set the invite tracking channel or the claim logs channel')
      .addStringOption((o) =>
        o
          .setName('type')
          .setDescription('Which channel to set')
          .addChoices({ name: 'Invite tracking', value: 'tracking' }, { name: 'Claim logs', value: 'logs' })
          .setRequired(true),
      )
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('The channel to use')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      )
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const type = interaction.options.getString('type', true);
      const channel = interaction.options.getChannel('channel', true);

      let result;
      if (type === 'logs') {
        setLogChannelId(interaction.guildId, channel.id);
        result = embed('Log channel set', `Claim attempts will be logged in <#${channel.id}>.`);
      } else {
        setChannelId(interaction.guildId, channel.id);
        result = embed('Tracking channel set', `Join messages will be posted in <#${channel.id}>.`);
      }

      // Warn if the bot can't post there.
      const me = interaction.guild.members.me;
      const perms = me ? channel.permissionsFor(me) : null;
      if (perms) {
        const missing = [
          [PermissionFlagsBits.ViewChannel, 'View Channel'],
          [PermissionFlagsBits.SendMessages, 'Send Messages'],
          [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
        ]
          .filter(([flag]) => !perms.has(flag))
          .map(([, name]) => name);
        if (missing.length) {
          result.addFields({
            name: 'Warning',
            value: `I'm missing these permissions in that channel: ${missing.join(', ')}.`,
          });
        }
      }
      await send(interaction, result);
    },
  },

  // /unset type:<optional, defaults to invite tracking>
  {
    data: new SlashCommandBuilder()
      .setName('unset')
      .setDescription('Remove the invite tracking channel or the claim logs channel')
      .addStringOption((o) =>
        o
          .setName('type')
          .setDescription('Which channel to remove (defaults to invite tracking)')
          .addChoices({ name: 'Invite tracking', value: 'tracking' }, { name: 'Claim logs', value: 'logs' }),
      )
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const type = interaction.options.getString('type') ?? 'tracking';

      if (type === 'logs') {
        const removed = clearLogChannelId(interaction.guildId);
        await send(
          interaction,
          removed
            ? embed('Log channel removed', 'Claim attempts are no longer logged.')
            : embed('Nothing to remove', 'No log channel was set.'),
        );
        return;
      }

      const removed = clearChannelId(interaction.guildId);
      await send(
        interaction,
        removed
          ? embed('Tracking channel removed', 'Join messages are off. Joins are still being tracked.')
          : embed('Nothing to remove', 'No tracking channel was set.'),
      );
    },
  },

  // /invites user:<optional>  (public: the only command everyone can use)
  {
    public: true,
    data: new SlashCommandBuilder()
      .setName('invites')
      .setDescription("Show a member's invite stats")
      .addUserOption((o) => o.setName('user').setDescription('Member to look up (defaults to you)'))
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const user = interaction.options.getUser('user') ?? interaction.user;
      const stats = getStats(interaction.guildId, user.id);

      await send(
        interaction,
        embed('Invite stats', `Stats for <@${user.id}>`)
          .setThumbnail(user.displayAvatarURL())
          .addFields(
            { name: 'Current', value: String(stats.current), inline: true },
            { name: 'Total joins', value: String(stats.joins), inline: true },
            { name: 'Leaves', value: String(stats.leaves), inline: true },
          ),
      );
    },
  },

  // /leaderboard
  {
    data: new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Show the top 10 inviters')
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const rows = getLeaderboard(interaction.guildId, 10);
      if (rows.length === 0) {
        await send(
          interaction,
          embed('Invite leaderboard', 'No invites have been tracked yet. Check back after some members join.'),
        );
        return;
      }

      const lines = rows.map(
        (r, i) =>
          `**${i + 1}.** <@${r.inviterId}> - **${r.current}** current (${r.joins} joins, ${r.leaves} leaves)`,
      );
      await send(interaction, embed('Invite leaderboard', lines.join('\n')));
    },
  },

  // /user user:<required>  (replaces /whoinvited and /resetinvites)
  {
    data: new SlashCommandBuilder()
      .setName('user')
      .setDescription("Show a member's info and manage their invites")
      .addUserOption((o) => o.setName('user').setDescription('The member to look up').setRequired(true))
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const user = interaction.options.getUser('user', true);
      await interaction.deferReply();
      await interaction.editReply(await userPanelPayload(interaction.guild, user.id));
    },
  },

  // /placeholder  (public panel: inviter progress, Update, Turn on/off)
  {
    data: new SlashCommandBuilder()
      .setName('placeholder')
      .setDescription('Open the sample invite panel (off by default)')
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      await safeReply(interaction, placeholderPanel(interaction.guild.id));
    },
  },

  // /status
  {
    data: new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show tracking and log channels, cached invites, and permission status')
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const guild = interaction.guild;
      const me = guild.members.me ?? (await guild.members.fetchMe());

      const channelId = getChannelId(guild.id);
      const channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
      let channelText = 'Not set';
      if (channelId) channelText = channel ? `<#${channel.id}>` : 'Not found (use /set again)';

      const logId = getLogChannelId(guild.id);
      let logText = 'Not set';
      if (logId) {
        const logChannel = await guild.channels.fetch(logId).catch(() => null);
        logText = logChannel ? `<#${logChannel.id}>` : 'Not found (use /set again)';
      }

      const cached = inviteCache.get(guild.id)?.size;
      const cachedText = cached === undefined ? 'Not loaded (needs Manage Server)' : String(cached);

      // Manage Server is server-wide; the rest are checked in the tracking channel if set.
      const channelPerms = channel ? channel.permissionsFor(me) : me.permissions;
      const checks = [
        ['Manage Server', me.permissions.has(PermissionFlagsBits.ManageGuild)],
        ['View Channels', channelPerms.has(PermissionFlagsBits.ViewChannel)],
        ['Send Messages', channelPerms.has(PermissionFlagsBits.SendMessages)],
        ['Embed Links', channelPerms.has(PermissionFlagsBits.EmbedLinks)],
      ];
      const allOk = checks.every(([, ok]) => ok);

      await send(
        interaction,
        embed('Bot status', allOk ? 'All required permissions are in place.' : 'Some permissions are missing.')
          .addFields(
            { name: 'Tracking channel', value: channelText, inline: true },
            { name: 'Log channel', value: logText, inline: true },
            { name: 'Cached invites', value: cachedText, inline: true },
            {
              name: channel ? 'Permissions (in tracking channel)' : 'Permissions (server-wide)',
              value: checks.map(([name, ok]) => `${ok ? '✅' : '❌'} ${name}`).join('\n'),
            },
          ),
      );
    },
  },

  // /test
  {
    data: new SlashCommandBuilder()
      .setName('test')
      .setDescription('Post a sample invite message in the tracking channel (you as inviter and invitee)')
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const channel = await getTrackingChannel(interaction.guild);
      if (!channel) {
        await send(interaction, embed(null, 'No tracking channel is set. Use `/set` first.'), { ephemeral: true });
        return;
      }

      // Preview only: nothing is written to the database. Shows the count as if
      // this were a real invite (current + 1).
      const count = getStats(interaction.guildId, interaction.user.id).current + 1;
      const name = await nameOf(interaction.guild, interaction.user.id);
      try {
        await channel.send({
          embeds: [embed(null, inviteText(name, name, count))],
          allowedMentions: NO_MENTIONS,
        });
      } catch (err) {
        await send(interaction, embed(null, `Couldn't post in <#${channel.id}>: ${err.message}`), { ephemeral: true });
        return;
      }
      await send(interaction, embed(null, `Test message sent to <#${channel.id}>.`), { ephemeral: true });
    },
  },

  // /rewards
  {
    data: new SlashCommandBuilder()
      .setName('rewards')
      .setDescription('Post the rewards information embeds in this channel')
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const channel =
        interaction.channel ?? (await interaction.guild.channels.fetch(interaction.channelId).catch(() => null));
      if (!channel?.isTextBased()) {
        await send(interaction, embed(null, "I can't post in this channel."), { ephemeral: true });
        return;
      }

      const introduction = embed(
        'What is this server about?',
        'FreePass focuses on rewarding its members with various in-game items from Brawl Stars for doing tasks, ' +
          'such as inviting other members to the server. How do we profit from this? It\'s simple - we have a method ' +
          'that lets us buy goodies for way cheaper (basically almost free), meaning it\'s a win-win situation since ' +
          'we get members and potential customers, and our members earn in-game items.',
      ).setAuthor({ name: 'Introduction', iconURL: ARROW_ICON });

      const safety = embed(
        'How safe is this?',
        "We purchase items in a legal manner and from a legitimate store, therefore we've never had problems " +
          'with revokes and such. We do not require logging into your account, just your player tag.',
      ).setAuthor({ name: 'Safety', iconURL: ARROW_ICON });

      const getStarted = embed('How do I get started?')
        .setAuthor({ name: 'Process', iconURL: ARROW_ICON })
        .addFields(
          {
            name: '1. Start inviting people to the server',
            value:
              'Get yourself an invite link by clicking on the server name, then "Invite". From there you can copy ' +
              'the link to send it to others or directly send it to your friends.',
          },
          {
            name: '2. Get enough invites',
            value:
              'Check your invites using the "Claim" button below, once you have enough for your desired ' +
              'reward continue to the next step.',
          },
          {
            name: '3. Claim your reward',
            value:
              'Press the "Claim" button below, select your reward and follow the automated process, the item ' +
              "will be sent to you within 10 minutes and you'll be asked to leave a vouch. Enjoy!",
          },
        );

      const rewards = embed('The rewards are as follows:', 'Note that this event is ending on Oct 20th.')
        .setAuthor({ name: 'Rewards', iconURL: ARROW_ICON })
        .addFields(
          REWARDS.map((r, i) => ({
            name: `${emojiText(r.emoji)} ${r.name} • ${r.invites} invites`,
            // Invisible extra line adds a gap between rewards (not after the last one).
            value: `Invite **${r.invites} people** to claim⤴${i < REWARDS.length - 1 ? '\n\u200b' : ''}`,
          })),
        );

      // banner.png / logo.png are read from the same folder as index.js.
      const files = [];
      const footer = { text: 'FreePass - The only legit place to get freebies!' };
      const bannerPath = path.resolve(__dirname, 'banner.png');
      const logoPath = path.resolve(__dirname, 'logo.png');
      if (fs.existsSync(bannerPath)) {
        files.push(new AttachmentBuilder(bannerPath, { name: 'banner.png' }));
        rewards.setImage('attachment://banner.png');
      } else {
        console.warn(`banner.png not found at ${bannerPath}; posting without the banner.`);
      }
      if (fs.existsSync(logoPath)) {
        files.push(new AttachmentBuilder(logoPath, { name: 'logo.png' }));
        footer.iconURL = 'attachment://logo.png';
      } else {
        console.warn(`logo.png not found at ${logoPath}; posting without the footer logo.`);
      }
      rewards.setFooter(footer);

      // Gray buttons: Secondary for Claim; link buttons are always gray in Discord.
      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(CLAIM_BUTTON_ID)
          .setLabel('Claim')
          .setEmoji('📥')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setLabel('Reviews').setEmoji('⭐').setStyle(ButtonStyle.Link).setURL(REVIEWS_URL),
      );

      // channel.send posts a brand new message; it is not a reply to the command.
      try {
        await channel.send({
          embeds: [introduction, safety, getStarted, rewards],
          files,
          components: [buttons],
          allowedMentions: NO_MENTIONS,
        });
      } catch (err) {
        await send(interaction, embed(null, `Couldn't post here: ${err.message}`), { ephemeral: true });
        return;
      }

      // Slash commands must be acknowledged; keep it private so the channel only shows the embeds.
      await send(interaction, embed(null, 'Rewards message posted.'), { ephemeral: true });
    },
  },

  // /tutorial
  {
    data: new SlashCommandBuilder()
      .setName('tutorial')
      .setDescription('Post the invite tutorial embeds in this channel')
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const channel =
        interaction.channel ?? (await interaction.guild.channels.fetch(interaction.channelId).catch(() => null));
      if (!channel?.isTextBased()) {
        await send(interaction, embed(null, "I can't post in this channel."), { ephemeral: true });
        return;
      }

      const step1 = embed(
        'Step 1:',
        'Click on the server name and find the "Invite" button below, then click it.',
      );
      const step2 = embed(
        'Step 2:',
        'From here, you can copy the link to send it to others, or directly invite people to the server below.',
      );

      // step1.png / step2.png / logo.png are read from the same folder as index.js.
      const files = [];
      const attach = (fileName) => {
        const filePath = path.resolve(__dirname, fileName);
        if (!fs.existsSync(filePath)) {
          console.warn(`${fileName} not found at ${filePath}; posting without it.`);
          return false;
        }
        files.push(new AttachmentBuilder(filePath, { name: fileName }));
        return true;
      };

      if (attach('step1.png')) step1.setImage('attachment://step1.png');
      if (attach('step2.png')) step2.setImage('attachment://step2.png');

      const footer = {
        text: 'Pro tip: Join Brawl Stars related servers and say "message me for free brawl pass" and once they do, send them your invite link!',
      };
      if (attach('logo.png')) footer.iconURL = 'attachment://logo.png';
      step2.setFooter(footer);

      // channel.send posts a brand new message; it is not a reply to the command.
      try {
        await channel.send({
          embeds: [step1, step2],
          files,
          allowedMentions: NO_MENTIONS,
        });
      } catch (err) {
        await send(interaction, embed(null, `Couldn't post here: ${err.message}`), { ephemeral: true });
        return;
      }

      // Slash commands must be acknowledged; keep it private so the channel only shows the embeds.
      await send(interaction, embed(null, 'Tutorial message posted.'), { ephemeral: true });
    },
  },
];

const commandMap = new Map(commands.map((c) => [c.data.name, c]));

/** Registers slash commands: to GUILD_ID if set (instant), otherwise globally. */
async function registerCommands(client) {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const appId = CLIENT_ID || client.user.id;
  const body = commands.map((c) => c.data.toJSON());

  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body });
    console.log(`Registered ${body.length} command(s) to guild ${GUILD_ID}.`);
  } else {
    await rest.put(Routes.applicationCommands(appId), { body });
    console.log(`Registered ${body.length} command(s) globally (may take up to an hour to appear).`);
  }
}

// ===========================================================================
// 6. CLIENT + EVENTS
// ===========================================================================
// Only the intents we need, and tight caches for a 256 MB host.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildPresences, // privileged: lets /placeholder check whether a member is offline
  ],
  allowedMentions: NO_MENTIONS,
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 0,
    PresenceManager: { maxSize: 200 }, // tiny on purpose: presences are only checked on demand
    ReactionManager: 0,
    ReactionUserManager: 0,
    VoiceStateManager: 0,
    StageInstanceManager: 0,
    ThreadManager: 0,
    ThreadMemberManager: 0,
    GuildScheduledEventManager: 0,
    GuildBanManager: 0,
    GuildInviteManager: 0, // we keep our own lightweight invite cache
    GuildMemberManager: { maxSize: 100, keepOverLimit: (m) => m.id === m.client.user.id },
    UserManager: { maxSize: 100, keepOverLimit: (u) => u.id === u.client.user.id },
  }),
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s).`);

  try {
    await registerCommands(c);
  } catch (err) {
    console.error('Failed to register commands:', err);
  }

  for (const guild of c.guilds.cache.values()) {
    await cacheGuildInvites(guild).catch((err) => console.error('Invite cache error:', err));
  }
  console.log('Invite cache ready.');
});

client.on(Events.GuildCreate, (guild) => {
  // Servers present at startup are handled in ClientReady; this covers new ones.
  if (!client.isReady()) return;
  cacheGuildInvites(guild).catch((err) => console.error('Invite cache error:', err));
});

client.on(Events.GuildDelete, (guild) => {
  stopPlaceholder(guild.id);
  dropGuild(guild.id);
});

client.on(Events.InviteCreate, (invite) => {
  try {
    addInvite(invite);
  } catch (err) {
    console.error('inviteCreate error:', err);
  }
});

client.on(Events.InviteDelete, (invite) => {
  try {
    removeInvite(invite);
  } catch (err) {
    console.error('inviteDelete error:', err);
  }
});

client.on(Events.GuildMemberAdd, (member) => {
  handleJoin(member).catch((err) => console.error('guildMemberAdd error:', err));
});

client.on(Events.GuildMemberRemove, (member) => {
  handleLeave(member).catch((err) => console.error('guildMemberRemove error:', err));
});

// Access control: everything is owner-only except /invites and the public rewards
// Claim button, menu and popups (handled first because every member needs them).
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.inGuild()) {
      if (interaction.isButton() && interaction.customId === CLAIM_BUTTON_ID) {
        await handleClaimButton(interaction);
        return;
      }
      if (interaction.isStringSelectMenu() && interaction.customId === CLAIM_SELECT_ID) {
        await handleClaimSelect(interaction);
        return;
      }
      if (interaction.isButton() && interaction.customId.startsWith(TAG_BUTTON_PREFIX)) {
        await handleTagButton(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith(TAG_MODAL_PREFIX)) {
        await handleTagModal(interaction);
        return;
      }
      if (interaction.isButton() && interaction.customId.startsWith(REVIEW_BUTTON_PREFIX)) {
        await handleReviewButton(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith(REVIEW_MODAL_PREFIX)) {
        await handleReviewModal(interaction);
        return;
      }
    }

    const command = interaction.isChatInputCommand() ? commandMap.get(interaction.commandName) : null;

    if (interaction.user.id !== OWNER_ID && !command?.public) {
      if (interaction.isRepliable()) {
        await safeReply(interaction, errorReply("You don't have permission to use this command."));
      }
      return;
    }

    // Buttons and popups from the /user panel (owner only, checked above).
    if (
      interaction.inGuild() &&
      (interaction.isButton() || interaction.isModalSubmit()) &&
      interaction.customId.startsWith(USER_PREFIX)
    ) {
      await handleUserPanel(interaction);
      return;
    }

    if (
      interaction.inGuild() &&
      interaction.isButton() &&
      (interaction.customId === PLACEHOLDER_UPDATE_ID || interaction.customId === PLACEHOLDER_TOGGLE_ID)
    ) {
      await handlePlaceholderButton(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    // Servers only.
    if (!interaction.inGuild() || !interaction.guild) {
      await safeReply(interaction, {
        embeds: [embed(null, 'This command can only be used in a server.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (command) await command.execute(interaction);
  } catch (err) {
    // A failing command must never crash the bot.
    console.error(`Error in interaction "${interaction.commandName ?? interaction.customId}":`, err);
    await safeReply(interaction, {
      embeds: [embed('Something went wrong', 'The command failed. Check the console for details.')],
      flags: MessageFlags.Ephemeral,
    });
  }
});

// ===========================================================================
// 7. GLOBAL ERROR HANDLING + SHUTDOWN
// ===========================================================================
client.on(Events.Error, (err) => console.error('Client error:', err));
client.on(Events.Warn, (msg) => console.warn('Client warning:', msg));
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  try {
    client.destroy();
    db.close();
  } catch (err) {
    console.error('Error during shutdown:', err);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('Login failed:', err);
  process.exit(1);
});

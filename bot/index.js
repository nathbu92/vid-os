// bot/index.js — YouTube → Discord Notifier (GitHub Actions)
// • Run manuel (INIT_MODE=true) : envoie les 10 dernières vidéos de chaque chaîne
// • Cron automatique : notifie uniquement les nouvelles vidéos

const fetch  = require("node-fetch");
const xml2js = require("xml2js");
const fs     = require("fs");
const path   = require("path");

const SEEN_PATH   = path.join(__dirname, "seen_videos.json");
const INIT_MODE   = process.env.INIT_MODE === "true";
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK;
const MENTION     = process.env.MENTION || "";

let CHANNELS = [];
try {
  CHANNELS = JSON.parse(process.env.CHANNELS || "[]");
} catch (e) {
  console.error("CHANNELS invalide :", e.message);
  process.exit(1);
}
if (!WEBHOOK_URL) { console.error("DISCORD_WEBHOOK manquant."); process.exit(1); }
if (!CHANNELS.length) { console.error("CHANNELS vide."); process.exit(1); }

// ─── Persistance ──────────────────────────────────────────────────────────────
function loadSeen() {
  if (!fs.existsSync(SEEN_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(SEEN_PATH, "utf-8")); } catch { return {}; }
}
function saveSeen(seen) {
  fs.writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 2));
}

// ─── RSS ──────────────────────────────────────────────────────────────────────
async function fetchFeed(channelId) {
  const res = await fetch(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    { headers: { "User-Agent": "Mozilla/5.0 (compatible; YT-Discord-Bot/2.2)" }, timeout: 15000 }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const parsed = await xml2js.parseStringPromise(await res.text(), { explicitArray: false });
  const entries = parsed.feed?.entry || [];
  return Array.isArray(entries) ? entries : [entries];
}

// ─── Détection Short ──────────────────────────────────────────────────────────
async function isShort(videoId, title, description) {
  const text = `${title} ${description}`.toLowerCase();
  if (text.includes("#shorts") || text.includes("#short")) return true;
  try {
    const res = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
      method: "HEAD", redirect: "manual", timeout: 6000,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    return res.status === 200;
  } catch { return false; }
}

// ─── Durée depuis le flux RSS ─────────────────────────────────────────────────
function parseDuration(video) {
  const raw = video["media:group"]?.["media:content"]?.["$"]?.duration;
  if (!raw) return null;
  const secs = parseInt(raw);
  if (isNaN(secs) || secs <= 0) return null;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
    : `${m}:${String(s).padStart(2,"0")}`;
}

// ─── Envoi Discord ────────────────────────────────────────────────────────────
async function sendDiscord(video, channelConfig, short, duration) {
  const videoId    = video["yt:videoId"];
  const title      = video.title || "Nouvelle vidéo";
  const videoUrl   = short
    ? `https://www.youtube.com/shorts/${videoId}`
    : `https://www.youtube.com/watch?v=${videoId}`;
  const author     = video.author?.name || channelConfig.name;
  const channelUrl = `https://www.youtube.com/@${author.replace(/\s+/g, "")}`;
  const rawDesc    = video["media:group"]?.["media:description"] || "";
  const desc       = rawDesc.length > 280 ? rawDesc.slice(0, 280) + "…" : rawDesc;

  const publishedStr = video.published
    ? new Date(video.published).toLocaleString("fr-FR", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris",
      })
    : "—";

  const badge = short ? "⚡ Short" : "🎬 Vidéo";
  const color = channelConfig.color ?? 0xFF0000;
  const thumb = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;

  const fields = [
    { name: "📺 Chaîne",     value: `[${author}](${channelUrl})`, inline: true },
    { name: "📅 Publiée le", value: publishedStr,                  inline: true },
    { name: "🎞️ Type",       value: badge,                         inline: true },
  ];
  if (duration) fields.push({ name: "⏱️ Durée", value: duration, inline: true });
  fields.push({ name: "🔗 Regarder", value: `[Ouvrir sur YouTube](${videoUrl})`, inline: false });

  const content = `${MENTION ? MENTION + " " : ""}${badge} **${author}** vient de publier un nouveau ${short ? "Short" : "vidéo"} !`;

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      embeds: [{
        title,
        url: videoUrl,
        description: desc || undefined,
        color,
        image: { url: thumb },
        fields,
        footer: { text: `YouTube • ${author}`, icon_url: "https://www.youtube.com/favicon.ico" },
        timestamp: video.published || undefined,
      }],
    }),
  });

  if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text()}`);
}

// ─── Envoi des N dernières vidéos d'une chaîne (mode init) ───────────────────
async function sendLatest(channelConfig, entries, n) {
  // entries est trié du plus récent au plus ancien, on prend les n premiers
  // et on les envoie du plus ancien au plus récent pour un ordre chronologique
  const toSend = entries.slice(0, n).reverse();
  console.log(`  [${channelConfig.name}] Envoi des ${toSend.length} dernières vidéos...`);
  for (const video of toSend) {
    const videoId  = video["yt:videoId"];
    if (!videoId) continue;
    const title    = video.title || "";
    const desc     = video["media:group"]?.["media:description"] || "";
    const short    = await isShort(videoId, title, desc);
    const duration = parseDuration(video);
    try {
      await sendDiscord(video, channelConfig, short, duration);
      console.log(`  OK "${title}"`);
    } catch (err) {
      console.error(`  ERR ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 2000)); // anti rate-limit Discord
  }
}

// ─── Vérification d'une chaîne (mode cron) ───────────────────────────────────
async function checkChannel(channelConfig, seen) {
  const { id, name } = channelConfig;
  let entries;
  try {
    entries = await fetchFeed(id);
  } catch (err) {
    console.error(`  [${name}] RSS inaccessible : ${err.message}`);
    return;
  }
  if (!entries.length) return;

  if (!seen[id]) {
    seen[id] = entries.map(e => e["yt:videoId"]).filter(Boolean);
    console.log(`  [${name}] Premiere fois — ${seen[id].length} video(s) indexee(s).`);
    return;
  }

  const newVideos = entries.filter(e => e["yt:videoId"] && !seen[id].includes(e["yt:videoId"]));
  if (!newVideos.length) {
    console.log(`  [${name}] Rien de nouveau.`);
    return;
  }

  for (const video of newVideos.reverse()) {
    const videoId  = video["yt:videoId"];
    const title    = video.title || "";
    const desc     = video["media:group"]?.["media:description"] || "";
    const short    = await isShort(videoId, title, desc);
    const duration = parseDuration(video);
    console.log(`  NEW [${name}] "${title}" ${short ? "Short" : "Video"}`);
    try {
      await sendDiscord(video, channelConfig, short, duration);
      console.log(`  OK notification envoyee.`);
    } catch (err) {
      console.error(`  ERR ${err.message}`);
    }
    seen[id].push(videoId);
    if (seen[id].length > 50) seen[id] = seen[id].slice(-50);
    await new Promise(r => setTimeout(r, 2000));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const mode = INIT_MODE ? "INIT (10 dernieres par chaine)" : "SURVEILLANCE";
  console.log(`YT Notifier — ${mode}`);
  console.log(`${new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}\n`);

  if (INIT_MODE) {
    // Mode init : envoie les 10 dernières vidéos non encore vues, puis met à jour seen_videos.json
    // → un 2ème run manuel ne renverra pas les mêmes vidéos
    const seen = loadSeen();
    for (const ch of CHANNELS) {
      let entries;
      try { entries = await fetchFeed(ch.id); }
      catch (err) { console.error(`[${ch.name}] RSS inaccessible : ${err.message}`); continue; }

      // Filtre les vidéos déjà vues (si seen_videos.json existe déjà)
      const alreadySeen = seen[ch.id] || [];
      const toSend = entries.filter(e => e["yt:videoId"] && !alreadySeen.includes(e["yt:videoId"]));

      if (!toSend.length) {
        console.log(`  [${ch.name}] Deja a jour, rien a envoyer.`);
      } else {
        await sendLatest(ch, toSend.slice(0, 10), 10);
      }

      // On indexe toutes les vidéos du flux pour éviter tout renvoi futur
      seen[ch.id] = entries.map(e => e["yt:videoId"]).filter(Boolean);
    }
    saveSeen(seen);
    console.log("\nInit terminee — seen_videos.json mis a jour.");
  } else {
    // Mode cron normal
    const seen = loadSeen();
    for (const ch of CHANNELS) await checkChannel(ch, seen);
    saveSeen(seen);
    console.log("\nTermine.");
  }
})();

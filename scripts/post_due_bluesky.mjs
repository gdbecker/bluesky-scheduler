import fs from "node:fs";
import path from "node:path";
import { BskyAgent, RichText } from "@atproto/api";

const POSTS_DIR = "posts";
const DRY_RUN = process.env.DRY_RUN === "true";

const ACCOUNTS = {
  garrett_dev_desk: {
    identifier: process.env.BLUESKY_GDD_IDENTIFIER,
    password: process.env.BLUESKY_GDD_APP_PASSWORD,
  },
  edge_studio: {
    identifier: process.env.BLUESKY_EDGE_IDENTIFIER,
    password: process.env.BLUESKY_EDGE_APP_PASSWORD,
  },
};

const agentCache = new Map();

function getJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      return getJsonFiles(fullPath);
    }

    return entry.isFile() && entry.name.endsWith(".json") ? [fullPath] : [];
  });
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";

  throw new Error(`Unsupported image type: ${filePath}`);
}

async function getAgent(accountName) {
  const account = ACCOUNTS[accountName];

  if (!account) {
    throw new Error(
      `Unknown account "${accountName}". Expected one of: ${Object.keys(ACCOUNTS).join(", ")}`,
    );
  }

  if (!account.identifier || !account.password) {
    throw new Error(`Missing credentials for account "${accountName}".`);
  }

  if (agentCache.has(accountName)) {
    return agentCache.get(accountName);
  }

  const agent = new BskyAgent({
    service: "https://bsky.social",
  });

  await agent.login({
    identifier: account.identifier,
    password: account.password,
  });

  agentCache.set(accountName, agent);
  return agent;
}

async function uploadImages(agent, media = [], alt = []) {
  if (!media.length) return undefined;

  if (media.length > 4) {
    throw new Error("Bluesky supports up to 4 images per post.");
  }

  if (alt.length && alt.length !== media.length) {
    throw new Error("Media and alt arrays must have the same length.");
  }

  const images = [];

  for (let i = 0; i < media.length; i++) {
    const filePath = media[i];

    if (!fs.existsSync(filePath)) {
      throw new Error(`Media file not found: ${filePath}`);
    }

    const buffer = fs.readFileSync(filePath);
    const encoding = getMimeType(filePath);

    const uploaded = await agent.uploadBlob(buffer, { encoding });

    images.push({
      image: uploaded.data.blob,
      alt: alt[i] || "",
    });
  }

  return {
    $type: "app.bsky.embed.images",
    images,
  };
}

async function createPostRecord(
  agent,
  text,
  reply = undefined,
  embed = undefined,
) {
  const rt = new RichText({ text });
  await rt.detectFacets(agent);

  const record = {
    text: rt.text,
    facets: rt.facets,
    createdAt: new Date().toISOString(),
  };

  if (reply) record.reply = reply;
  if (embed) record.embed = embed;

  if (DRY_RUN) {
    console.log("DRY RUN post:", JSON.stringify(record, null, 2));
    return {
      uri: `dry-run-uri-${Date.now()}`,
      cid: `dry-run-cid-${Date.now()}`,
    };
  }

  const result = await agent.post(record);

  return {
    uri: result.uri,
    cid: result.cid,
  };
}

async function postThread(item) {
  const accountName = item.account || "garretts_dev_desk";
  const agent = await getAgent(accountName);

  if (!Array.isArray(item.posts) || item.posts.length === 0) {
    throw new Error(`Post ${item.id} has no posts array.`);
  }

  for (const segment of item.posts) {
    if (segment.length > 300) {
      throw new Error(`Post ${item.id} has a segment over 300 characters.`);
    }
  }

  const embed = await uploadImages(agent, item.media, item.alt);

  let root = null;
  let parent = null;

  for (let i = 0; i < item.posts.length; i++) {
    const text = item.posts[i];

    const reply =
      i === 0
        ? undefined
        : {
            root,
            parent,
          };

    const result = await createPostRecord(
      agent,
      text,
      reply,
      i === 0 ? embed : undefined,
    );

    if (i === 0) {
      root = result;
    }

    parent = result;
  }

  item.status = DRY_RUN ? "dry_run" : "posted";
  item.posted_at = new Date().toISOString();
  item.posted_account = accountName;
}

const now = new Date();
const files = getJsonFiles(POSTS_DIR);

let postedCount = 0;

for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");
  const items = JSON.parse(raw);

  let changed = false;

  for (const item of items) {
    const scheduledAt = new Date(item.scheduled_at);

    if (item.status === "queued" && scheduledAt <= now) {
      console.log(
        `Posting ${item.id} to ${item.account || "garrett_dev_desk"}...`,
      );
      await postThread(item);
      postedCount++;
      changed = true;
    }
  }

  if (changed && !DRY_RUN) {
    fs.writeFileSync(file, JSON.stringify(items, null, 2) + "\n");
  }
}

console.log(`Finished. Posted ${postedCount} item(s).`);

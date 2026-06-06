import fs from "node:fs";
import path from "node:path";
import { BskyAgent, RichText } from "@atproto/api";

const POSTS_DIR = "posts";
const DRY_RUN = process.env.DRY_RUN === "true";

const identifier = process.env.BLUESKY_IDENTIFIER;
const password = process.env.BLUESKY_APP_PASSWORD;

if (!identifier || !password) {
  throw new Error("Missing BLUESKY_IDENTIFIER or BLUESKY_APP_PASSWORD.");
}

const agent = new BskyAgent({
  service: "https://bsky.social"
});

await agent.login({
  identifier,
  password
});

function getJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(dir, file));
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";

  throw new Error(`Unsupported image type: ${filePath}`);
}

async function uploadImages(media = [], alt = []) {
  if (!media.length) return undefined;

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
      alt: alt[i] || ""
    });
  }

  return {
    $type: "app.bsky.embed.images",
    images
  };
}

async function createPostRecord(text, reply = undefined, embed = undefined) {
  const rt = new RichText({ text });
  await rt.detectFacets(agent);

  const record = {
    text: rt.text,
    facets: rt.facets,
    createdAt: new Date().toISOString()
  };

  if (reply) record.reply = reply;
  if (embed) record.embed = embed;

  if (DRY_RUN) {
    console.log("DRY RUN post:", JSON.stringify(record, null, 2));
    return {
      uri: `dry-run-uri-${Date.now()}`,
      cid: `dry-run-cid-${Date.now()}`
    };
  }

  const result = await agent.post(record);

  return {
    uri: result.uri,
    cid: result.cid
  };
}

async function postThread(item) {
  if (!Array.isArray(item.posts) || item.posts.length === 0) {
    throw new Error(`Post ${item.id} has no posts array.`);
  }

  for (const segment of item.posts) {
    if (segment.length > 300) {
      throw new Error(`Post ${item.id} has a segment over 300 characters.`);
    }
  }

  const embed = await uploadImages(item.media, item.alt);

  let root = null;
  let parent = null;

  for (let i = 0; i < item.posts.length; i++) {
    const text = item.posts[i];

    const reply =
      i === 0
        ? undefined
        : {
            root,
            parent
          };

    const result = await createPostRecord(
      text,
      reply,
      i === 0 ? embed : undefined
    );

    if (i === 0) {
      root = result;
    }

    parent = result;
  }

  item.status = DRY_RUN ? "dry_run" : "posted";
  item.posted_at = new Date().toISOString();
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
      console.log(`Posting ${item.id}...`);
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
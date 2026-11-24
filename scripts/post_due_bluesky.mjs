import fs from "node:fs";
import path from "node:path";
import { BskyAgent, RichText } from "@atproto/api";

const POSTS_DIR = "posts";
const DRY_RUN = process.env.DRY_RUN === "true";
const MAX_GRAPHEMES = 300;

const ACCOUNTS = {
  garretts_dev_desk: {
    identifier: process.env.BLUESKY_GDD_IDENTIFIER,
    password: process.env.BLUESKY_GDD_APP_PASSWORD,
  },
  edge_studio: {
    identifier: process.env.BLUESKY_EDGE_IDENTIFIER,
    password: process.env.BLUESKY_EDGE_APP_PASSWORD,
  },
};

const ACCOUNT_ALIASES = {
  garrett_dev_desk: "garretts_dev_desk",
};

const agentCache = new Map();
const graphemeSegmenter = new Intl.Segmenter("en", {
  granularity: "grapheme",
});

function graphemeCount(text) {
  return [...graphemeSegmenter.segment(text)].length;
}

function canonicalAccount(name) {
  const requested = name ?? "garretts_dev_desk";
  const canonical = ACCOUNT_ALIASES[requested] ?? requested;

  if (!Object.hasOwn(ACCOUNTS, canonical)) {
    throw new Error(
      `Unknown account "${requested}". Allowed: ${[
        ...Object.keys(ACCOUNTS),
        ...Object.keys(ACCOUNT_ALIASES),
      ].join(", ")}`,
    );
  }

  return canonical;
}

function getJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
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
  if (agentCache.has(accountName)) {
    return agentCache.get(accountName);
  }

  const account = ACCOUNTS[accountName];

  if (!account.identifier || !account.password) {
    throw new Error(`Missing Bluesky credentials for "${accountName}".`);
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

// Split long text at paragraph, sentence, or whitespace boundaries.
function splitLongText(text) {
  if (graphemeCount(text) <= MAX_GRAPHEMES) {
    return [text];
  }

  const pieces = [];
  let remaining = text.trim();

  while (graphemeCount(remaining) > MAX_GRAPHEMES) {
    const graphemes = [...graphemeSegmenter.segment(remaining)].map(
      (part) => part.segment,
    );

    const prefix = graphemes.slice(0, MAX_GRAPHEMES).join("");

    let cut = -1;

    // Prefer a complete paragraph.
    const paragraph = prefix.lastIndexOf("\n\n");

    if (paragraph >= 80) {
      cut = paragraph + 2;
    }

    // Otherwise prefer a sentence boundary.
    if (cut < 0) {
      const matches = [...prefix.matchAll(/[.!?](?:["'”’)]*)\s+/g)];

      const candidate = matches.at(-1);

      if (candidate && candidate.index >= 80) {
        cut = candidate.index + candidate[0].length;
      }
    }

    // Otherwise split at whitespace.
    if (cut < 0) {
      const whitespace = [...prefix.matchAll(/\s+/g)].at(-1);

      if (whitespace && whitespace.index >= 80) {
        cut = whitespace.index + whitespace[0].length;
      }
    }

    // Handle unusually long unbroken strings.
    if (cut < 0) {
      cut = prefix.length;
    }

    const piece = remaining.slice(0, cut).trim();

    if (!piece) {
      throw new Error("Unable to split post text safely.");
    }

    pieces.push(piece);
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) {
    pieces.push(remaining);
  }

  return pieces;
}

function expandPosts(posts, id) {
  if (!Array.isArray(posts) || posts.length === 0) {
    throw new Error(`Post ${id} has no posts array.`);
  }

  const expanded = [];

  for (const text of posts) {
    if (typeof text !== "string" || !text.trim()) {
      throw new Error(`Post ${id} contains an empty or non-text segment.`);
    }

    expanded.push(...splitLongText(text));
  }

  return expanded;
}


async function uploadImages(agent, media = [], alt = []) {
  if (!Array.isArray(media) || !Array.isArray(alt)) {
    throw new Error("Media and alt must be arrays.");
  }

  if (!media.length) {
    return undefined;
  }

  if (media.length > 4) {
    throw new Error("Bluesky supports up to 4 images per post.");
  }

  if (alt.length && alt.length !== media.length) {
    throw new Error("Media and alt arrays must have the same length.");
  }

  const images = [];

  for (let i = 0; i < media.length; i++) {
    const mediaItem = media[i];

    let filePath;
    let altText;

    // Original Bluesky format: media is a file path string.
    if (typeof mediaItem === "string") {
      filePath = mediaItem;
      altText = alt[i] || "";
    }

    // Threads format: media is an object.
    else if (
      mediaItem !== null &&
      typeof mediaItem === "object" &&
      !Array.isArray(mediaItem)
    ) {
      const mediaType = mediaItem.type || "image";

      if (mediaType !== "image") {
        throw new Error(
          `Unsupported media type: ${mediaType}. This scheduler currently supports images only.`
        );
      }

      filePath = mediaItem.path;
      altText = mediaItem.alt ?? alt[i] ?? "";
    }

    // Reject unsupported media formats.
    else {
      throw new Error(`Invalid media entry at index ${i}.`);
    }

    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error(`Missing or invalid media path at index ${i}.`);
    }

    if (typeof altText !== "string") {
      throw new Error(`Invalid alt text at index ${i}.`);
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`Media file not found: ${filePath}`);
    }

    const encoding = getMimeType(filePath);

    if (DRY_RUN) {
      console.log(
        `DRY RUN image: ${filePath} (${encoding})`
      );
      console.log(`DRY RUN alt text: ${altText}`);
      continue;
    }

    console.log(`Uploading image: ${filePath}`);

    const uploaded = await agent.uploadBlob(
      fs.readFileSync(filePath),
      { encoding }
    );

    images.push({
      image: uploaded.data.blob,
      alt: altText,
    });
  }

  return DRY_RUN
    ? undefined
    : {
        $type: "app.bsky.embed.images",
        images,
      };
}


async function createPostRecord(agent, text, reply, embed) {
  const rt = new RichText({ text });

  if (!DRY_RUN) {
    await rt.detectFacets(agent);
  }

  if (rt.graphemeLength > MAX_GRAPHEMES) {
    throw new Error(`Expanded segment exceeds ${MAX_GRAPHEMES} graphemes.`);
  }

  const record = {
    text: rt.text,
    facets: rt.facets,
    createdAt: new Date().toISOString(),
  };

  if (reply) {
    record.reply = reply;
  }

  if (embed) {
    record.embed = embed;
  }

  if (DRY_RUN) {
    console.log("DRY RUN post:", JSON.stringify(record, null, 2));

    return {
      uri: `at://dry-run/${Date.now()}`,
      cid: `dry-run-${Date.now()}`,
    };
  }

  const result = await agent.post(record);

  return {
    uri: result.uri,
    cid: result.cid,
  };
}

async function postThread(item) {
  const accountName = canonicalAccount(item.account);
  const segments = expandPosts(item.posts, item.id);

  console.log(
    `Post ${item.id}: ${segments.length} Bluesky segment(s) to ${accountName}.`,
  );

  // Dry runs do not log in or upload media.
  const agent = DRY_RUN ? null : await getAgent(accountName);

  const embed = await uploadImages(agent, item.media ?? [], item.alt ?? []);

  let root = null;
  let parent = null;

  for (let i = 0; i < segments.length; i++) {
    const reply =
      i === 0
        ? undefined
        : {
            root,
            parent,
          };

    const result = await createPostRecord(
      agent,
      segments[i],
      reply,
      i === 0 ? embed : undefined,
    );

    if (i === 0) {
      root = result;
    }

    parent = result;
  }

  if (!DRY_RUN) {
    item.status = "posted";
    item.posted_at = new Date().toISOString();
    item.posted_account = accountName;
  }
}

const now = new Date();
let postedCount = 0;

for (const file of getJsonFiles(POSTS_DIR)) {
  const items = JSON.parse(fs.readFileSync(file, "utf8"));

  if (!Array.isArray(items)) {
    throw new Error(`${file} must contain a JSON array.`);
  }

  for (const item of items) {
    if (item.status !== "queued") {
      continue;
    }

    const scheduledAt = new Date(item.scheduled_at);

    if (Number.isNaN(scheduledAt.getTime())) {
      throw new Error(`Invalid scheduled_at for ${item.id} in ${file}.`);
    }

    if (scheduledAt > now) {
      continue;
    }

    console.log(`Processing ${item.id} from ${file}...`);

    await postThread(item);
    postedCount++;

    // Save completed items immediately.
    if (!DRY_RUN) {
      fs.writeFileSync(file, JSON.stringify(items, null, 2) + "\n");
    }
  }
}

console.log(
  `Finished. ${DRY_RUN ? "Previewed" : "Posted"} ${postedCount} item(s).`,
);

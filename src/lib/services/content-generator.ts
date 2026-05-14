import Anthropic from "@anthropic-ai/sdk";
import { composeForPost } from "@/lib/content/composer/compose";
import { runScrubber, runScrubberLite, type ScrubberReport } from "@/lib/content/scrubber";
import type { StyleProfile } from "@/lib/content/types";
import { generateHeroImage } from "@/lib/services/image-generator";

// Match the model used elsewhere in the project.
const CLAUDE_MODEL = "claude-sonnet-4-5";

// Sonnet 4.5 pricing — per-token (USD), not per-1K. Verify current rates at
// https://www.anthropic.com/pricing before relying on cost reporting.
// As of writing: $3 / 1M input tokens, $15 / 1M output tokens.
const PRICING = {
  inputPerToken: 0.000003,
  outputPerToken: 0.000015,
};

// Network-wide word-count policy. Single source of truth lives in
// src/lib/content/config.ts. Imported here so both the legacy
// (non-profile) generation path and the profile-driven path use the
// same range. Change those constants once to shift the policy
// everywhere.
import {
  GLOBAL_WORD_BAND_MAX,
  GLOBAL_WORD_BAND_MIN,
} from "@/lib/content/config";

const MIN_WORDS = GLOBAL_WORD_BAND_MIN;
const MAX_WORDS = GLOBAL_WORD_BAND_MAX;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Niche contexts ─────────────────────────────────────────────────────────

interface NicheContext {
  label: string;
  industry: string;
  defaultAudience: string;
  defaultBrandVoice: string;
  contentStyle: string;
  keyTopics: string[];
}

const NICHE_CONTEXTS: Record<string, NicheContext> = {
  reputation_sites: {
    label: "Good Reputation Sites & Reviews",
    industry: "Reputation Management",
    defaultAudience: "Business owners, consumers, marketers researching reviews",
    defaultBrandVoice: "professional and balanced, ethical consultant",
    contentStyle: "Balanced perspective addressing both business and consumer viewpoints, platform-specific details, ethical practices only",
    keyTopics: ["Trustpilot", "Yelp", "Google Reviews", "BBB", "G2", "review response", "fake reviews", "reputation management"],
  },
  peptides: {
    label: "Peptides & Performance Enhancement",
    industry: "Health & Performance",
    defaultAudience: "Bodybuilders, biohackers, anti-aging seekers, researchers, medical professionals",
    defaultBrandVoice: "scientific yet accessible, evidence-based",
    contentStyle: "Scientific credibility with E-A-T compliance, reference actual studies, acknowledge limitations, never recommend suppliers",
    keyTopics: ["BPC-157", "TB-500", "peptide protocols", "growth hormone", "tissue repair", "clinical research"],
  },
  gambling: {
    label: "Gambling & Sports Betting",
    industry: "Sports Betting",
    defaultAudience: "Casual bettors to sharp players seeking statistical analysis",
    defaultBrandVoice: "analytical, data-driven, responsible",
    contentStyle: "Statistical analysis over hot takes, acknowledge most bettors lose, responsible gambling framework, real odds examples",
    keyTopics: ["closing line value", "expected value", "bankroll management", "line movement", "betting strategy", "+EV spots"],
  },
  apps_marketing: {
    label: "Apps Marketing & Reviews",
    industry: "Mobile Apps & Software",
    defaultAudience: "App users, productivity seekers, buyers researching software",
    defaultBrandVoice: "honest reviewer, practical and helpful",
    contentStyle: "Test apps when possible, mention limitations honestly, real pricing, platform differences (iOS vs Android)",
    keyTopics: ["app reviews", "productivity apps", "app comparison", "mobile software", "app features", "user experience"],
  },
  exclusive_models: {
    label: "Creator Platforms & OnlyFans Business",
    industry: "Creator Economy",
    defaultAudience: "Aspiring creators, current creators, business researchers",
    defaultBrandVoice: "professional business advisor, entrepreneurial consultant",
    contentStyle: "Business-first framing not explicit content, frame as entrepreneurship, real numbers on fees and earnings, respect creator autonomy",
    keyTopics: ["OnlyFans", "Fansly", "creator monetization", "content marketing", "subscriber retention", "creator business", "platform fees"],
  },
  ecom_nails: {
    label: "Nails & Beauty E-commerce",
    industry: "Beauty & Cosmetics",
    defaultAudience: "Beginners to experienced home manicurists, beauty enthusiasts",
    defaultBrandVoice: "practical and experienced, helpful beauty enthusiast",
    contentStyle: "Correct product terminology, reference actual brands with real prices, include timing, describe looks specifically",
    keyTopics: ["gel polish", "nail art", "chrome powder", "builder gel", "manicure techniques", "nail products", "nail trends"],
  },
  soccer_jersey: {
    label: "Soccer Jerseys & Fan Merchandise",
    industry: "Sports Merchandise",
    defaultAudience: "Passionate fans, collectors, parents, gift buyers",
    defaultBrandVoice: "knowledgeable fan perspective, experienced collector",
    contentStyle: "Distinguish authentic vs replica vs counterfeit, use proper terminology (kit, strip), sizing by manufacturer, authentication methods",
    keyTopics: ["authentic jerseys", "replica jerseys", "soccer kits", "jersey sizing", "fan merchandise", "jersey collecting", "team jerseys"],
  },
  payment_processing: {
    label: "Payment Processing & Fintech",
    industry: "Financial Technology",
    defaultAudience: "Business owners, financial decision-makers, developers, e-commerce operators",
    defaultBrandVoice: "business consultant, fintech expert, technical advisor",
    contentStyle: "Use correct terminology (interchange, acquirer, PSP), real fee structures, include hidden costs, compliance requirements",
    keyTopics: ["Stripe", "Square", "payment gateway", "transaction fees", "PCI compliance", "merchant account", "payment integration"],
  },
  web_dev: {
    label: "Web Development",
    industry: "Software Development",
    defaultAudience: "Beginners to experienced developers evaluating tools and approaches",
    defaultBrandVoice: "experienced developer, pragmatic engineer",
    contentStyle: "Use current web standards, reference actual versions (React 18, Node 20), address trade-offs honestly, explain why not just how",
    keyTopics: ["React", "Next.js", "JavaScript", "web performance", "frameworks", "frontend development", "backend development"],
  },
  app_dev: {
    label: "App Development",
    industry: "Mobile Development",
    defaultAudience: "Entrepreneurs, business stakeholders, developers evaluating platforms",
    defaultBrandVoice: "realistic consultant, mobile development expert",
    contentStyle: "Balance business and technical perspectives, honest cost ranges and timelines, include ongoing costs, post-launch reality",
    keyTopics: ["React Native", "Flutter", "iOS development", "Android development", "app costs", "mobile development", "cross-platform"],
  },
  construction: {
    label: "Construction & B2B Services",
    industry: "Construction",
    defaultAudience: "Contractors, subcontractors, construction business owners, project managers",
    defaultBrandVoice: "industry veteran, construction business consultant",
    contentStyle: "Use correct construction terminology (GC, sub, bid process), real cost ranges, regulatory requirements, regional differences",
    keyTopics: ["commercial construction", "bidding strategy", "project management", "subcontractors", "construction business", "permits"],
  },
  loans: {
    label: "Loans & Lending",
    industry: "Financial Services",
    defaultAudience: "Borrowers researching options, credit rebuilders, financial education seekers",
    defaultBrandVoice: "responsible financial advisor, consumer advocate",
    contentStyle: "Use correct financial terminology (APR, LTV, DTI), show total cost not just monthly payment, address predatory lending red flags",
    keyTopics: ["personal loans", "mortgage", "APR", "interest rates", "credit score", "loan qualification", "debt consolidation"],
  },
};

const DEFAULT_NICHE: NicheContext = {
  label: "General",
  industry: "General",
  defaultAudience: "general audience",
  defaultBrandVoice: "professional and informative",
  contentStyle: "clear and engaging",
  keyTopics: [],
};

/**
 * Normalize a free-text niche string to one of the canonical NICHE_CONTEXTS keys.
 *
 * Admins type values like "Peptides", "PEPTIDES", "Web Dev", or "payment_processing"
 * — we lowercase, trim, and convert spaces/hyphens to underscores so any
 * reasonable input maps to the right context.
 */
export function normalizeNicheKey(niche: string | null | undefined): string | null {
  if (!niche) return null;
  return niche.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function getNicheContext(niche: string | null | undefined): NicheContext {
  const key = normalizeNicheKey(niche);
  if (!key) return DEFAULT_NICHE;
  return NICHE_CONTEXTS[key] ?? DEFAULT_NICHE;
}

export function getAvailableNiches(): Array<{ key: string; label: string }> {
  return Object.entries(NICHE_CONTEXTS).map(([key, ctx]) => ({ key, label: ctx.label }));
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type Tone = "professional" | "casual" | "friendly" | "authoritative" | "technical" | "warm";

export interface GenerateOptions {
  topic: string;
  keywords: string[];
  wordCount: number;
  tone: Tone;
  niche?: string | null;
  brandVoice?: string;
  targetAudience?: string;
  seoOptimized?: boolean;
  /**
   * When present, the composer uses this style profile to build the prompt
   * via the skeleton pipeline (overrides the niche-based default prompt).
   * The scrubber also runs profile-aware checks on the generated content.
   */
  styleProfile?: StyleProfile;
}

export interface GeneratedContent {
  title: string;
  content: string;
  excerpt: string;
  metaTitle: string;
  metaDescription: string;
  keywords: string[];
  wordCount: number;
}

export interface AnalysisScores {
  seoScore: number;
  readabilityScore: number;
  brandVoiceScore: number;
}

export interface GenerationResult extends GeneratedContent, AnalysisScores {
  tokensUsed: number;
  costUsd: number;
  heroImageUrl?: string;
  /** Scrubber audit trail, populated when scrubber runs. */
  scrubberReport?: ScrubberReport;
  /** True if scrubber flagged this post for admin review. */
  flaggedForReview?: boolean;
}

// ─── Claude wrapper ─────────────────────────────────────────────────────────

interface ClaudeCallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Bracket-aware JSON extraction. Walks the text from the first `{`, tracks
 * brace depth while ignoring braces inside string literals, and returns
 * the substring of the first complete top-level object.
 *
 * Handles every shape Claude has produced in the wild:
 *
 *   {...}                            ← clean
 *   ```json\n{...}\n```              ← markdown-fenced
 *   ```\n{...}\n```                  ← bare-fenced
 *   "Here is the JSON: {...} done."  ← prose-wrapped
 *   {...}\n```                       ← trailing fence
 *   \n  {...}\n{...}                 ← multiple objects (returns first)
 *
 * Unlike the previous naive "first { to last }" version, this never
 * mistakes a `}` inside a string value for the closing brace.
 */
function extractJsonObject(text: string): string {
  const startIdx = text.indexOf("{");
  if (startIdx === -1) return text.trim();

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.substring(startIdx, i + 1);
      }
    }
  }

  // Hit end without closing — response was truncated. Return what we have
  // so the caller can attempt repair / decide whether to retry.
  return text.substring(startIdx);
}

/**
 * Repair common LLM JSON issues that JSON.parse rejects but we can
 * confidently fix:
 *
 *   1. Trailing commas inside arrays / objects: `[1,2,3,]` → `[1,2,3]`
 *   2. Unescaped control chars inside strings: literal `\n`, `\r`, `\t`
 *      become escaped `\\n`, `\\r`, `\\t` (Claude sometimes embeds raw
 *      newlines in HTML content fields)
 *   3. Smart quotes around keys: `"key"` → `"key"`
 *
 * Things this does NOT fix (would require a real parser):
 *   - Unescaped double quotes inside string values
 *   - Comments
 *   - Single-quoted strings
 *
 * Caller falls back to retrying the Claude call if these heuristics
 * aren't enough.
 */
function repairLlmJson(text: string): string {
  // Smart quotes anywhere (Claude rarely produces these but it has)
  let result = text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");

  // Walk the text and escape literal control chars only inside string
  // literals (where they're invalid JSON). Outside strings they're just
  // whitespace and JSON.parse accepts them.
  let fixed = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < result.length; i++) {
    const ch = result[i];

    if (escape) {
      fixed += ch;
      escape = false;
      continue;
    }

    if (inString && ch === "\\") {
      fixed += ch;
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      fixed += ch;
      continue;
    }

    if (inString) {
      if (ch === "\n") {
        fixed += "\\n";
        continue;
      }
      if (ch === "\r") {
        fixed += "\\r";
        continue;
      }
      if (ch === "\t") {
        fixed += "\\t";
        continue;
      }
    }

    fixed += ch;
  }
  result = fixed;

  // Strip trailing commas: ", ]" → " ]", ", }" → " }". Regex is safe here
  // because we only target the comma followed by closing bracket; it
  // doesn't matter whether we're inside a string because LLMs essentially
  // never embed literal `, ]` patterns inside string values.
  result = result.replace(/,(\s*[\]}])/g, "$1");

  return result;
}

/**
 * Repair JSON that was TRUNCATED mid-output (Claude hit max_tokens before
 * closing the last string and the wrapping braces). Strategy:
 *
 *   1. Walk the text tracking string-context, escape-context, and the
 *      bracket stack ({ vs [).
 *   2. Find the last position where a complete key-value pair ended
 *      (i.e. a `,` at object depth, outside any string). This is the
 *      safe truncation point that keeps a valid JSON object.
 *   3. If found, truncate the text there and close all open brackets.
 *      The post loses the in-progress field but everything else parses.
 *   4. If no clean boundary found (very short response), close the
 *      open string + brackets as a last resort.
 *
 * The post will be shorter than the originally-requested word count, but
 * still publishable. The scrubber's word-count check (Layer 1F) catches
 * it and can request regeneration if needed.
 */
function repairTruncatedJson(text: string): string {
  let depth = 0;
  let inString = false;
  let escape = false;
  let lastSafeBoundary = -1; // position right BEFORE a `,` at object depth
  const stack: string[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      stack.push("{");
      depth++;
    } else if (ch === "[") {
      stack.push("[");
    } else if (ch === "}") {
      stack.pop();
      depth--;
    } else if (ch === "]") {
      stack.pop();
    } else if (
      ch === "," &&
      stack.length > 0 &&
      stack[stack.length - 1] === "{"
    ) {
      lastSafeBoundary = i;
    }
  }

  // If parse-state ended cleanly, the input is fine.
  if (!inString && depth === 0 && stack.length === 0) {
    return text;
  }

  // Prefer truncating at the last safe object-level comma boundary.
  let result: string;
  if (lastSafeBoundary > 0) {
    result = text.substring(0, lastSafeBoundary);
  } else {
    result = text;
    // Close any in-progress string.
    if (inString) result += '"';
  }

  // Recount open brackets at the truncated position and close them.
  let d = 0;
  let inStr = false;
  let esc = false;
  const closeStack: string[] = [];
  for (let i = 0; i < result.length; i++) {
    const ch = result[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      closeStack.push("{");
      d++;
    } else if (ch === "[") closeStack.push("[");
    else if (ch === "}") {
      closeStack.pop();
      d--;
    } else if (ch === "]") closeStack.pop();
  }
  if (inStr) result += '"';
  while (closeStack.length > 0) {
    const open = closeStack.pop();
    result += open === "{" ? "}" : "]";
  }

  return result;
}

/**
 * Try JSON.parse on:
 *   1. The raw text                  (the happy path)
 *   2. Light repair                  (smart quotes, trailing commas, control chars)
 *   3. Truncation repair             (closes unterminated strings + braces)
 *
 * Returns the parsed value or throws the original error with a helpful
 * preview of where parsing failed.
 */
export function safeParseClaudeJson<T = unknown>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (err1) {
    // Try light repair (smart quotes, trailing commas, escape control chars)
    try {
      return JSON.parse(repairLlmJson(text)) as T;
    } catch {
      // Try truncation repair — close unterminated strings + braces, then
      // also run the light repair on the recovered shape.
      try {
        const recovered = repairTruncatedJson(text);
        return JSON.parse(repairLlmJson(recovered)) as T;
      } catch {
        // All repairs failed — surface the original error with context.
        const msg = err1 instanceof Error ? err1.message : "JSON parse failed";
        const match = /position\s+(\d+)/i.exec(msg);
        if (match) {
          const pos = parseInt(match[1], 10);
          const start = Math.max(0, pos - 80);
          const end = Math.min(text.length, pos + 80);
          const around = text.slice(start, end).replace(/\s+/g, " ").trim();
          throw new Error(
            `${msg} | context near pos ${pos}: "...${around}..."`,
          );
        }
        throw err1;
      }
    }
  }
}

/**
 * Returns true when an Anthropic SDK error is worth retrying. We treat
 * 429 (rate limit), 500/502/503/504 (server), 529 (overloaded), and
 * network / timeout / connection-reset errors as transient. 4xx other
 * than 429 are permanent (bad request, auth, etc.) and bubble up.
 */
function isTransientClaudeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { status?: number; type?: string };
  if (e.status !== undefined) {
    if (e.status === 429 || e.status === 529) return true;
    if (e.status >= 500 && e.status < 600) return true;
  }
  const msg = err.message.toLowerCase();
  if (
    msg.includes("rate limit") ||
    msg.includes("overloaded") ||
    msg.includes("timeout") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("internal server error")
  ) {
    return true;
  }
  return false;
}

const MAX_CLAUDE_RETRIES = 3;
const CLAUDE_BACKOFF_BASE_MS = 2000; // 2s, 4s, 8s

async function callClaudeOnce(
  system: string,
  userMessage: string,
  options: { maxTokens?: number; temperature?: number; expectJson?: boolean },
): Promise<ClaudeCallResult> {
  const { maxTokens = 4000, temperature = 0.7, expectJson = false } = options;

  const finalSystem = expectJson
    ? `${system}\n\nCRITICAL OUTPUT FORMAT:
- Respond with valid JSON only. Start with { and end with }.
- No markdown code fences. No \`\`\`json blocks. No prose before or after.
- Stay STRICTLY UNDER any maximum word count specified above. Hitting the maximum exactly often causes the response to be truncated mid-string, breaking the JSON. Aim for the target, not the ceiling.
- Close every JSON string properly before the response ends. If you sense you're approaching the token budget, wrap up the current section and close the object — a shorter complete article is better than a longer truncated one.`
    : system;

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    temperature,
    system: finalSystem,
    messages: [{ role: "user", content: userMessage }],
  });

  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("Claude returned no text content");
  }

  const rawText = block.text;
  // Always extract the JSON object when caller expects JSON. The previous
  // implementation only stripped when text didn't start with `{`, missing
  // cases where Claude wrapped output in markdown fences but the first
  // non-whitespace char appeared to be `{` (or vice versa).
  const text = expectJson ? extractJsonObject(rawText) : rawText.trim();

  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

/**
 * Public Claude wrapper with automatic retry on transient errors. Each
 * generation in this app makes 2-3 Claude calls (article, scene summary,
 * analysis); when scaling to thousands of blogs/day the network will hit
 * occasional 429s and 529 (overloaded). Without retry every transient
 * blip turned into a failed post.
 *
 * Retry budget: up to MAX_CLAUDE_RETRIES additional attempts with
 * exponential backoff (2s, 4s, 8s). Total worst-case wait: 14s + 3 calls.
 */
async function callClaude(
  system: string,
  userMessage: string,
  options: { maxTokens?: number; temperature?: number; expectJson?: boolean } = {},
): Promise<ClaudeCallResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_CLAUDE_RETRIES; attempt++) {
    try {
      return await callClaudeOnce(system, userMessage, options);
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_CLAUDE_RETRIES) break;
      if (!isTransientClaudeError(err)) break;
      const delayMs = CLAUDE_BACKOFF_BASE_MS * Math.pow(2, attempt);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[claude] Transient error (attempt ${attempt + 1}/${MAX_CLAUDE_RETRIES + 1}), retrying in ${delayMs}ms: ${msg.slice(0, 200)}`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

function calcCost(inputTokens: number, outputTokens: number): number {
  return (
    inputTokens * PRICING.inputPerToken + outputTokens * PRICING.outputPerToken
  );
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

function convertMarkdownToHtml(content: string): string {
  return content
    .replace(/^######\s+(.+)$/gm, "<h6>$1</h6>")
    .replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>")
    .replace(/^####\s+(.+)$/gm, "<h4>$1</h4>")
    .replace(/^###\s+(.+)$/gm, "<h3>$1</h3>")
    .replace(/^##\s+(.+)$/gm, "<h2>$1</h2>")
    .replace(/^#\s+(.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, "<em>$1</em>");
}

function sanitizeMetadata(html: string): string {
  return html
    .replace(/<p>\s*Created:\s*.+?<\/p>/gi, "")
    .replace(/<p>\s*Niche:\s*.+?<\/p>/gi, "")
    .replace(/<p>\s*Keywords?:\s*.+?<\/p>/gi, "")
    .replace(/<p>\s*<em>Discover\s+.+?<\/em>\s*<\/p>/gi, "")
    .replace(/<p>\s*<\/p>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strip any Claude-emitted image tags (they'd have placeholder or hallucinated
 * URLs that 404). We attach a real hero image as a featured image at publish
 * time instead.
 */
function stripClaudeImages(html: string): string {
  return html
    .replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, "")
    .replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, "")
    .replace(/<img\b[^>]*\/?>/gi, "")
    .replace(/<source\b[^>]*\/?>/gi, "")
    .replace(/<figcaption\b[^>]*>[\s\S]*?<\/figcaption>/gi, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/<p>\s*<\/p>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Soft word-count enforcement: if Claude ignored the upper bound, trim down to
 * the last word that still fits within MAX_WORDS. We never pad shorts — that's
 * the prompt's job.
 */
function capWordCount(html: string, max: number): string {
  const words = html.split(/(\s+)/);
  let count = 0;
  let i = 0;
  for (; i < words.length; i++) {
    if (words[i].trim()) {
      count++;
      if (count > max) break;
    }
  }
  if (count <= max) return html;
  const truncated = words.slice(0, i).join("");
  const openTags = (truncated.match(/<p>/gi) || []).length;
  const closeTags = (truncated.match(/<\/p>/gi) || []).length;
  return openTags > closeTags ? truncated + "</p>" : truncated;
}

function countWordsInHtml(html: string): number {
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.split(" ").filter((w) => w.length > 0).length : 0;
}

function generateExcerpt(content: string): string {
  const text = content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 160 ? text.substring(0, 157) + "..." : text;
}

// Hero-image URL generation lives in image-generator.ts. The composer here
// also runs a small Claude call (summarizeArticleAsScene below) that turns
// the freshly-written article body into a concrete photographic scene
// description, which then gets passed to the image model as a customPrompt.
// This is what makes the hero image actually match the post's topic instead
// of falling back to whatever generic visual theme the style profile has.

/**
 * Use Claude to convert an article into a single-sentence photographic scene
 * description suitable for Nano Banana / Imagen. The call is small (~200
 * output tokens) and adds ~2-4s and ~$0.001 to total generation cost. In
 * exchange, the image becomes content-aware instead of theme-locked.
 *
 * Returns null on any failure so the caller falls back to the static
 * scene-builder in image-generator.buildImagePrompt().
 */
async function summarizeArticleAsScene(
  title: string,
  bodyHtml: string,
  keywords: string[],
): Promise<string | null> {
  // Strip HTML and take the first ~2000 chars — enough to identify the
  // article's actual subject without paying for the whole body's tokens.
  const plain = bodyHtml
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);

  const system = `You write image-generation prompts for editorial documentary photography. Given an article, you describe ONE concrete photographic scene that would accompany it as a hero image.

Constraints — every prompt MUST:
- Name a specific, real-world physical environment (clinic interior, gym, lab bench, bedroom, kitchen counter, mountain trail, etc.)
- Name specific concrete objects in the frame (not abstract concepts)
- Specify lighting (window light, golden hour, overhead industrial, moonlight, etc.)
- Specify camera angle / composition (low angle, overhead flat-lay, macro close-up, wide shot, etc.)

Constraints — every prompt MUST NOT include:
- Bottles, vials, jars, ampoules, syringes, pills, or pharmaceutical packaging
- Shelves with bottles arranged on them
- Skincare flat-lays or "wellness aesthetic" still lifes
- Identifiable human faces
- Text, labels, logos, or watermarks
- Words like "wellness", "luxury", "premium", or "boutique"

The scene should visually evoke the article's actual subject matter — if the article is about ligament repair, show a rehab clinic; if about growth hormone for performance, show a strength gym; if about sleep, show a bedroom at night.

Output: ONE sentence, 25-60 words, describing the scene. Plain text only. No quotes, no preamble.`;

  const user = `ARTICLE TITLE: ${title}

KEYWORDS: ${keywords.slice(0, 8).join(", ")}

ARTICLE EXCERPT (first ~2000 chars):
${plain}

Describe the photographic scene for the hero image.`;

  try {
    const { text } = await callClaude(system, user, {
      maxTokens: 200,
      temperature: 0.8,
    });
    const cleaned = text.trim().replace(/^["']|["']$/g, "");
    if (cleaned.length < 20 || cleaned.length > 600) return null;
    return cleaned;
  } catch (err) {
    console.warn("[content-generator] Scene summarization failed:", err);
    return null;
  }
}

// ─── Prompt builders ────────────────────────────────────────────────────────

function getNicheRequirements(niche: string): string {
  const key = normalizeNicheKey(niche) ?? "";
  const requirements: Record<string, string> = {
    peptides: `Reference actual published studies. Use proper terminology with explanations. Cite dosage ranges from research, not anecdotes. Acknowledge limitations and unknowns. Distinguish between animal studies, human trials, and theoretical applications. Include medical disclaimers. Never recommend sources or suppliers. Be clear about regulatory status.`,
    gambling: `Use real odds examples and specific numbers. Reference statistical concepts accurately (EV, variance, ROI, CLV). Acknowledge most bettors lose long-term. Include responsible gambling framework naturally. Never promote betting as guaranteed income. Quantify when possible.`,
    web_dev: `Reference actual tools and versions (React 18, Node 20 LTS). Address real trade-offs. Include both happy path and common issues. Compare modern vs legacy approaches honestly. Mention browser compatibility when relevant.`,
    payment_processing: `Use correct terminology (interchange, acquirer, PSP, basis points). Cite actual fee structures with real numbers. Include hidden fees and contract terms. Address compliance requirements (PCI DSS). Acknowledge regional regulatory differences.`,
    loans: `Use correct financial terminology (APR, LTV, DTI). Show total cost of loan, not just monthly payment. Address predatory lending red flags. Include qualification requirements honestly. Distinguish between loan types and their implications.`,
    construction: `Use correct construction terminology (GC, sub, bid process). Include real cost ranges by project scale. Reference regulatory requirements (permits, OSHA, prevailing wage). Acknowledge regional differences. Address business-side concerns (cash flow, payment terms).`,
    reputation_sites: `Reference actual platforms (Trustpilot, Yelp, Google Reviews, BBB, G2). Address both business and consumer viewpoints. Never promote fake review services or manipulation. Distinguish authentic reviews from suspicious patterns. Focus on ethical response strategies.`,
    apps_marketing: `Include actual pricing and version numbers. Acknowledge platform differences (iOS vs Android). Mention real limitations and bugs honestly. Reference actual user feedback. Compare based on what people care about: speed, reliability, cost, privacy.`,
    exclusive_models: `Frame as creator entrepreneurship, not explicit content. Focus on marketing, monetization, branding. Include real platform fees and earnings ranges. Respect creator autonomy. Address platform risks honestly. Never overpromise income potential.`,
    ecom_nails: `Use correct product terminology (gel polish vs builder gel). Reference actual brands with real prices. Include timing (cure times, wear duration). Describe looks specifically with shade names and finish types. Address nail health honestly.`,
    soccer_jersey: `Distinguish authentic vs replica vs counterfeit. Reference actual manufacturers (Nike, Adidas, Puma). Use proper terminology (kit, strip, home/away/third). Address sizing by manufacturer. Never promote counterfeit sources.`,
    app_dev: `Distinguish native (Swift/Kotlin), cross-platform (React Native/Flutter), hybrid. Include realistic cost ranges and timelines. Cover iOS and Android considerations. Address ongoing costs (hosting, APIs, maintenance). Acknowledge market saturation.`,
  };
  return requirements[key] || "";
}

function buildSystemPrompt(opts: GenerateOptions): string {
  const niche = getNicheContext(opts.niche);
  const brandVoice = opts.brandVoice || niche.defaultBrandVoice;
  const audience = opts.targetAudience || niche.defaultAudience;
  // Clamp the caller's requested word count into [MIN_WORDS, MAX_WORDS].
  const targetWords = Math.max(MIN_WORDS, Math.min(MAX_WORDS, opts.wordCount));

  let prompt = `You are an expert content writer in the ${niche.industry} space. Write a comprehensive, original article that reads like it was written by someone with deep first-hand experience.

VOICE & STYLE:
- Brand voice: ${brandVoice}
- Audience: ${audience}
- Tone: ${opts.tone}
- Style: ${niche.contentStyle}

QUALITY BAR:
- Specific over generic — exact prices, real brand/tool names, concrete numbers
- Show your reasoning, don't just assert
- Mix sentence lengths; avoid the AI cadence of perfect 3-4 sentence paragraphs
- Include trade-offs and limitations honestly, not just upsides
- No filler transitions like "Moreover," "Furthermore," "In conclusion"

WORD COUNT (HARD LIMITS):
- Minimum ${MIN_WORDS} words — anything shorter will be rejected
- Maximum ${MAX_WORDS} words — anything longer will be truncated
- Target approximately ${targetWords} words
- Depth over padding; trim ruthlessly before exceeding the cap

IMAGES:
- Do NOT include any <img>, <figure>, <picture>, or <figcaption> tags in your
  output. A hero image is attached as the article's featured image at publish
  time — any inline images you emit will be stripped.

STRUCTURE:
- Open with a substantive hook (no "In today's world..." openings)
- Use <h2> for major sections, <h3> for subsections
- Lists where useful, not where padding
- Close with concrete takeaways, not platitudes

OUTPUT FORMAT:
Return ONLY valid JSON:
{
  "title": "Title under 60 characters with primary keyword",
  "content": "Full HTML article between ${MIN_WORDS} and ${MAX_WORDS} words",
  "excerpt": "150-160 character summary",
  "metaTitle": "SEO title under 60 characters",
  "metaDescription": "150-160 character meta description",
  "keywords": ["keyword1", "keyword2", "keyword3"]
}

The "content" field is HTML ONLY, using this whitelist of tags: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <a>. Do not include "Created:", "Niche:", or "Keywords:" labels inline in the body.`;

  const nicheReqs = opts.niche ? getNicheRequirements(opts.niche) : "";
  if (nicheReqs) {
    prompt += `\n\nNICHE-SPECIFIC REQUIREMENTS:\n${nicheReqs}`;
  }

  if (opts.seoOptimized) {
    prompt += `\n\nSEO REQUIREMENTS:
- Primary keyword in title and first 100 words
- Related keywords in <h2> subheadings
- Natural keyword density 1-2% (no stuffing)`;
  }

  return prompt;
}

function buildUserPrompt(opts: GenerateOptions): string {
  return `Write the article.

Topic: ${opts.topic}
Target keywords: ${opts.keywords.join(", ") || "(infer from topic)"}

Begin now. Return only the JSON object.`;
}

// ─── Topic ideation (used by cron auto-publish) ─────────────────────────────

export async function ideateTopic(
  niche: string | null | undefined,
  recentTitles: string[],
): Promise<{ topic: string; keywords: string[] }> {
  const ctx = getNicheContext(niche);
  const recentList = recentTitles.length
    ? recentTitles.slice(0, 20).map((t) => `- ${t}`).join("\n")
    : "(none yet)";

  const system = `You generate fresh blog post topic ideas for a ${ctx.industry} niche site (${ctx.label}). Suggest topics that:
- Cover the niche's key topics: ${ctx.keyTopics.join(", ")}
- Do NOT overlap with recent titles
- Have clear search intent
- Are specific (not generic listicles)

Return JSON only:
{ "topic": "Specific topic for the article", "keywords": ["kw1", "kw2", "kw3"] }`;

  const user = `Recent titles on this site (avoid duplicating these):
${recentList}

Suggest the next post's topic.`;

  const { text } = await callClaude(system, user, {
    maxTokens: 300,
    temperature: 0.9,
    expectJson: true,
  });

  try {
    const parsed = safeParseClaudeJson<{ topic?: unknown; keywords?: unknown }>(text);
    return {
      topic: String(parsed.topic || "").slice(0, 500),
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "parse error";
    throw new Error(
      `Topic ideation returned invalid JSON: ${msg} | response preview: ${text.slice(0, 200)}`,
    );
  }
}

// ─── Analysis (combined SEO/readability/brand voice) ────────────────────────

interface AnalysisOutcome {
  scores: AnalysisScores;
  inputTokens: number;
  outputTokens: number;
}

async function analyzeContent(
  content: string,
  title: string,
  opts: GenerateOptions,
): Promise<AnalysisOutcome> {
  const truncated = content.length > 3000 ? content.substring(0, 3000) + "..." : content;
  const scores: AnalysisScores = { seoScore: 60, readabilityScore: 65, brandVoiceScore: 65 };

  const system = `You evaluate written content on three dimensions and return numeric scores 1-100.

SEO SCORE (1-100):
- Primary keyword in title, first paragraph, headings
- Natural keyword density 1-3%
- Heading hierarchy and content structure
- Search intent alignment
- Title length under 60 chars; meta description 150-160 chars

READABILITY SCORE (1-100):
- Average sentence length under 20 words
- Sentence length variety
- Active voice
- Clear paragraph structure and transitions
- Vocabulary appropriate to audience

BRAND VOICE SCORE (1-100):
- Maintains specified tone throughout
- Word choice matches brand voice
- Audience appropriateness
- Authority level matches positioning

Return ONLY JSON: { "seoScore": number, "readabilityScore": number, "brandVoiceScore": number }`;

  const user = `Evaluate this content.

TITLE: ${title}
TARGET KEYWORDS: ${opts.keywords.join(", ")}
SPECIFIED TONE: ${opts.tone}
BRAND VOICE: ${opts.brandVoice || "(use tone)"}
TARGET AUDIENCE: ${opts.targetAudience || "general audience"}

CONTENT:
${truncated}`;

  try {
    const { text, inputTokens, outputTokens } = await callClaude(system, user, {
      maxTokens: 200,
      temperature: 0.1,
      expectJson: true,
    });
    const parsed = safeParseClaudeJson<{
      seoScore?: number;
      readabilityScore?: number;
      brandVoiceScore?: number;
    }>(text);
    if (typeof parsed.seoScore === "number") {
      scores.seoScore = Math.max(1, Math.min(100, Math.round(parsed.seoScore)));
    }
    if (typeof parsed.readabilityScore === "number") {
      scores.readabilityScore = Math.max(1, Math.min(100, Math.round(parsed.readabilityScore)));
    }
    if (typeof parsed.brandVoiceScore === "number") {
      scores.brandVoiceScore = Math.max(1, Math.min(100, Math.round(parsed.brandVoiceScore)));
    }
    return { scores, inputTokens, outputTokens };
  } catch (err) {
    console.warn("Content analysis failed, using fallback scores:", err);
    return { scores, inputTokens: 0, outputTokens: 0 };
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function generateContent(opts: GenerateOptions): Promise<GenerationResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }

  // Branch on whether the blog has a locked style profile.
  //   - With profile (peptide blogs): use skeleton-composer + profile-aware scrubber
  //   - Without profile (other niches): use the existing niche-based prompt +
  //     scrubber-lite (punctuation + AI-tells, no compliance enforcement)
  const usingProfile = Boolean(opts.styleProfile);

  let system: string;
  let user: string;
  let maxTokens: number;
  if (usingProfile && opts.styleProfile) {
    const composed = composeForPost({
      profile: opts.styleProfile,
      topic: opts.topic,
      // For universal-niche profiles, pass the blog's actual niche label
      // (e.g. "gym marketing") so the prompt's {sub_niche} placeholder
      // gets a topical value instead of the generic "General Content".
      nicheLabel: opts.niche,
    });
    system = composed.systemPrompt;
    user = composed.userPrompt;
    // Profile blogs may target word bands up to 3000 words. Schema C (FAQ-
    // rich) and Schema D (listicle) include extra structured arrays beyond
    // the main content, so we budget generously: ~3.0 tokens/word covers
    // prose + JSON envelope + nested arrays + HTML tags + extra safety
    // margin against unicode-heavy content (peptide compound names, citations
    // with accents, etc. all cost more tokens per char). Cap at 8192 —
    // Sonnet 4.5's max output. The strict word-count directive in the
    // system prompt now also tells Claude to stay under the ceiling rather
    // than hit it exactly, which together with the bigger budget eliminates
    // mid-string truncation for almost all posts.
    maxTokens = Math.min(8192, Math.round(opts.styleProfile.wordBandMax * 3.0));
  } else {
    system = buildSystemPrompt(opts);
    user = buildUserPrompt(opts);
    maxTokens = 4000;
  }

  // 1. Generate
  const {
    text,
    inputTokens: genInput,
    outputTokens: genOutput,
  } = await callClaude(system, user, {
    maxTokens,
    temperature: 0.7,
    expectJson: true,
  });

  // 2. Parse — safeParseClaudeJson tries direct then repaired (handles
  //    trailing commas, unescaped newlines in content fields, smart quotes).
  let parsed: Partial<GeneratedContent>;
  try {
    parsed = safeParseClaudeJson<Partial<GeneratedContent>>(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "parse error";
    throw new Error(`Claude returned invalid JSON: ${msg}`);
  }

  if (!parsed.title || !parsed.content) {
    throw new Error("Claude response missing required fields (title, content)");
  }

  // 3. Format + sanitize, strip any Claude-emitted images (they'd be broken).
  //    Word-count enforcement here is the legacy hard MIN_WORDS check; for
  //    profile blogs the scrubber's Layer 1F handles word-band checks.
  let body = parsed.content;
  if (body.includes("#")) body = convertMarkdownToHtml(body);
  body = sanitizeMetadata(body);
  body = stripClaudeImages(body);

  if (!usingProfile) {
    body = capWordCount(body, MAX_WORDS);
    const wordCount = countWordsInHtml(body);
    if (wordCount < MIN_WORDS) {
      throw new Error(
        `Generated content is ${wordCount} words, below the ${MIN_WORDS}-word minimum`,
      );
    }
  }

  // 4. Scrubber — profile-aware when a profile exists, lite otherwise.
  let scrubberReport: ScrubberReport | undefined;
  let flaggedForReview = false;
  if (usingProfile && opts.styleProfile) {
    const result = runScrubber({
      content: body,
      profile: opts.styleProfile,
    });
    body = result.content;
    scrubberReport = result.report;
    flaggedForReview = result.flaggedForReview;
  } else {
    // Lite path — auto-fix punctuation + log AI-tell hits but don't gate.
    const lite = runScrubberLite(body);
    body = lite.content;
  }

  const wordCount = countWordsInHtml(body);

  // 5. Compute the hero image URL via Google Nano Banana.
  //    Strategy: run a small Claude call to summarize the article body into
  //    a concrete photographic scene description, then pass that to Nano
  //    Banana as a customScene. This makes the image content-aware (the
  //    scene actually matches what THIS article is about) instead of
  //    falling back to the blog's locked sub-niche theme for every post.
  //    Falls back to the static scene builder if the summary call fails.
  //    Output is always a data: URI — Shopify and WordPress decode it
  //    inline at publish time. No fallback provider.
  const imageKeywords =
    parsed.keywords && parsed.keywords.length > 0 ? parsed.keywords : opts.keywords;
  let heroImageUrl: string | undefined;
  try {
    const customScene = await summarizeArticleAsScene(
      parsed.title,
      body,
      imageKeywords,
    );
    if (customScene) {
      console.info(
        `[content-generator] Image scene: "${customScene.slice(0, 100)}${customScene.length > 100 ? "…" : ""}"`,
      );
    }
    const img = await generateHeroImage({
      title: parsed.title,
      keywords: imageKeywords,
      niche: opts.niche,
      subNicheId: opts.styleProfile?.subNicheId,
      primaryCompounds: opts.styleProfile?.primaryCompounds,
      customScene: customScene ?? undefined,
    });
    heroImageUrl = img.url;
    console.info(
      `[content-generator] Hero image generated via ${img.model} for "${parsed.title.slice(0, 60)}"`,
    );
  } catch (err) {
    // Image generation failed — log the real error and ship the post
    // without a hero image rather than substituting an unrelated placeholder.
    console.error("[content-generator] Hero image generation failed:", err);
    heroImageUrl = undefined;
  }

  // 6. Analyze (single combined call)
  const {
    scores,
    inputTokens: analyzeInput,
    outputTokens: analyzeOutput,
  } = await analyzeContent(body, parsed.title, opts);

  const totalInputTokens = genInput + analyzeInput;
  const totalOutputTokens = genOutput + analyzeOutput;
  const totalTokens = totalInputTokens + totalOutputTokens;
  const costUsd = calcCost(totalInputTokens, totalOutputTokens);

  return {
    title: parsed.title,
    content: body,
    excerpt: parsed.excerpt || generateExcerpt(body),
    metaTitle: parsed.metaTitle || parsed.title,
    metaDescription: parsed.metaDescription || generateExcerpt(body),
    keywords: parsed.keywords && parsed.keywords.length > 0 ? parsed.keywords : opts.keywords,
    wordCount,
    seoScore: scores.seoScore,
    readabilityScore: scores.readabilityScore,
    brandVoiceScore: scores.brandVoiceScore,
    tokensUsed: totalTokens,
    costUsd: Number(costUsd.toFixed(6)),
    heroImageUrl,
    scrubberReport,
    flaggedForReview,
  };
}
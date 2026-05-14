import axios, { type AxiosInstance, type AxiosError } from "axios";
import type {
  ConnectionResult,
  PublishPostInput,
  PublishPostResult,
} from "@/lib/types";
import { getClientCredentialsToken } from "./shopify-token-cache";

const DEFAULT_API_VERSION = "2024-07";
const DEFAULT_TIMEOUT_MS = 15000;
const PUBLISH_TIMEOUT_MS = 30000; // longer for image fetching

export type ShopifyCreds =
  | { mode: "legacy_token"; storeUrl: string; adminToken: string }
  | {
      mode: "client_credentials";
      storeUrl: string;
      clientId: string;
      clientSecret: string;
    };

export interface ShopifyArticle {
  id: number;
  title: string;
  body_html: string;
  author: string;
  blog_id: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  handle: string;
  tags: string;
  summary_html: string | null;
  user_id: number | null;
  template_suffix: string | null;
}

export interface ShopifyBlog {
  id: number;
  title: string;
  handle: string;
  created_at: string;
  updated_at: string;
}

export interface ShopifyShop {
  id: number;
  name: string;
  email: string;
  domain: string;
  myshopify_domain: string;
  plan_name: string;
  plan_display_name: string;
}

function normalizeStoreUrl(storeUrl: string): string {
  let url = storeUrl.trim().replace(/\/+$/, "");
  url = url.replace(/^https?:\/\//i, "");
  return url;
}

async function resolveAccessToken(creds: ShopifyCreds): Promise<string> {
  if (creds.mode === "legacy_token") return creds.adminToken;
  const shop = normalizeStoreUrl(creds.storeUrl);
  const { token } = await getClientCredentialsToken({
    shop,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
  });
  return token;
}

async function createClient(
  creds: ShopifyCreds,
  apiVersion: string = DEFAULT_API_VERSION,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<AxiosInstance> {
  const host = normalizeStoreUrl(creds.storeUrl);
  const token = await resolveAccessToken(creds);

  const client = axios.create({
    baseURL: `https://${host}/admin/api/${apiVersion}`,
    timeout: timeoutMs,
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
  });

  // 429 retry interceptor honoring Retry-After header (single retry)
  client.interceptors.response.use(
    (res) => res,
    async (err: AxiosError) => {
      const cfg = err.config as (typeof err.config & { __retried?: boolean }) | undefined;
      if (err.response?.status === 429 && cfg && !cfg.__retried) {
        const retryAfter = Number(err.response.headers["retry-after"] ?? 2);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        cfg.__retried = true;
        return client.request(cfg);
      }
      return Promise.reject(err);
    },
  );

  return client;
}

function formatError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axiosErr = error as AxiosError<{
      errors?: string | Record<string, string[]>;
    }>;
    if (axiosErr.response) {
      const status = axiosErr.response.status;
      const data = axiosErr.response.data;
      if (status === 401) {
        return "Authentication failed. Check your Shopify credentials.";
      }
      if (status === 403) {
        return "Token lacks required scopes. Enable read_content and write_content for blog articles.";
      }
      if (status === 404) {
        return "Shopify store or resource not found. Verify the store URL.";
      }
      if (status === 429) {
        return "Shopify rate limit hit. Try again shortly.";
      }
      if (typeof data?.errors === "string") return data.errors;
      if (data?.errors && typeof data.errors === "object") {
        return Object.entries(data.errors)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
          .join("; ");
      }
      return `Shopify returned HTTP ${status}`;
    }
    if (axiosErr.code === "ECONNABORTED") {
      return "Connection timed out. Shopify may be slow or unreachable.";
    }
    if (axiosErr.code === "ENOTFOUND" || axiosErr.code === "ECONNREFUSED") {
      return "Cannot reach the Shopify store. Check the store URL.";
    }
    return axiosErr.message;
  }
  if (error instanceof Error) return error.message;
  return "An unknown error occurred";
}

/**
 * Fetch an image from any URL (following redirects) and return it as base64
 * so it can be sent inline as `article.image.attachment`. This avoids letting
 * Shopify's image fetcher deal with redirects, signed/expiring URLs, or
 * placeholder services like picsum that 302 to a CDN host.
 *
 * Returns null on any failure — caller can fall back to passing the URL as
 * `src` (which works for some direct image URLs).
 */
async function fetchImageAsBase64(url: string): Promise<{
  attachment: string;
  filename: string;
} | null> {
  const extMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/pjpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
  };

  // Fast path: data: URI from Imagen. Decode inline without an HTTP fetch.
  // Format: data:<mediatype>;base64,<data>
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;,]+)(;base64)?,(.+)$/);
    if (!match) {
      console.warn(`[shopify] Malformed data URI`);
      return null;
    }
    const mime = match[1].toLowerCase();
    const isBase64 = Boolean(match[2]);
    if (!mime.startsWith("image/")) {
      console.warn(`[shopify] data: URI not an image (${mime})`);
      return null;
    }
    const ext = extMap[mime] ?? "jpg";
    const filename = `featured-${Date.now()}.${ext}`;
    if (isBase64) {
      return { attachment: match[3], filename };
    }
    const buf = Buffer.from(decodeURIComponent(match[3]), "binary");
    return { attachment: buf.toString("base64"), filename };
  }

  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      console.warn(`[shopify] Image fetch failed (${res.status}): ${url}`);
      return null;
    }

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("image/")) {
      console.warn(`[shopify] Not an image (${contentType}): ${url}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 100) {
      console.warn(
        `[shopify] Image suspiciously small (${buffer.length}b): ${url}`,
      );
      return null;
    }

    const mime = contentType.split(";")[0].trim();
    const ext = extMap[mime] ?? "jpg";
    const filename = `featured-${Date.now()}.${ext}`;

    return {
      attachment: buffer.toString("base64"),
      filename,
    };
  } catch (err) {
    console.warn(`[shopify] Image fetch threw: ${url}`, err);
    return null;
  }
}

/**
 * Verify Shopify credentials by hitting the shop info endpoint.
 */
export async function testConnection(
  creds: ShopifyCreds,
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<ConnectionResult> {
  try {
    const client = await createClient(creds, apiVersion);
    const res = await client.get<{ shop: ShopifyShop }>("/shop.json");
    const shop = res.data.shop;
    return {
      success: true,
      platform: "shopify",
      message: `Connected to ${shop.name} (${shop.myshopify_domain})`,
      shopifyStoreName: shop.name,
      shopifyPlan: shop.plan_display_name,
    };
  } catch (error) {
    return {
      success: false,
      platform: "shopify",
      message: formatError(error),
    };
  }
}

export async function listBlogs(
  creds: ShopifyCreds,
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<ShopifyBlog[]> {
  const client = await createClient(creds, apiVersion);
  const res = await client.get<{ blogs: ShopifyBlog[] }>("/blogs.json");
  return res.data.blogs;
}

export async function getBlog(
  creds: ShopifyCreds,
  blogId: string,
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<ShopifyBlog | null> {
  try {
    const client = await createClient(creds, apiVersion);
    const res = await client.get<{ blog: ShopifyBlog }>(
      `/blogs/${blogId}.json`,
    );
    return res.data.blog;
  } catch {
    return null;
  }
}

export async function fetchRecentArticles(
  creds: ShopifyCreds,
  apiVersion: string = DEFAULT_API_VERSION,
  blogId?: string,
  count: number = 5,
): Promise<ShopifyArticle[]> {
  const client = await createClient(creds, apiVersion);

  let targetBlogId = blogId;
  if (!targetBlogId) {
    const blogs = await listBlogs(creds, apiVersion);
    if (blogs.length === 0) return [];
    targetBlogId = String(blogs[0].id);
  }

  const res = await client.get<{ articles: ShopifyArticle[] }>(
    `/blogs/${targetBlogId}/articles.json`,
    { params: { limit: count, order: "published_at desc" } },
  );
  return res.data.articles;
}

/**
 * Fetch every published article on a Shopify blog. Follows the cursor-based
 * pagination in Shopify's `Link` header (max 250 per page). Caps at 50 pages
 * (12,500 articles) to avoid runaway loops on misconfigured stores.
 */
export async function fetchAllLiveArticles(
  creds: ShopifyCreds,
  apiVersion: string = DEFAULT_API_VERSION,
  blogId?: string,
): Promise<ShopifyArticle[]> {
  const client = await createClient(creds, apiVersion);

  let targetBlogId = blogId;
  if (!targetBlogId) {
    const blogs = await listBlogs(creds, apiVersion);
    if (blogs.length === 0) return [];
    targetBlogId = String(blogs[0].id);
  }

  const MAX_PAGES = 50;
  const all: ShopifyArticle[] = [];

  // First page: relative URL + query params.
  let url: string | null = `/blogs/${targetBlogId}/articles.json`;
  let params: Record<string, string | number> | undefined = {
    limit: 250,
    published_status: "published",
    order: "published_at desc",
  };

      for (let page = 0; page < MAX_PAGES && url; page++) {
    const res = await client.get<{ articles: ShopifyArticle[] }>(
      url,
      params ? { params } : undefined,
    );
    all.push(...res.data.articles);

    // Subsequent pages: Shopify returns a `Link` header with an absolute URL
    // for the next page (containing the `page_info` cursor). When we follow
    // it, the cursor encodes filters/order, so we drop our params.
    // Cast through unknown because axios's RawAxiosHeaders union includes
    // null and AxiosHeaderValue, which our string-keyed accessor can't
    // narrow. We only read two known keys ("link" / "Link") as strings.
    const headers = res.headers as unknown as Record<string, string | undefined>;
    const linkHeader = headers["link"] ?? headers["Link"];
    const nextMatch = linkHeader?.match(/<([^>]+)>;\s*rel="next"/);
    if (nextMatch) {
      url = nextMatch[1];
      params = undefined;
    } else {
      url = null;
    }
  }

  return all;
}

export interface CreateArticleOptions {
  blogId?: string;
  blogHandle?: string; // pre-cached on Blog row to skip a roundtrip
  apiVersion?: string;
}

/**
 * Publish or draft an article to a Shopify blog.
 *
 * If `input.featuredImageUrl` is set, we download the image bytes ourselves
 * (following redirects) and send them inline as `article.image.attachment`
 * (base64). This avoids Shopify having to fetch the URL — important because
 * Shopify's image fetcher does not follow redirects, and many image sources
 * (picsum.photos, DALL-E, signed S3 URLs) either redirect or expire quickly.
 *
 * Falls back to `image.src` if the byte fetch fails for any reason.
 *
 * Returns the article's canonical URL: /blogs/{blogHandle}/{articleHandle}
 */
export async function createArticle(
  creds: ShopifyCreds,
  input: PublishPostInput,
  options: CreateArticleOptions = {},
): Promise<PublishPostResult & { blogHandle?: string }> {
  const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;

  try {
    const client = await createClient(creds, apiVersion, PUBLISH_TIMEOUT_MS);

    let targetBlogId = options.blogId;
    let blogHandle = options.blogHandle;

    // Resolve missing blog id and/or handle in a single /blogs.json call
    if (!targetBlogId || !blogHandle) {
      const blogs = await listBlogs(creds, apiVersion);
      if (blogs.length === 0) {
        return {
          success: false,
          message: "No blogs exist on this Shopify store. Create one first.",
        };
      }

      const targetBlog = targetBlogId
        ? blogs.find((b) => String(b.id) === targetBlogId) ?? blogs[0]
        : blogs[0];

      targetBlogId = String(targetBlog.id);
      blogHandle = targetBlog.handle;
    }

    const published = (input.status ?? "publish") === "publish";

    // Build the image payload: prefer base64 attachment, fall back to src.
    let imagePayload: Record<string, unknown> | undefined;
    let imageMode: "attachment" | "src" | "none" = "none";

    if (input.featuredImageUrl) {
      const fetched = await fetchImageAsBase64(input.featuredImageUrl);
      if (fetched) {
        imagePayload = {
          attachment: fetched.attachment,
          filename: fetched.filename,
          alt: input.title,
        };
        imageMode = "attachment";
      } else {
        imagePayload = { src: input.featuredImageUrl, alt: input.title };
        imageMode = "src";
      }
    }

    const res = await client.post<{ article: ShopifyArticle }>(
      `/blogs/${targetBlogId}/articles.json`,
      {
        article: {
          title: input.title,
          body_html: input.content,
          summary_html: input.excerpt,
          tags: input.tags?.join(", "),
          published,
          ...(imagePayload && { image: imagePayload }),
        },
      },
    );

    const article = res.data.article;
    const storeHost = normalizeStoreUrl(creds.storeUrl);

    const imageNote =
      imageMode === "attachment"
        ? " with cover image (uploaded)"
        : imageMode === "src"
          ? " with cover image (linked)"
          : "";

    return {
      success: true,
      message: `Article "${article.title}" ${
        published ? "published" : "saved as draft"
      }${imageNote}`,
      postId: article.id,
      postUrl: `https://${storeHost}/blogs/${blogHandle}/${article.handle}`,
      blogHandle,
    };
  } catch (error) {
    return { success: false, message: formatError(error) };
  }
}
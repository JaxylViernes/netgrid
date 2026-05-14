import { z } from "zod";

const domainRegex =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

// ─── Helpers ────────────────────────────────────────────────────────────────

const isValidUrl = (s: string): boolean => {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
};

// Optional string: accepts "" / undefined / null, returns trimmed value or undefined
const optionalString = z
  .union([z.string(), z.undefined(), z.null()])
  .transform((v) => {
    if (v === undefined || v === null) return undefined;
    const trimmed = v.trim();
    return trimmed === "" ? undefined : trimmed;
  });

// Optional URL: empty allowed, but if non-empty must be a valid URL
const optionalUrl = optionalString.refine(
  (v) => v === undefined || isValidUrl(v),
  { message: "Must be a valid URL" },
);

// Optional positive integer: handles "", undefined, NaN, strings, numbers
const optionalNumber = z
  .union([z.string(), z.number(), z.undefined(), z.null()])
  .transform((v) => {
    if (v === undefined || v === null || v === "") return undefined;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
  })
  .refine(
    (v) => v === undefined || (Number.isInteger(v) && v > 0),
    { message: "Must be a positive integer" },
  );

// Posting days: array of ISO weekdays (1=Mon … 7=Sun). Accepts empty/null/undefined.
// Deduplicates and sorts ascending so the DB always sees a clean array.
const postingDays = z
  .union([z.array(z.union([z.string(), z.number()])), z.undefined(), z.null()])
  .transform((v) => {
    if (!v || v.length === 0) return undefined;
    const nums = v
      .map((x) => (typeof x === "number" ? x : Number(x)))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
    if (nums.length === 0) return undefined;
    return Array.from(new Set(nums)).sort((a, b) => a - b);
  })
  .refine(
    (v) => v === undefined || v.every((n) => n >= 1 && n <= 7),
    { message: "Days must be between 1 (Mon) and 7 (Sun)" },
  );

// ─── Create Schema ──────────────────────────────────────────────────────────

export const createBlogSchema = z
  .object({
    clientId: z.string().uuid("Invalid client ID"),
    domain: z
      .string()
      .min(1, "Domain is required")
      .regex(domainRegex, "Invalid domain format (e.g. example.com)"),

    platform: z.enum(["wordpress", "shopify"]).default("wordpress"),

    // WordPress fields
    wpUrl: optionalUrl,
    wpUsername: optionalString,
    wpAppPassword: optionalString,
    seoPlugin: z.enum(["yoast", "rankmath", "none"]).optional().default("none"),

    // Shopify fields
    shopifyAuthMode: z
      .enum(["legacy_token", "client_credentials"])
      .optional()
      .default("client_credentials"),
    shopifyStoreUrl: optionalString.refine(
      (v) =>
        v === undefined ||
        /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(v) ||
        /^https?:\/\//i.test(v),
      { message: "Use format: mystore.myshopify.com" },
    ),
    shopifyAdminApiToken: optionalString,
    shopifyClientId: optionalString,
    shopifyClientSecret: optionalString,
    shopifyApiVersion: optionalString,
    shopifyBlogId: optionalString,

    // Legacy hosting / registrar / SSL
    hostingProvider: optionalString,
    hostingLoginUrl: optionalUrl,
    hostingUsername: optionalString,
    hostingPassword: optionalString,
    registrar: optionalString,
    registrarLoginUrl: optionalUrl,
    registrarUsername: optionalString,
    registrarPassword: optionalString,

    // Posting cadence — frequency is always "weekly" now; days picks Mon–Sun.
    postingFrequency: optionalString,
    postingFrequencyDays: postingDays,

    status: z
      .enum(["active", "paused", "setup", "decommissioned"])
      .optional()
      .default("setup"),
    notesInternal: optionalString,
  })
  .superRefine((data, ctx) => {
    // Only enforce credentials when activating the blog
    if (data.status !== "active") return;

    if (data.platform === "wordpress") {
      if (!data.wpUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["wpUrl"],
          message: "WordPress URL is required to activate",
        });
      }
      if (!data.wpAppPassword) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["wpAppPassword"],
          message: "WordPress application password is required to activate",
        });
      }
    } else if (data.platform === "shopify") {
      if (!data.shopifyStoreUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["shopifyStoreUrl"],
          message: "Shopify store URL is required to activate",
        });
      }

      if (data.shopifyAuthMode === "legacy_token") {
        if (!data.shopifyAdminApiToken) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["shopifyAdminApiToken"],
            message: "Admin API token is required to activate",
          });
        }
      } else {
        if (!data.shopifyClientId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["shopifyClientId"],
            message: "Client ID is required to activate",
          });
        }
        if (!data.shopifyClientSecret) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["shopifyClientSecret"],
            message: "Client Secret is required to activate",
          });
        }
      }
    }
  });

// ─── Update Schema ──────────────────────────────────────────────────────────

export const updateBlogSchema = z.object({
  domain: z
    .string()
    .min(1, "Domain is required")
    .regex(domainRegex, "Invalid domain format (e.g. example.com)")
    .optional(),
  platform: z.enum(["wordpress", "shopify"]).optional(),

  wpUrl: optionalUrl,
  wpUsername: optionalString,
  wpAppPassword: optionalString,
  seoPlugin: z.enum(["yoast", "rankmath", "none"]).optional(),

  shopifyAuthMode: z.enum(["legacy_token", "client_credentials"]).optional(),
  shopifyStoreUrl: optionalString,
  shopifyAdminApiToken: optionalString,
  shopifyClientId: optionalString,
  shopifyClientSecret: optionalString,
  shopifyApiVersion: optionalString,
  shopifyBlogId: optionalString,

  hostingProvider: optionalString,
  hostingLoginUrl: optionalUrl,
  hostingUsername: optionalString,
  hostingPassword: optionalString,
  registrar: optionalString,
  registrarLoginUrl: optionalUrl,
  registrarUsername: optionalString,
  registrarPassword: optionalString,

  postingFrequency: optionalString,
  postingFrequencyDays: postingDays,
  status: z.enum(["active", "paused", "setup", "decommissioned"]).optional(),
  notesInternal: optionalString,
});

export type CreateBlogInput = z.infer<typeof createBlogSchema>;
export type UpdateBlogInput = z.infer<typeof updateBlogSchema>;
"use server";

import { db } from "@/lib/db";
import {
  reports,
  clients,
  blogs,
  seoIssues,
  seoScans,
  postVerifications,
  generatedPosts,
} from "@/lib/db/schema";
import { eq, and, desc, sql, gte, lte, lt } from "drizzle-orm";
import { requireAdmin, getClientScope, getSession } from "@/lib/auth/helpers";
import { generateMonthlyReport } from "@/lib/services/claude-client";
import { logActivity } from "@/lib/services/activity-logger";

export async function getReports(params?: {
  clientId?: string;
  page?: number;
  pageSize?: number;
}) {
  const { clientId, page = 1, pageSize = 25 } = params || {};

  const conditions = [];
  const clientScope = await getClientScope();

  if (clientScope) {
    conditions.push(eq(reports.clientId, clientScope));
    conditions.push(eq(reports.visibleToClient, true));
  } else if (clientId) {
    conditions.push(eq(reports.clientId, clientId));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [result, [{ total }]] = await Promise.all([
    db.select({
      report: reports,
      clientName: clients.name,
    })
      .from(reports)
      .innerJoin(clients, eq(reports.clientId, clients.id))
      .where(where)
      .orderBy(desc(reports.generatedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` })
      .from(reports)
      .where(where),
  ]);

  return { reports: result, total, page, pageSize };
}

export async function getReport(id: string) {
  const [report] = await db.select({
    report: reports,
    clientName: clients.name,
  })
    .from(reports)
    .innerJoin(clients, eq(reports.clientId, clients.id))
    .where(eq(reports.id, id))
    .limit(1);

  return report || null;
}

async function generateReportInternal(
  clientId: string,
  periodStart: string,
  periodEnd: string,
  actorUserId?: string,
) {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) throw new Error("Client not found");

  const startDate = new Date(periodStart);
  const endDate = new Date(periodEnd);

  const [blogCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(blogs)
    .where(and(eq(blogs.clientId, clientId), eq(blogs.status, "active")));

  const [avgScore] = await db
    .select({ avg: sql<number>`coalesce(avg(${blogs.currentSeoScore}), 0)::int` })
    .from(blogs)
    .where(and(eq(blogs.clientId, clientId), eq(blogs.status, "active")));

  const [issuesFixed] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(seoIssues)
    .where(
      and(
        eq(seoIssues.clientId, clientId),
        eq(seoIssues.status, "verified"),
        gte(seoIssues.resolvedAt, startDate),
        lte(seoIssues.resolvedAt, endDate),
      ),
    );

  const [criticalRemaining] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(seoIssues)
    .where(
      and(
        eq(seoIssues.clientId, clientId),
        eq(seoIssues.severity, "critical"),
        sql`${seoIssues.status} NOT IN ('verified', 'dismissed')`,
      ),
    );

  const [onScheduleBlogs] = await db
    .select({ count: sql<number>`count(DISTINCT ${postVerifications.blogId})::int` })
    .from(postVerifications)
    .where(
      and(
        eq(postVerifications.clientId, clientId),
        eq(postVerifications.onSchedule, true),
        gte(postVerifications.checkedAt, startDate),
      ),
    );

  const currentScore = avgScore?.avg || 0;

  // Real previous-period avg from seo_scans (not a fake currentScore-5).
  // Period length matches the report's window so YoY/MoM comparisons line up.
  const periodMs = endDate.getTime() - startDate.getTime();
  const prevStart = new Date(startDate.getTime() - periodMs - 24 * 60 * 60 * 1000);
  const prevEnd = new Date(startDate.getTime() - 24 * 60 * 60 * 1000);
  const [prevAvg] = await db
    .select({ avg: sql<number | null>`avg(${seoScans.overallScore})::int` })
    .from(seoScans)
    .where(
      and(
        eq(seoScans.clientId, clientId),
        gte(seoScans.scannedAt, prevStart),
        lt(seoScans.scannedAt, prevEnd),
      ),
    );
  const prevScore = prevAvg?.avg ?? currentScore; // first-ever report → no prior data
  const delta = currentScore - prevScore;
  const trend: "improving" | "stable" | "declining" =
    delta >= 3 ? "improving" : delta <= -3 ? "declining" : "stable";

  // Real posts-published count for the period (was hardcoded to 0).
  const [postsPublished] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.clientId, clientId),
        eq(generatedPosts.status, "published"),
        gte(generatedPosts.publishedAt, startDate),
        lte(generatedPosts.publishedAt, endDate),
      ),
    );
  const totalPosts = postsPublished?.count ?? 0;

  const summaryHtml = await generateMonthlyReport({
    clientName: client.name,
    clientNiche: client.niche || "general",
    periodStart,
    periodEnd,
    totalBlogs: blogCount?.count || 0,
    avgScore: currentScore,
    prevAvgScore: prevScore,
    trendDirection: trend,
    totalPosts,
    onSchedule: onScheduleBlogs?.count || 0,
    issuesFixed: issuesFixed?.count || 0,
    criticalRemaining: criticalRemaining?.count || 0,
  });

  const title = `${new Date(periodStart).toLocaleString("default", {
    month: "long",
    year: "numeric",
  })} Network Performance Report`;

  const [report] = await db
    .insert(reports)
    .values({
      clientId,
      periodStart,
      periodEnd,
      title,
      summaryHtml,
      overallSeoTrend: trend,
      avgSeoScore: currentScore,
      totalPostsPublished: totalPosts,
      totalIssuesFixed: issuesFixed?.count || 0,
      blogsOnSchedule: onScheduleBlogs?.count || 0,
      blogsOffSchedule: (blogCount?.count || 0) - (onScheduleBlogs?.count || 0),
      visibleToClient: false,
    })
    .returning();

  await logActivity({
    userId: actorUserId,
    clientId,
    action: "report_generated",
    entityType: "report",
    entityId: report.id,
  });

  return report;
}

export async function triggerMonthlyReportsManual(
  options: { period?: "last_month" | "last_30_days" | "month_to_date" } = {},
): Promise<{
  considered: number;
  generated: number;
  failed: number;
  period: { start: string; end: string };
  results: Array<{
    clientId: string;
    clientName: string;
    status: "generated" | "failed";
    message: string;
  }>;
}> {
  await requireAdmin();

  const eligibleClients = await db
    .select()
    .from(clients)
    .where(sql`${clients.status} IN ('active', 'onboarding')`);

  // Period selection — admin can pick whichever window is useful right now.
  // Cron stays on last_month; manual usually wants last_30_days while testing.
  const periodKind = options.period ?? "last_30_days";
  const now = new Date();
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const utcDay = now.getUTCDate();

  let periodStart: Date;
  let periodEnd: Date;
  if (periodKind === "last_month") {
    periodEnd = new Date(Date.UTC(utcYear, utcMonth, 0));
    periodStart = new Date(Date.UTC(utcYear, utcMonth - 1, 1));
  } else if (periodKind === "month_to_date") {
    periodStart = new Date(Date.UTC(utcYear, utcMonth, 1));
    periodEnd = new Date(Date.UTC(utcYear, utcMonth, utcDay));
  } else {
    // last_30_days — rolling window ending today
    periodEnd = new Date(Date.UTC(utcYear, utcMonth, utcDay));
    periodStart = new Date(periodEnd.getTime() - 29 * 24 * 60 * 60 * 1000);
  }

  const startStr = periodStart.toISOString().split("T")[0];
  const endStr = periodEnd.toISOString().split("T")[0];

  let generated = 0;
  let failed = 0;
  const results: Array<{
    clientId: string;
    clientName: string;
    status: "generated" | "failed";
    message: string;
  }> = [];

  for (const client of eligibleClients) {
    try {
      await generateReportForCron(client.id, startStr, endStr);
      generated++;
      results.push({
        clientId: client.id,
        clientName: client.name,
        status: "generated",
        message: `Report for ${startStr} → ${endStr} generated`,
      });
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : "Unknown error";
      results.push({
        clientId: client.id,
        clientName: client.name,
        status: "failed",
        message,
      });
    }
  }

  return {
    considered: eligibleClients.length,
    generated,
    failed,
    period: { start: startStr, end: endStr },
    results,
  };
}

/**
 * Admin-callable: generate a monthly report for one client. Requires an admin
 * session — redirects to /login otherwise. For cron / system-triggered runs
 * use `generateReportForCron()` below.
 */
export async function generateReport(
  clientId: string,
  periodStart: string,
  periodEnd: string,
) {
  const session = await requireAdmin();
  return generateReportInternal(clientId, periodStart, periodEnd, session.user.id);
}

export async function unpublishReport(reportId: string) {
  await requireAdmin();
  await db.update(reports).set({
    visibleToClient: false,
    publishedAt: null,
  }).where(eq(reports.id, reportId));
}
/**
 * Cron-callable variant: skips the NextAuth session check. Only call this
 * from a route that has already verified `CRON_SECRET` itself.
 */
export async function generateReportForCron(
  clientId: string,
  periodStart: string,
  periodEnd: string,
) {
  return generateReportInternal(clientId, periodStart, periodEnd);
}

export async function publishReport(reportId: string) {
  const session = await requireAdmin();

  await db.update(reports).set({
    visibleToClient: true,
    publishedAt: new Date(),
  }).where(eq(reports.id, reportId));

  await logActivity({
    userId: session.user.id,
    action: "report_published",
    entityType: "report",
    entityId: reportId,
  });
}

export async function updateReportContent(reportId: string, summaryHtml: string) {
  await requireAdmin();

  await db.update(reports).set({ summaryHtml }).where(eq(reports.id, reportId));
}

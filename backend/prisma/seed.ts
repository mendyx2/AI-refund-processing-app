/**
 * Seeds ~15 customers with order histories that exercise every rule in
 * data/refund_policy.md. Dates are relative to the moment the seed runs so the
 * scenarios (recent vs. >60 days old, suspicious bursts) stay valid over time.
 * The script clears existing rows first, so it is safe to re-run.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import { PrismaClient } from "../src/generated/prisma/client";
import { customers } from "./seedData";

const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL ?? "file:./db/app.db" });
const prisma = new PrismaClient({ adapter });

const NOW = new Date();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
const dollars = (amount: number) => Math.round(amount * 100);

async function main() {
  await prisma.refundRequest.deleteMany();
  await prisma.order.deleteMany();
  await prisma.customer.deleteMany();

  let orderSeq = 10001;
  let orderCount = 0;
  let refundCount = 0;

  for (const c of customers) {
    const customer = await prisma.customer.create({
      data: { name: c.name, email: c.email, createdAt: daysAgo(c.joinedDaysAgo) },
    });

    for (const o of c.orders) {
      const totalCents = dollars(o.total);
      await prisma.order.create({
        data: {
          orderNumber: `ORD-${orderSeq++}`,
          customerId: customer.id,
          productName: o.product,
          category: o.category,
          totalCents,
          isFinalSale: o.finalSale ?? false,
          status: o.status,
          orderedAt: daysAgo(o.orderedDaysAgo),
          deliveredAt: o.deliveredDaysAgo === undefined ? null : daysAgo(o.deliveredDaysAgo),
          refundRequests: {
            create: (o.refunds ?? []).map((r) => ({
              customerId: customer.id,
              reason: r.reason,
              description: r.description,
              amountCents: r.amount === undefined ? totalCents : dollars(r.amount),
              status: r.status,
              requestedAt: daysAgo(r.requestedDaysAgo),
              resolvedAt: r.resolvedDaysAgo === undefined ? null : daysAgo(r.resolvedDaysAgo),
              decisionNotes: r.decisionNotes ?? null,
            })),
          },
        },
      });
      orderCount++;
      refundCount += o.refunds?.length ?? 0;
    }
  }

  console.log(
    `Seeded ${customers.length} customers, ${orderCount} orders, ${refundCount} refund requests.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

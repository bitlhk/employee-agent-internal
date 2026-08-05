import { and, eq } from "drizzle-orm";
import { channelIdentityLinks, users } from "../../drizzle/schema";
import { getDb } from "./connection";

export type TrustedChannelIdentity = {
  provider: "linggan";
  subject: string;
  name: string;
  verifiedEmail?: string | null;
  verifiedPhone?: string | null;
};

export async function resolveTrustedChannelUser(identity: TrustedChannelIdentity) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const now = new Date();

  const existing = (await db
    .select({ user: users })
    .from(channelIdentityLinks)
    .innerJoin(users, eq(channelIdentityLinks.userId, users.id))
    .where(and(
      eq(channelIdentityLinks.provider, identity.provider),
      eq(channelIdentityLinks.providerSubject, identity.subject)
    ))
    .limit(1))[0]?.user;
  if (existing) {
    await db.update(channelIdentityLinks).set({
      verifiedEmail: identity.verifiedEmail?.trim().toLowerCase() || null,
      verifiedPhone: identity.verifiedPhone?.trim() || null,
      lastSeenAt: now,
    }).where(and(
      eq(channelIdentityLinks.provider, identity.provider),
      eq(channelIdentityLinks.providerSubject, identity.subject)
    ));
    await db.update(users).set({
      name: identity.name.trim() || existing.name,
      email: existing.email || identity.verifiedEmail?.trim().toLowerCase() || null,
      lastSignedIn: now,
    }).where(eq(users.id, existing.id));
    return (await db.select().from(users).where(eq(users.id, existing.id)).limit(1))[0] || existing;
  }

  try {
    return await db.transaction(async tx => {
      const raced = (await tx
        .select({ user: users })
        .from(channelIdentityLinks)
        .innerJoin(users, eq(channelIdentityLinks.userId, users.id))
        .where(and(
          eq(channelIdentityLinks.provider, identity.provider),
          eq(channelIdentityLinks.providerSubject, identity.subject)
        ))
        .limit(1))[0]?.user;
      if (raced) return raced;

      const email = identity.verifiedEmail?.trim().toLowerCase() || null;
      let user = email
        ? (await tx.select().from(users).where(eq(users.email, email)).limit(1))[0]
        : undefined;
      if (!user) {
        const openId = `linggan-${identity.subject.slice(0, 48)}`;
        user = (await tx.select().from(users).where(eq(users.openId, openId)).limit(1))[0];
        if (!user) {
          const inserted = await tx.insert(users).values({
            openId,
            name: identity.name.trim(),
            email,
            loginMethod: "linggan_channel",
            role: "user",
            accessLevel: "public_only",
            lastSignedIn: now,
          });
          user = (await tx.select().from(users).where(eq(users.id, inserted[0].insertId)).limit(1))[0];
        }
      }
      if (!user) throw new Error("Failed to resolve EA channel user");
      await tx.insert(channelIdentityLinks).values({
        provider: identity.provider,
        providerSubject: identity.subject,
        userId: user.id,
        verifiedEmail: email,
        verifiedPhone: identity.verifiedPhone?.trim() || null,
        lastSeenAt: now,
      });
      return user;
    });
  } catch (error) {
    const raced = (await db
      .select({ user: users })
      .from(channelIdentityLinks)
      .innerJoin(users, eq(channelIdentityLinks.userId, users.id))
      .where(and(
        eq(channelIdentityLinks.provider, identity.provider),
        eq(channelIdentityLinks.providerSubject, identity.subject)
      ))
      .limit(1))[0]?.user;
    if (raced) return raced;
    throw error;
  }
}

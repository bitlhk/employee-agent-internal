import { and, eq, ne, sql } from "drizzle-orm";
import {
  channelBindings,
  type ChannelBinding,
  type InsertChannelBinding,
} from "../../drizzle/schema";
import { getDb } from "./connection";

let ensurePromise: Promise<void> | null = null;

async function ensureChannelBindingsTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS channel_bindings (
          id int NOT NULL AUTO_INCREMENT,
          channel varchar(32) NOT NULL,
          adopt_id varchar(64) NOT NULL,
          user_id int NOT NULL,
          external_user_id varchar(128) NOT NULL,
          external_chat_id varchar(128) DEFAULT NULL,
          external_channel_id varchar(64) DEFAULT NULL,
          source_message_id varchar(128) DEFAULT NULL,
          status enum('active','disabled') NOT NULL DEFAULT 'active',
          metadata_json text DEFAULT NULL,
          bound_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
          created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uk_channel_bindings_adopt (channel, adopt_id),
          UNIQUE KEY uk_channel_bindings_external (channel, external_user_id),
          KEY idx_channel_bindings_adopt (adopt_id),
          KEY idx_channel_bindings_external (external_user_id),
          KEY idx_channel_bindings_channel_status (channel, status)
        )
      `);
    })().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  await ensurePromise;
}

export type UpsertChannelBindingInput = {
  channel: string;
  adoptId: string;
  userId: number;
  externalUserId: string;
  externalChatId?: string | null;
  externalChannelId?: string | null;
  sourceMessageId?: string | null;
  metadataJson?: string | null;
  boundAt?: Date;
};

function normalizeStatus(binding: ChannelBinding | undefined): ChannelBinding | null {
  if (!binding || binding.status !== "active") return null;
  return binding;
}

export async function getChannelBindingByAdopt(channel: string, adoptId: string): Promise<ChannelBinding | null> {
  await ensureChannelBindingsTable();
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db
    .select()
    .from(channelBindings)
    .where(and(eq(channelBindings.channel, channel), eq(channelBindings.adoptId, adoptId)))
    .limit(1);
  return normalizeStatus(rows[0]);
}

export async function getChannelBindingByExternalUser(channel: string, externalUserId: string): Promise<ChannelBinding | null> {
  await ensureChannelBindingsTable();
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db
    .select()
    .from(channelBindings)
    .where(and(eq(channelBindings.channel, channel), eq(channelBindings.externalUserId, externalUserId)))
    .limit(1);
  return normalizeStatus(rows[0]);
}

export async function listChannelBindings(channel: string): Promise<ChannelBinding[]> {
  await ensureChannelBindingsTable();
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db
    .select()
    .from(channelBindings)
    .where(and(eq(channelBindings.channel, channel), eq(channelBindings.status, "active")));
}

export async function upsertChannelBinding(input: UpsertChannelBindingInput): Promise<void> {
  await ensureChannelBindingsTable();
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  const channel = input.channel.trim();
  const adoptId = input.adoptId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!channel || !adoptId || !externalUserId) throw new Error("channel binding requires channel, adoptId and externalUserId");

  // Keep one route per external user and one external user per adopted agent.
  await db.delete(channelBindings).where(
    and(
      eq(channelBindings.channel, channel),
      eq(channelBindings.externalUserId, externalUserId),
      ne(channelBindings.adoptId, adoptId),
    ),
  );
  await db.delete(channelBindings).where(
    and(
      eq(channelBindings.channel, channel),
      eq(channelBindings.adoptId, adoptId),
      ne(channelBindings.externalUserId, externalUserId),
    ),
  );

  const values: InsertChannelBinding = {
    channel,
    adoptId,
    userId: Number(input.userId || 0),
    externalUserId,
    externalChatId: input.externalChatId || null,
    externalChannelId: input.externalChannelId || null,
    sourceMessageId: input.sourceMessageId || null,
    status: "active",
    metadataJson: input.metadataJson || null,
    boundAt: input.boundAt || new Date(),
  };

  await db.insert(channelBindings).values(values).onDuplicateKeyUpdate({
    set: {
      userId: values.userId,
      externalUserId: values.externalUserId,
      externalChatId: values.externalChatId,
      externalChannelId: values.externalChannelId,
      sourceMessageId: values.sourceMessageId,
      status: "active",
      metadataJson: values.metadataJson,
      boundAt: values.boundAt,
    },
  });
}

export async function removeChannelBindingByAdopt(channel: string, adoptId: string): Promise<void> {
  await ensureChannelBindingsTable();
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(channelBindings).where(and(eq(channelBindings.channel, channel), eq(channelBindings.adoptId, adoptId)));
}

export async function removeChannelBindingsForExternalUser(channel: string, externalUserId: string, exceptAdoptId?: string): Promise<void> {
  await ensureChannelBindingsTable();
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const conditions = [
    eq(channelBindings.channel, channel),
    eq(channelBindings.externalUserId, externalUserId),
  ];
  if (exceptAdoptId) conditions.push(ne(channelBindings.adoptId, exceptAdoptId));
  await db.delete(channelBindings).where(and(...conditions));
}

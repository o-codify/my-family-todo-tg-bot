import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '../db/client';
import {
  templates,
  type NewTemplateRow,
  type TemplatePayload,
  type TemplateRow,
} from '../db/schema';

export async function listTemplates(familyId: string): Promise<TemplateRow[]> {
  // System templates (familyId = null) + family templates
  return db
    .select()
    .from(templates)
    .where(or(eq(templates.familyId, familyId), isNull(templates.familyId)));
}

export async function createTemplate(input: {
  familyId: string;
  createdBy: string;
  data: { name: string; emoji?: string | null; payload: TemplatePayload };
}): Promise<TemplateRow> {
  const row: NewTemplateRow = {
    familyId: input.familyId,
    createdBy: input.createdBy,
    name: input.data.name.trim(),
    emoji: input.data.emoji ?? null,
    payload: input.data.payload,
    isSystem: false,
  };
  const [created] = await db.insert(templates).values(row).returning();
  return created!;
}

export async function deleteTemplate(input: {
  templateId: string;
  familyId: string;
}): Promise<boolean> {
  const result = await db
    .delete(templates)
    .where(
      and(
        eq(templates.id, input.templateId),
        eq(templates.familyId, input.familyId),
        eq(templates.isSystem, false),
      ),
    )
    .returning({ id: templates.id });
  return result.length > 0;
}

export function serializeTemplate(row: TemplateRow) {
  return {
    id: row.id,
    familyId: row.familyId,
    name: row.name,
    emoji: row.emoji,
    payload: row.payload,
    isSystem: row.isSystem,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

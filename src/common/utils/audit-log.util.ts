import { Prisma, type PrismaClient } from '@prisma/client';

export type PrismaDbClient = PrismaClient | Prisma.TransactionClient;

export interface RecordAuditLogInput {
  actorId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  oldData?: Prisma.InputJsonValue | null;
  newData?: Prisma.InputJsonValue | null;
}

/**
 * Ghi nhận Audit Log bất biến (BR-23).
 * Nhận được cả PrismaClient lẫn Prisma.TransactionClient để đảm bảo ghi nguyên tử cùng giao dịch nghiệp vụ.
 */
export async function recordAuditLog(db: PrismaDbClient, input: RecordAuditLogInput) {
  return db.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      oldData:
        input.oldData === undefined
          ? undefined
          : input.oldData === null
            ? Prisma.JsonNull
            : input.oldData,
      newData:
        input.newData === undefined
          ? undefined
          : input.newData === null
            ? Prisma.JsonNull
            : input.newData,
    },
  });
}

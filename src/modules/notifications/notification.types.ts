import type { Prisma } from '@prisma/client';

import type { NotificationCategory } from '../../common/constants/phase3-status';

export interface NotificationRecord {
  id: string;
  recipientId: string;
  title: string;
  eventType: string;
  payload: Prisma.JsonValue | null;
  isRead: boolean;
  createdAt: Date;
}

export interface NotificationListQuery {
  page: number;
  limit: number;
  isRead?: boolean;
  category?: NotificationCategory;
  eventType?: string;
}

export interface NotificationItemDTO {
  id: string;
  eventType: string;
  category: NotificationCategory;
  title: string;
  content: string | null;
  actionUrl: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  payload: Record<string, unknown> | null;
  isRead: boolean;
  createdAt: string;
}

export interface PaginatedNotificationsDTO {
  items: NotificationItemDTO[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  unreadCount: number;
}

export interface UnreadCountDTO {
  unreadCount: number;
}

export type NotificationActionResponseDTO = NotificationItemDTO & {
  unreadCount: number;
};

export interface MarkAllNotificationsReadDTO {
  updatedCount: number;
  unreadCount: number;
}

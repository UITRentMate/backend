export interface UploadStreamOptions {
  publicId: string;
  folder?: string;
  transformation?: Record<string, any>;
}

export interface UploadResult {
  secureUrl: string;
  publicId: string;
}

export interface BatchUploadItem {
  index: number;
  originalName: string;
  size: number;
}

export interface BatchUploadSuccessItem extends BatchUploadItem {
  id: string;
  url: string;
  publicId: string;
  sortOrder: number;
}

export interface BatchUploadFailureItem extends BatchUploadItem {
  code: string;
  message: string;
}

export interface BatchUploadResponse {
  success: boolean;
  summary: {
    totalRequested: number;
    succeeded: number;
    failed: number;
    remainingSlots: number;
  };
  uploaded: BatchUploadSuccessItem[];
  failed: BatchUploadFailureItem[];
}

export interface ApiErrorResponse {
  success: false;
  code: string;
  message: string;
  errors?: Record<string, string[]>;
  traceId: string;
}

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly errors?: Record<string, string[]>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    errors?: Record<string, string[]>
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.errors = errors;

    // Duy trì prototype chain chính xác khi kế thừa Error trong TypeScript
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

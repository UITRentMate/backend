export interface UserProfileRecord {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  role: string;
  accountStatus: string;
  avatarUrl?: string | null;
  dateOfBirth?: Date | string | null;
  address?: string | null;
}

export interface UserProfileDTO {
  userId: string;
  fullName: string;
  email: string;
  phone: string;
  role: string;
  status: string;
  avatarUrl: string | null;
  dateOfBirth: string | null;
  address: string | null;
}

export interface UpdateUserProfileInput {
  fullName?: string;
  phone?: string;
  dateOfBirth?: Date | null;
  address?: string | null;
}

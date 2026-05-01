export type UserRole = "admin" | "instructor";

export type InstructorStatus = "pending" | "approved" | "rejected" | "revoked";

export interface InstructorProfile {
  email: string;
  name: string;
  institution: string;
  country: string;
  role: UserRole;
  status: InstructorStatus;
  emailVerified?: boolean;
  createdAt?: unknown;
  reviewedAt?: unknown;
  reviewedBy?: string | null;
  sessionsCreatedCount?: number;
  playersJoinedCount?: number;
}

export interface PlayerPresenceState {
  isOnline: boolean;
  lastHeartbeatAtMs: number | null;
  inactiveSeconds: number | null;
}

export interface TeamDecisionProgress {
  decidedCount: number;
  totalCount: number;
  isLastUndecidedHuman: boolean;
}

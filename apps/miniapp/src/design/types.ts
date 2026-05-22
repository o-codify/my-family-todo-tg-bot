/**
 * Type definitions mirroring the Claude Design wireframe (wireframe-kit.jsx).
 * MEMBERS in the prototype was a hardcoded array; in the live app these come
 * from the API (/api/v1/families/:id/members).
 */
export type Member = {
  id: string;
  name: string;
  letter: string;
  color: string;
  role: 'Owner' | 'Adult' | 'Child' | string;
  awayUntil?: string | null;
  awayReason?: 'vacation' | 'sick' | null;
};

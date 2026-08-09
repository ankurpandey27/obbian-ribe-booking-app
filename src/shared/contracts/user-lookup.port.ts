import { User } from '../../modules/users/entities/user.entity';
import { UserRoleValue } from '../types/common';

/** DI token — interfaces can't be injected by type, so bind this token. */
export const USER_LOOKUP = Symbol('USER_LOOKUP');

/**
 * Cross-module contract: auth needs to find/create users by phone.
 * Users module implements this (UserLookupService). Auth never
 * touches the users table directly — this interface is the boundary.
 */
export interface UserLookupPort {
  findByPhone(phone: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  createUser(phone: string, role?: UserRoleValue): Promise<User>;
  updateRole(userId: string, role: UserRoleValue): Promise<void>;
}

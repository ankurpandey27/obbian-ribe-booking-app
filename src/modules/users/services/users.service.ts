import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../../common/database/drizzle.module';
import { savedLocations, users } from '../../../common/database/schema';
import { User } from '../entities/user.entity';
import { SavedLocationDto } from '../dto/users.dto';

/** Saved-location rows (legacy entity carried a never-populated relation). */
type SavedLocationRow = typeof savedLocations.$inferSelect;
import { UserRoleValue } from '../../../shared/types/common';

/**
 * UsersService — user profile + saved-location CRUD via Drizzle.
 * Implements the UserLookupPort contract for the auth module.
 *
 * Type note: rows are structurally identical to the legacy `User` /
 * `SavedLocation` entity classes; those remain the public contract until
 * every consuming module is migrated (ADR-002 wave plan).
 */
@Injectable()
export class UsersService /* implements UserLookupPort — see ADR-002 */ {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDB) {}

  async findByPhone(phone: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.phoneNumber, phone))
      .limit(1);
    return row ?? null;
  }

  async findById(id: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return row ?? null;
  }

  async createUser(
    phone: string,
    role: UserRoleValue = 'RIDER',
  ): Promise<User> {
    const [row] = await this.db
      .insert(users)
      .values({ phoneNumber: phone, role })
      .returning();
    return row;
  }

  async findOrCreate(
    phone: string,
    role: UserRoleValue = 'RIDER',
  ): Promise<User> {
    const existing = await this.findByPhone(phone);
    if (existing) return existing;
    return this.createUser(phone, role);
  }

  async updateProfile(
    userId: string,
    data: {
      firstName?: string;
      lastName?: string;
      email?: string;
      profileImageUrl?: string;
    },
  ): Promise<User | null> {
    await this.db
      .update(users)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(users.id, userId));
    return this.findById(userId);
  }

  async updateRole(userId: string, role: UserRoleValue): Promise<void> {
    await this.db
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  async markLogin(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, userId));
  }

  // ------------------------- saved locations -------------------------

  async listSavedLocations(userId: string): Promise<SavedLocationRow[]> {
    return this.db
      .select()
      .from(savedLocations)
      .where(eq(savedLocations.userId, userId))
      .orderBy(savedLocations.createdAt);
  }

  async saveLocation(
    userId: string,
    dto: SavedLocationDto,
  ): Promise<SavedLocationRow> {
    const [row] = await this.db
      .insert(savedLocations)
      .values({ ...dto, userId })
      .returning();
    return row;
  }
}

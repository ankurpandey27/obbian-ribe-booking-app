import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { UserLookupPort } from '../../../shared/contracts/user-lookup.port';
import { UserRoleValue } from '../../../shared/types/common';

/**
 * Implements the UserLookupPort contract for the auth module.
 * Also owns user profile CRUD for the users module API.
 */
@Injectable()
export class UsersService implements UserLookupPort {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {}

  async findByPhone(phone: string): Promise<User | null> {
    return this.userRepo.findOneBy({ phoneNumber: phone });
  }

  async findById(id: string): Promise<User | null> {
    return this.userRepo.findOneBy({ id });
  }

  async createUser(
    phone: string,
    role: UserRoleValue = 'RIDER',
  ): Promise<User> {
    const user = this.userRepo.create({ phoneNumber: phone, role });
    return this.userRepo.save(user);
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
    await this.userRepo.update(userId, data);
    return this.findById(userId);
  }

  async updateRole(userId: string, role: UserRoleValue): Promise<void> {
    await this.userRepo.update(userId, { role });
  }

  async markLogin(userId: string): Promise<void> {
    await this.userRepo.update(userId, { lastLoginAt: new Date() });
  }
}

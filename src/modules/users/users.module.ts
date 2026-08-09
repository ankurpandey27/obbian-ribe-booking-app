import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersController } from './controllers/users.controller';
import { UsersService } from './services/users.service';
import { User } from './entities/user.entity';
import { SavedLocation } from './entities/saved-location.entity';
import { USER_LOOKUP } from '../../shared/contracts/user-lookup.port';

@Module({
  imports: [TypeOrmModule.forFeature([User, SavedLocation])],
  controllers: [UsersController],
  providers: [
    UsersService,
    { provide: USER_LOOKUP, useExisting: UsersService },
  ],
  exports: [UsersService, USER_LOOKUP],
})
export class UsersModule {}

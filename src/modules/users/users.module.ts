import { Module } from '@nestjs/common';
import { UsersController } from './controllers/users.controller';
import { UsersService } from './services/users.service';
import { USER_LOOKUP } from '../../shared/contracts/user-lookup.port';

@Module({
  controllers: [UsersController],
  providers: [
    UsersService,
    { provide: USER_LOOKUP, useExisting: UsersService },
  ],
  exports: [UsersService, USER_LOOKUP],
})
export class UsersModule {}

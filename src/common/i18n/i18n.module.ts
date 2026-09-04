import { Module } from '@nestjs/common';
import { MessageService } from './message.service';
import { I18nAdminController } from './i18n.controller';

/**
 * I18n module — backend-managed message catalog + locale resolution.
 * All user-facing copy is localizable; the future CMS calls the same admin
 * endpoints.
 */
@Module({
  controllers: [I18nAdminController],
  providers: [MessageService],
  exports: [MessageService],
})
export class I18nModule {}

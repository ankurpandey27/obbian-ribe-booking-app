import { users } from '../../../common/database/schema';

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

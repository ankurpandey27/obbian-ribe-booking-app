import { promos } from '../../../common/database/schema';

export type Promo = typeof promos.$inferSelect;
export type NewPromo = typeof promos.$inferInsert;
